/*
 * CNC Template Tracker — Local IndexedDB & Backup Layer (Offline-First)
 * Skrip klasik (tanpa type="module"), jalan di file:// (PC) dan Capacitor (Android).
 */
(function (global) {
  'use strict';

  var DB_NAME = 'cnc_template_tracker_v5';
  var DB_VERSION = 2;
  var STORES = ['storages', 'templates', 'parts', 'movements', 'acrylics', 'acrylicLogs', 'users', 'sketches', 'outbox', 'meta', 'session'];

  var idbInstance = null;
  var memoryFallback = null;
  var autoBackupTimer = null;

  function uuid(prefix) {
    var hex = [];
    var bytes = new Uint8Array(16);
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      global.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    for (var j = 0; j < 16; j++) {
      var h = bytes[j].toString(16);
      hex.push(h.length === 1 ? '0' + h : h);
    }
    var raw = (
      hex[0] + hex[1] + hex[2] + hex[3] + '-' +
      hex[4] + hex[5] + '-' +
      hex[6] + hex[7] + '-' +
      hex[8] + hex[9] + '-' +
      hex[10] + hex[11] + hex[12] + hex[13] + hex[14] + hex[15]
    ).toUpperCase();
    return prefix ? (String(prefix).toUpperCase() + '-' + raw) : raw;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function parseMs(v) {
    if (!v) return 0;
    var t = Date.parse(String(v));
    return isNaN(t) ? 0 : t;
  }

  function ensureMemory() {
    if (!memoryFallback) {
      memoryFallback = {};
      STORES.forEach(function (s) { memoryFallback[s] = new Map(); });
    }
    return memoryFallback;
  }

  function keyFieldOf(storeName) {
    if (storeName === 'storages') return 'code';
    if (storeName === 'templates' || storeName === 'movements' || storeName === 'acrylics' || storeName === 'acrylicLogs') return 'id';
    if (storeName === 'parts') return 'partId';
    if (storeName === 'users') return 'username';
    if (storeName === 'sketches') return 'templateId';
    if (storeName === 'outbox') return 'opId';
    return 'key';
  }

  function openDB() {
    if (idbInstance) return Promise.resolve(idbInstance);
    if (!global.indexedDB) {
      ensureMemory();
      return Promise.resolve(null);
    }
    return new Promise(function (resolve, reject) {
      try {
        var req = global.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function (ev) {
          var db = ev.target.result;
          STORES.forEach(function (name) {
            if (!db.objectStoreNames.contains(name)) {
              var st = db.createObjectStore(name, { keyPath: keyFieldOf(name) });
              if (name === 'parts' || name === 'movements' || name === 'acrylicLogs') {
                st.createIndex('byTemplate', 'templateId', { unique: false });
              }
              if (name === 'acrylicLogs') {
                st.createIndex('byAcrylic', 'acrylicId', { unique: false });
              }
              if (name === 'outbox') {
                st.createIndex('byCreatedAt', 'createdAt', { unique: false });
              }
            }
          });
        };
        req.onsuccess = function (ev) {
          idbInstance = ev.target.result;
          idbInstance.onversionchange = function () {
            try { idbInstance.close(); } catch (e) {}
            idbInstance = null;
          };
          resolve(idbInstance);
        };
        req.onerror = function () {
          ensureMemory();
          resolve(null);
        };
      } catch (e) {
        ensureMemory();
        resolve(null);
      }
    });
  }

  function getAll(storeName) {
    return openDB().then(function (db) {
      if (!db) return Array.from(ensureMemory()[storeName].values());
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readonly');
        var req = tx.objectStore(storeName).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function getOne(storeName, key) {
    return openDB().then(function (db) {
      if (!db) return ensureMemory()[storeName].get(key) || null;
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readonly');
        var req = tx.objectStore(storeName).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function putOne(storeName, value) {
    return openDB().then(function (db) {
      if (!db) {
        ensureMemory()[storeName].set(value[keyFieldOf(storeName)], value);
        return value;
      }
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value);
        tx.oncomplete = function () { resolve(value); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function putMany(storeName, items) {
    if (!items || !items.length) return Promise.resolve();
    return openDB().then(function (db) {
      if (!db) {
        var m = ensureMemory()[storeName];
        var kf = keyFieldOf(storeName);
        items.forEach(function (it) { m.set(it[kf], it); });
        return;
      }
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        var st = tx.objectStore(storeName);
        items.forEach(function (it) { st.put(it); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function deleteOne(storeName, key) {
    return openDB().then(function (db) {
      if (!db) {
        ensureMemory()[storeName].delete(key);
        return;
      }
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function clearStore(storeName) {
    return openDB().then(function (db) {
      if (!db) {
        ensureMemory()[storeName].clear();
        return;
      }
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ================= META & CONFIG ================= */

  function getMeta(key, fallback) {
    return getOne('meta', key).then(function (rec) {
      return rec ? rec.value : fallback;
    });
  }

  function setMeta(key, value) {
    return putOne('meta', { key: key, value: value, updatedAt: nowIso() });
  }

  function getDeviceId() {
    return getMeta('deviceId', '').then(function (existing) {
      if (existing) return existing;
      var devId = uuid('DEV');
      return setMeta('deviceId', devId).then(function () { return devId; });
    });
  }

  function getEffectiveConfig() {
    var base = Object.assign({
      appName: 'CNC Template Tracker',
      version: '5.0.0-offline',
      apiUrl: '',
      spreadsheetId: '',
      syncIntervalMs: 60000,
      maxSketchBytes: 1024 * 1024,
      tokenDays: 30
    }, global.CNC_CONFIG || {});
    return getMeta('config', null).then(function (saved) {
      if (!saved || typeof saved !== 'object') return base;
      var merged = Object.assign({}, base, saved);
      if (!saved.apiUrl && base.apiUrl) merged.apiUrl = base.apiUrl;
      if (!saved.spreadsheetId && base.spreadsheetId) merged.spreadsheetId = base.spreadsheetId;
      return merged;
    });
  }

  function saveConfig(patch) {
    return getEffectiveConfig().then(function (cur) {
      var next = Object.assign({}, cur, patch || {});
      next.apiUrl = String(next.apiUrl || '').trim().replace(/\/+$/, '');
      next.spreadsheetId = String(next.spreadsheetId || '').trim();
      return setMeta('config', {
        apiUrl: next.apiUrl,
        spreadsheetId: next.spreadsheetId
      }).then(function () { return next; });
    });
  }

  /* ================= 30-DAY OFFLINE SESSION ================= */

  function saveSession(userObj) {
    return putOne('session', {
      key: 'active',
      user: userObj,
      savedAt: nowIso()
    });
  }

  function loadSession() {
    return getOne('session', 'active').then(function (rec) {
      if (!rec || !rec.user) return null;
      var exp = parseMs(rec.user.expiresAt);
      if (exp && exp <= Date.now()) {
        return deleteOne('session', 'active').then(function () { return null; });
      }
      return rec.user;
    });
  }

  function clearSession() {
    return deleteOne('session', 'active');
  }

  /* ================= SNAPSHOT & DELTA MERGE ================= */

  function loadAllData() {
    return Promise.all([
      getAll('storages'),
      getAll('templates'),
      getAll('parts'),
      getAll('movements'),
      getAll('users'),
      getAll('outbox'),
      getAll('acrylics'),
      getAll('acrylicLogs')
    ]).then(function (res) {
      return {
        storages: res[0],
        templates: res[1],
        parts: res[2],
        movements: res[3],
        users: res[4],
        outbox: res[5].sort(function (a, b) { return parseMs(a.createdAt) - parseMs(b.createdAt); }),
        acrylics: res[6],
        acrylicLogs: res[7]
      };
    });
  }

  // Merge delta dari server ke IndexedDB memakai aturan konflik:
  // - movements & acrylicLogs: append-only (dedupe UUID id)
  // - templates, parts, storages, acrylics: update terbaru menang (LWW berdasarkan updatedAt), tidak menimpa record yg masih pending di outbox dengan timestamp lebih baru
  function mergeServerDelta(delta, pendingOutbox) {
    delta = delta || {};
    var pendingIds = new Set();
    (pendingOutbox || []).forEach(function (op) {
      if (op.status === 'error') return;
      var p = op.payload || {};
      if (p.id) pendingIds.add(String(p.id));
      if (p.templateId) pendingIds.add(String(p.templateId));
      if (p.acrylicId) pendingIds.add(String(p.acrylicId));
      if (p.code) pendingIds.add(String(p.code).toUpperCase());
      if (Array.isArray(p.items)) p.items.forEach(function (it) { if (it.templateId) pendingIds.add(String(it.templateId)); });
    });

    function mergeLwwStore(storeName, incomingRows, keyFn) {
      if (!Array.isArray(incomingRows) || !incomingRows.length) return Promise.resolve(0);
      return getAll(storeName).then(function (localRows) {
        var localMap = new Map();
        localRows.forEach(function (r) { localMap.set(String(keyFn(r)), r); });
        var toPut = [];
        incomingRows.forEach(function (inc) {
          var k = String(keyFn(inc));
          if (!k) return;
          var loc = localMap.get(k);
          var incMs = parseMs(inc.updatedAt || inc.createdAt);
          var locMs = loc ? parseMs(loc.updatedAt || loc.createdAt) : 0;
          // Jika lokal masih punya antrean outbox untuk entitas ini dan timestamp lokal >= server, tahan lokal
          if (loc && pendingIds.has(k) && locMs >= incMs) return;
          if (!loc || incMs >= locMs) {
            toPut.push(inc);
          }
        });
        return putMany(storeName, toPut).then(function () { return toPut.length; });
      });
    }

    function mergeAppendOnlyStore(storeName, incomingRows) {
      if (!Array.isArray(incomingRows) || !incomingRows.length) return Promise.resolve(0);
      return getAll(storeName).then(function (localRows) {
        var seen = new Set(localRows.map(function (m) { return String(m.id); }));
        var toAdd = incomingRows.filter(function (m) { return m && m.id && !seen.has(String(m.id)); });
        return putMany(storeName, toAdd).then(function () { return toAdd.length; });
      });
    }

    return Promise.all([
      mergeLwwStore('storages', delta.storages, function (r) { return r.code; }),
      mergeLwwStore('templates', delta.templates, function (r) { return r.id; }),
      mergeLwwStore('parts', delta.parts, function (r) { return r.partId; }),
      mergeAppendOnlyStore('movements', delta.movements),
      mergeLwwStore('acrylics', delta.acrylics, function (r) { return r.id; }),
      mergeAppendOnlyStore('acrylicLogs', delta.acrylicLogs)
    ]).then(function (counts) {
      return {
        storages: counts[0],
        templates: counts[1],
        parts: counts[2],
        movements: counts[3],
        acrylics: counts[4],
        acrylicLogs: counts[5]
      };
    });
  }

  /* ================= SKETCH LOCAL STORAGE (FILE DI ANDROID / IDB DI PC) ================= */

  function hasNativeSketchFiles() {
    return !!(global.Android && typeof global.Android.saveSketchFile === 'function' && typeof global.Android.readSketchFile === 'function');
  }

  function saveSketchLocal(templateId, sketches, opts) {
    var tid = String(templateId || '').trim();
    if (!tid) return Promise.resolve();
    var list = Array.isArray(sketches) ? sketches.filter(Boolean) : (sketches ? [String(sketches)] : []);
    opts = opts || {};
    var usedNative = false;
    if (hasNativeSketchFiles()) {
      try {
        if (typeof global.Android.deleteSketchFiles === 'function') global.Android.deleteSketchFiles(tid);
        var okCount = 0;
        list.forEach(function (dataUrl, idx) {
          var saved = global.Android.saveSketchFile(tid, idx, String(dataUrl));
          if (saved) okCount++;
        });
        if (okCount === list.length) usedNative = true;
      } catch (e) {
        usedNative = false;
      }
    }
    return putOne('sketches', {
      templateId: tid,
      sketches: usedNative ? [] : list,
      count: list.length,
      localFiles: usedNative,
      synced: !!opts.synced,
      deleted: list.length === 0,
      updatedAt: opts.updatedAt || nowIso()
    });
  }

  function getSketchLocal(templateId) {
    var tid = String(templateId || '').trim();
    if (!tid) return Promise.resolve([]);
    return getOne('sketches', tid).then(function (rec) {
      if (!rec || rec.deleted) return [];
      if (rec.localFiles && hasNativeSketchFiles()) {
        var out = [];
        var count = Math.max(0, Number(rec.count || 0));
        for (var i = 0; i < count; i++) {
          try {
            var dataUrl = global.Android.readSketchFile(tid, i);
            if (dataUrl) out.push(String(dataUrl));
          } catch (e) {}
        }
        if (out.length) return out;
      }
      return Array.isArray(rec.sketches) ? rec.sketches : [];
    });
  }

  function deleteSketchLocal(templateId) {
    var tid = String(templateId || '').trim();
    if (!tid) return Promise.resolve();
    if (global.Android && typeof global.Android.deleteSketchFiles === 'function') {
      try { global.Android.deleteSketchFiles(tid); } catch (e) {}
    }
    return putOne('sketches', {
      templateId: tid,
      sketches: [],
      count: 0,
      localFiles: false,
      synced: false,
      deleted: true,
      updatedAt: nowIso()
    });
  }

  /* ================= OUTBOX HELPERS ================= */

  function enqueueOutbox(type, payload) {
    var op = {
      opId: uuid('OP'),
      type: String(type),
      payload: payload || {},
      createdAt: nowIso(),
      retries: 0,
      nextRetryAt: 0,
      status: 'pending',
      lastError: ''
    };
    return putOne('outbox', op).then(function () {
      scheduleAutoBackup();
      return op;
    });
  }

  function getOutbox() {
    return getAll('outbox').then(function (rows) {
      return rows.sort(function (a, b) { return parseMs(a.createdAt) - parseMs(b.createdAt); });
    });
  }

  function updateOutboxOp(op) {
    return putOne('outbox', op);
  }

  function removeOutboxOp(opId) {
    return deleteOne('outbox', opId);
  }

  /* ================= EXPORT / IMPORT JSON & AUTO-BACKUP FOLDER (PC) ================= */

  function exportBackupObject() {
    return Promise.all([
      getAll('storages'),
      getAll('templates'),
      getAll('parts'),
      getAll('movements'),
      getAll('sketches'),
      getAll('outbox'),
      getMeta('lastSyncAt', ''),
      getEffectiveConfig(),
      getAll('acrylics'),
      getAll('acrylicLogs')
    ]).then(function (res) {
      return {
        format: 'cnc-template-tracker-backup',
        version: '5.1.0',
        exportedAt: nowIso(),
        lastSyncAt: res[6] || '',
        config: { apiUrl: res[7].apiUrl || '', spreadsheetId: res[7].spreadsheetId || '' },
        data: {
          storages: res[0],
          templates: res[1],
          parts: res[2],
          movements: res[3],
          sketches: res[4],
          outbox: res[5],
          acrylics: res[8],
          acrylicLogs: res[9]
        }
      };
    });
  }

  function importBackupObject(obj, mode) {
    if (!obj || typeof obj !== 'object' || !obj.data) {
      return Promise.reject(new Error('Format file backup JSON tidak valid.'));
    }
    var d = obj.data;
    var isReplace = mode === 'replace';
    var start = isReplace
      ? Promise.all(['storages', 'templates', 'parts', 'movements', 'sketches', 'outbox', 'acrylics', 'acrylicLogs'].map(clearStore))
      : Promise.resolve();

    return start.then(function () {
      if (isReplace) {
        return Promise.all([
          putMany('storages', d.storages || []),
          putMany('templates', d.templates || []),
          putMany('parts', d.parts || []),
          putMany('movements', d.movements || []),
          putMany('sketches', d.sketches || []),
          putMany('outbox', d.outbox || []),
          putMany('acrylics', d.acrylics || []),
          putMany('acrylicLogs', d.acrylicLogs || [])
        ]);
      }
      return mergeServerDelta(d, []).then(function () {
        var extra = [];
        if (Array.isArray(d.sketches) && d.sketches.length) extra.push(putMany('sketches', d.sketches));
        if (Array.isArray(d.outbox) && d.outbox.length) extra.push(putMany('outbox', d.outbox));
        return Promise.all(extra);
      });
    }).then(function () {
      var metaUpdates = [];
      if (obj.lastSyncAt && isReplace) metaUpdates.push(setMeta('lastSyncAt', obj.lastSyncAt));
      if (obj.config && obj.config.apiUrl) {
        metaUpdates.push(getEffectiveConfig().then(function (cur) {
          if (!cur.apiUrl) return saveConfig(obj.config);
        }));
      }
      return Promise.all(metaUpdates);
    }).then(function () {
      return {
        storages: (d.storages || []).length,
        templates: (d.templates || []).length,
        parts: (d.parts || []).length,
        movements: (d.movements || []).length,
        acrylics: (d.acrylics || []).length,
        acrylicLogs: (d.acrylicLogs || []).length
      };
    });
  }

  function supportsAutoBackupFolder() {
    return typeof global.showDirectoryPicker === 'function';
  }

  function pickAutoBackupFolder() {
    if (!supportsAutoBackupFolder()) {
      return Promise.reject(new Error('Browser/perangkat ini belum mendukung pemilihan folder langsung. Gunakan tombol Export Backup JSON.'));
    }
    return global.showDirectoryPicker({ mode: 'readwrite' }).then(function (dirHandle) {
      return Promise.all([
        setMeta('backupDirHandle', dirHandle),
        setMeta('backupDirName', dirHandle.name || 'Folder Backup'),
        setMeta('autoBackupEnabled', true)
      ]).then(function () {
        return runAutoBackup(true).then(function () { return dirHandle.name || 'Folder Backup'; });
      });
    });
  }

  function disableAutoBackupFolder() {
    return Promise.all([
      deleteOne('meta', 'backupDirHandle'),
      deleteOne('meta', 'backupDirName'),
      setMeta('autoBackupEnabled', false)
    ]);
  }

  function getAutoBackupStatus() {
    return Promise.all([
      getMeta('autoBackupEnabled', false),
      getMeta('backupDirName', ''),
      getMeta('lastBackupAt', '')
    ]).then(function (res) {
      return {
        supported: supportsAutoBackupFolder(),
        enabled: !!res[0] && !!res[1],
        folderName: res[1] || '',
        lastBackupAt: res[2] || ''
      };
    });
  }

  function runAutoBackup(requestPerm) {
    if (!supportsAutoBackupFolder()) return Promise.resolve(false);
    return Promise.all([
      getMeta('autoBackupEnabled', false),
      getMeta('backupDirHandle', null)
    ]).then(function (res) {
      var enabled = res[0];
      var handle = res[1];
      if (!enabled || !handle) return false;
      var permCheck = handle.queryPermission ? handle.queryPermission({ mode: 'readwrite' }) : Promise.resolve('granted');
      return permCheck.then(function (perm) {
        if (perm !== 'granted' && requestPerm && handle.requestPermission) {
          return handle.requestPermission({ mode: 'readwrite' });
        }
        return perm;
      }).then(function (perm) {
        if (perm !== 'granted') return false;
        return exportBackupObject().then(function (backupObj) {
          var jsonText = JSON.stringify(backupObj, null, 2);
          var dateStr = nowIso().slice(0, 10);
          function writeFile(fileName) {
            return handle.getFileHandle(fileName, { create: true }).then(function (fh) {
              return fh.createWritable().then(function (w) {
                return w.write(jsonText).then(function () { return w.close(); });
              });
            });
          }
          return Promise.all([
            writeFile('cnc-tracker-autobackup.json'),
            writeFile('cnc-tracker-' + dateStr + '.json')
          ]).then(function () {
            return setMeta('lastBackupAt', nowIso()).then(function () { return true; });
          });
        });
      });
    }).catch(function () { return false; });
  }

  function scheduleAutoBackup() {
    clearTimeout(autoBackupTimer);
    autoBackupTimer = setTimeout(function () {
      runAutoBackup(false);
    }, 2500);
  }

  global.CNCDB = {
    DB_NAME: DB_NAME,
    uuid: uuid,
    nowIso: nowIso,
    parseMs: parseMs,
    openDB: openDB,
    getAll: getAll,
    getOne: getOne,
    putOne: putOne,
    putMany: putMany,
    deleteOne: deleteOne,
    clearStore: clearStore,
    getMeta: getMeta,
    setMeta: setMeta,
    getDeviceId: getDeviceId,
    getEffectiveConfig: getEffectiveConfig,
    saveConfig: saveConfig,
    saveSession: saveSession,
    loadSession: loadSession,
    clearSession: clearSession,
    loadAllData: loadAllData,
    mergeServerDelta: mergeServerDelta,
    saveSketchLocal: saveSketchLocal,
    getSketchLocal: getSketchLocal,
    deleteSketchLocal: deleteSketchLocal,
    enqueueOutbox: enqueueOutbox,
    getOutbox: getOutbox,
    updateOutboxOp: updateOutboxOp,
    removeOutboxOp: removeOutboxOp,
    exportBackupObject: exportBackupObject,
    importBackupObject: importBackupObject,
    supportsAutoBackupFolder: supportsAutoBackupFolder,
    pickAutoBackupFolder: pickAutoBackupFolder,
    disableAutoBackupFolder: disableAutoBackupFolder,
    getAutoBackupStatus: getAutoBackupStatus,
    runAutoBackup: runAutoBackup,
    scheduleAutoBackup: scheduleAutoBackup
  };
})(window);
