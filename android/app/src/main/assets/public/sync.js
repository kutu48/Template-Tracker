/*
 * CNC Template Tracker — Outbox Queue & Delta Sync Engine (Offline-First)
 * Transport: HTTP POST Content-Type: text/plain;charset=utf-8 (token di body JSON, respons terbaca penuh).
 * Tanpa OpenSheet, tanpa JSONP, tanpa POST no-cors.
 * Skrip klasik (tanpa type="module"), jalan di file:// (PC) dan Capacitor (Android).
 */
(function (global) {
  'use strict';

  var syncInFlight = null;
  var syncTimer = null;
  var listeners = [];
  var state = {
    online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
    syncing: false,
    pendingCount: 0,
    errorCount: 0,
    lastSyncAt: '',
    lastError: '',
    authExpired: false
  };

  function emitState() {
    var snap = Object.assign({}, state);
    listeners.forEach(function (fn) {
      try { fn(snap); } catch (e) {}
    });
  }

  function subscribe(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    emitState();
    return function () {
      listeners = listeners.filter(function (x) { return x !== fn; });
    };
  }

  function isOnline() {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  }

  function validateApiUrl(url) {
    var v = String(url || '').trim().replace(/\/+$/, '');
    if (!v) throw new Error('URL Web App Apps Script belum diatur. Buka Pengaturan Server.');
    if (!/^https?:\/\//i.test(v)) throw new Error('URL Apps Script harus diawali https://.');
    if (v.indexOf('script.google.com') >= 0 && v.slice(-5) !== '/exec') {
      throw new Error('URL Apps Script harus URL Web App lengkap yang berakhiran /exec.');
    }
    return v;
  }

  function postApi(action, payload, opts) {
    opts = opts || {};
    return Promise.all([
      global.CNCDB.getEffectiveConfig(),
      opts.skipAuth ? Promise.resolve(null) : global.CNCDB.loadSession()
    ]).then(function (pair) {
      var cfg = pair[0];
      var sess = pair[1];
      var apiUrl = validateApiUrl(opts.apiUrl || cfg.apiUrl);
      var token = opts.token !== undefined ? opts.token : (sess ? (sess.token || sess.sessionToken || '') : '');
      var body = JSON.stringify({
        action: String(action),
        token: token,
        payload: payload || {}
      });

      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timeoutMs = opts.timeoutMs || 30000;
      var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;

      return fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: body,
        cache: 'no-store',
        redirect: 'follow',
        signal: controller ? controller.signal : undefined
      }).then(function (res) {
        if (timer) clearTimeout(timer);
        return res.text().then(function (text) {
          if (res.status === 404) {
            throw new Error('HTTP 404: URL Web App Apps Script salah/terpotong. Cek Pengaturan Server.');
          }
          var data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            var preview = String(text || '').slice(0, 260).replace(/\s+/g, ' ').trim();
            var isHtml = /^<!doctype html|^<html|<title>|accounts\.google\.com|ServiceLogin/i.test(preview);
            throw new Error(isHtml
              ? 'Server mengembalikan HTML, bukan JSON. Pastikan Deploy Apps Script > Web app > Execute as Me & Who has access: Anyone.'
              : ('Respons server bukan JSON (HTTP ' + res.status + '): ' + (preview || '(kosong)')));
          }
          if (data.authError) {
            state.authExpired = true;
            state.lastError = data.message || 'Sesi kedaluwarsa';
            emitState();
            var authErr = new Error(data.message || 'Sesi kedaluwarsa. Silakan login ulang.');
            authErr.authError = true;
            throw authErr;
          }
          if (!data.ok) {
            var err = new Error(data.message || ('Request gagal: ' + action));
            err.retryable = data.retryable === true;
            err.duplicate = !!data.duplicate;
            err.response = data;
            throw err;
          }
          state.authExpired = false;
          return data;
        });
      }, function (netErr) {
        if (timer) clearTimeout(timer);
        var e = new Error(netErr && netErr.name === 'AbortError' ? 'Timeout koneksi ke server Apps Script.' : ('Gagal menghubungi server: ' + (netErr && netErr.message ? netErr.message : netErr)));
        e.networkError = true;
        e.retryable = true;
        throw e;
      });
    });
  }

  function refreshOutboxCounters() {
    return Promise.all([
      global.CNCDB.getOutbox(),
      global.CNCDB.getMeta('lastSyncAt', '')
    ]).then(function (res) {
      var ops = res[0] || [];
      var lastSyncAt = res[1] || '';
      state.online = isOnline();
      state.pendingCount = ops.filter(function (o) { return o.status !== 'error'; }).length;
      state.errorCount = ops.filter(function (o) { return o.status === 'error'; }).length;
      state.lastSyncAt = lastSyncAt;
      emitState();
      return { ops: ops, pendingCount: state.pendingCount, errorCount: state.errorCount, lastSyncAt: lastSyncAt };
    });
  }

  function applyOpResultLocally(res) {
    var tasks = [];
    if (res.template && res.template.id) {
      tasks.push(global.CNCDB.getOne('templates', res.template.id).then(function (cur) {
        return global.CNCDB.putOne('templates', Object.assign({}, cur || {}, res.template));
      }));
    }
    if (Array.isArray(res.templates) && res.templates.length) {
      res.templates.forEach(function (tpl) {
        if (!tpl || !tpl.id) return;
        tasks.push(global.CNCDB.getOne('templates', tpl.id).then(function (cur) {
          return global.CNCDB.putOne('templates', Object.assign({}, cur || {}, tpl));
        }));
      });
    }
    if (res.partsByTemplate && typeof res.partsByTemplate === 'object') {
      Object.keys(res.partsByTemplate).forEach(function (tid) {
        var list = res.partsByTemplate[tid];
        if (Array.isArray(list) && list.length) tasks.push(global.CNCDB.putMany('parts', list));
      });
    } else if (Array.isArray(res.parts) && res.parts.length) {
      tasks.push(global.CNCDB.putMany('parts', res.parts));
    }
    if (res.storage && res.storage.code) {
      tasks.push(global.CNCDB.putOne('storages', res.storage));
    }
    if (res.movement && res.movement.id) {
      tasks.push(global.CNCDB.putOne('movements', res.movement));
    }
    if (Array.isArray(res.movements) && res.movements.length) {
      tasks.push(global.CNCDB.putMany('movements', res.movements));
    }
    if (res.acrylic && res.acrylic.id) {
      tasks.push(global.CNCDB.putOne('acrylics', res.acrylic));
    }
    if (res.acrylicLog && res.acrylicLog.id) {
      tasks.push(global.CNCDB.putOne('acrylicLogs', res.acrylicLog));
    }
    return Promise.all(tasks);
  }

  function markOpRetry(op, errMsg) {
    op.retries = (Number(op.retries || 0) + 1);
    var delayMs = Math.min(300000, 5000 * Math.pow(2, Math.min(6, op.retries - 1)));
    op.nextRetryAt = Date.now() + delayMs;
    op.status = 'pending';
    op.lastError = String(errMsg || 'Gagal kirim, menunggu coba ulang');
    return global.CNCDB.updateOutboxOp(op);
  }

  function markOpError(op, errMsg) {
    op.status = 'error';
    op.lastError = String(errMsg || 'Ditolak server');
    return global.CNCDB.updateOutboxOp(op);
  }

  function pushOutboxOps(force) {
    return global.CNCDB.getOutbox().then(function (ops) {
      var now = Date.now();
      var ready = ops.filter(function (o) {
        return o.status !== 'error' && (force || !o.nextRetryAt || o.nextRetryAt <= now);
      });
      if (!ready.length) return { pushed: 0, failed: 0 };

      var pushed = 0;
      var failed = 0;
      var regularOps = ready.filter(function (o) { return o.type !== 'uploadSketch'; });
      var sketchOps = ready.filter(function (o) { return o.type === 'uploadSketch'; });

      // 1. Kirim regular ops dalam batch (maks 20 per request agar cepat dan aman)
      var chain = Promise.resolve();
      for (var i = 0; i < regularOps.length; i += 20) {
        (function (batch) {
          chain = chain.then(function () {
            return postApi('pushOutbox', {
              ops: batch.map(function (o) { return { opId: o.opId, type: o.type, payload: o.payload }; })
            }, { timeoutMs: 45000 }).then(function (res) {
              var results = Array.isArray(res.results) ? res.results : [];
              var byId = new Map();
              results.forEach(function (r) { if (r && r.opId) byId.set(r.opId, r); });

              var postTasks = batch.map(function (op) {
                var r = byId.get(op.opId);
                if (!r) return markOpRetry(op, 'Respons batch tidak memuat opId');
                if (r.ok || r.status === 'applied' || r.status === 'stale' || r.duplicateOp || r.duplicateRequest) {
                  pushed++;
                  return applyOpResultLocally(r).then(function () {
                    return global.CNCDB.removeOutboxOp(op.opId);
                  });
                }
                failed++;
                if (r.retryable === false) {
                  return markOpError(op, r.message);
                }
                return markOpRetry(op, r.message);
              });
              return Promise.all(postTasks);
            }, function (err) {
              if (err && err.authError) throw err;
              failed += batch.length;
              return Promise.all(batch.map(function (op) { return markOpRetry(op, err.message); }));
            });
          });
        })(regularOps.slice(i, i + 20));
      }

      // 2. Kirim antrean sketch satu per satu (gambar diambil dari penyimpanan lokal agar outbox tetap ringan)
      sketchOps.forEach(function (op) {
        chain = chain.then(function () {
          var tid = String((op.payload && (op.payload.templateId || op.payload.id)) || '');
          return global.CNCDB.getSketchLocal(tid).then(function (localImgs) {
            var sketches = (localImgs && localImgs.length) ? localImgs : (op.payload && op.payload.sketches ? op.payload.sketches : []);
            if (!sketches.length) {
              return global.CNCDB.removeOutboxOp(op.opId);
            }
            return postApi('uploadSketch', { templateId: tid, sketches: sketches }, { timeoutMs: 60000 }).then(function () {
              pushed++;
              return global.CNCDB.saveSketchLocal(tid, sketches, { synced: true }).then(function () {
                return global.CNCDB.removeOutboxOp(op.opId);
              });
            }, function (err) {
              if (err && err.authError) throw err;
              failed++;
              if (err && err.retryable === false) return markOpError(op, err.message);
              return markOpRetry(op, err.message);
            });
          });
        });
      });

      return chain.then(function () { return { pushed: pushed, failed: failed }; });
    });
  }

  function pullDelta(full) {
    return Promise.all([
      full ? Promise.resolve('') : global.CNCDB.getMeta('lastSyncAt', ''),
      global.CNCDB.getOutbox()
    ]).then(function (pair) {
      var since = pair[0] || '';
      var remainingOutbox = pair[1] || [];
      return postApi('syncDelta', { since: since }, { timeoutMs: 45000 }).then(function (res) {
        return global.CNCDB.mergeServerDelta(res.data || {}, remainingOutbox).then(function (merged) {
          var nextSyncAt = res.serverTime || global.CNCDB.nowIso();
          return global.CNCDB.setMeta('lastSyncAt', nextSyncAt).then(function () {
            return { merged: merged, serverTime: nextSyncAt, fullSync: !!res.fullSync };
          });
        });
      });
    });
  }

  function syncNow(opts) {
    opts = opts || {};
    if (syncInFlight) return syncInFlight;
    if (!isOnline()) {
      state.online = false;
      emitState();
      return Promise.resolve({ ok: false, offline: true, message: 'Perangkat sedang offline. Data tetap tersimpan di lokal.' });
    }

    syncInFlight = Promise.all([
      global.CNCDB.getEffectiveConfig(),
      global.CNCDB.loadSession()
    ]).then(function (pair) {
      var cfg = pair[0];
      var sess = pair[1];
      if (!cfg.apiUrl) {
        return { ok: false, skipped: true, message: 'URL Apps Script belum diatur.' };
      }
      if (!sess || !(sess.token || sess.sessionToken)) {
        return { ok: false, skipped: true, message: 'Belum login ke server.' };
      }

      state.syncing = true;
      state.lastError = '';
      emitState();

      return pushOutboxOps(!!opts.force).then(function (pushRes) {
        return pullDelta(!!opts.full).then(function (pullRes) {
          global.CNCDB.scheduleAutoBackup();
          return {
            ok: true,
            pushed: pushRes.pushed,
            failed: pushRes.failed,
            merged: pullRes.merged,
            serverTime: pullRes.serverTime
          };
        });
      });
    }).catch(function (err) {
      state.lastError = err && err.message ? err.message : String(err);
      return { ok: false, error: state.lastError, authError: !!(err && err.authError) };
    }).finally(function () {
      state.syncing = false;
      syncInFlight = null;
      refreshOutboxCounters();
    });

    return syncInFlight;
  }

  function enqueueAndSync(type, payload) {
    return global.CNCDB.enqueueOutbox(type, payload).then(function (op) {
      return refreshOutboxCounters().then(function () {
        if (isOnline()) {
          setTimeout(function () { syncNow({ silent: true }); }, 120);
        }
        return op;
      });
    });
  }

  function retryAllFailedOutbox() {
    return global.CNCDB.getOutbox().then(function (ops) {
      var tasks = ops.map(function (o) {
        o.status = 'pending';
        o.nextRetryAt = 0;
        o.lastError = '';
        return global.CNCDB.updateOutboxOp(o);
      });
      return Promise.all(tasks);
    }).then(function () {
      return refreshOutboxCounters().then(function () {
        return syncNow({ force: true });
      });
    });
  }

  function fetchSketch(templateId) {
    var tid = String(templateId || '').trim();
    if (!tid) return Promise.resolve([]);
    return global.CNCDB.getSketchLocal(tid).then(function (cached) {
      if (cached && cached.length) return cached;
      if (!isOnline()) throw new Error('Perangkat offline dan sketch ini belum pernah di-cache di perangkat.');
      return postApi('getSketch', { templateId: tid }, { timeoutMs: 45000 }).then(function (res) {
        var list = Array.isArray(res.sketches) && res.sketches.length ? res.sketches : (res.sketch ? [res.sketch] : []);
        if (!list.length) return [];
        return global.CNCDB.saveSketchLocal(tid, list, { synced: true }).then(function () { return list; });
      });
    });
  }

  function startAutoSync(intervalMs) {
    stopAutoSync();
    var ms = Math.max(15000, Number(intervalMs || (global.CNC_CONFIG && global.CNC_CONFIG.syncIntervalMs) || 60000));
    syncTimer = setInterval(function () {
      if (isOnline()) syncNow({ silent: true });
    }, ms);
  }

  function stopAutoSync() {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('online', function () {
      state.online = true;
      emitState();
      setTimeout(function () { syncNow({ force: true, silent: true }); }, 400);
    });
    global.addEventListener('offline', function () {
      state.online = false;
      emitState();
    });
  }

  global.CNCSync = {
    getState: function () { return Object.assign({}, state); },
    subscribe: subscribe,
    isOnline: isOnline,
    validateApiUrl: validateApiUrl,
    postApi: postApi,
    refreshOutboxCounters: refreshOutboxCounters,
    syncNow: syncNow,
    enqueueAndSync: enqueueAndSync,
    retryAllFailedOutbox: retryAllFailedOutbox,
    fetchSketch: fetchSketch,
    startAutoSync: startAutoSync,
    stopAutoSync: stopAutoSync
  };
})(window);
