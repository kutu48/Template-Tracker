/**
 * CNC Template Tracker — Offline-First Sync Backend (Google Apps Script)
 * Version: 5.0.0-offline-sync
 *
 * Arsitektur:
 * - Transport tunggal: POST dengan Content-Type: text/plain;charset=utf-8 (CORS simple request, respons JSON terbaca penuh).
 *   Tidak memakai OpenSheet, JSONP, maupun POST no-cors.
 * - Token perangkat berumur panjang (30 hari) disimpan sebagai hash SHA-256 di tab privat SESSIONS (+ cache cepat CacheService).
 * - Delta sync (action: 'syncDelta', payload: { since }) untuk unduh perubahan saja, termasuk soft delete (deleted = TRUE).
 * - Outbox batch push (action: 'pushOutbox', payload: { ops: [...] }) dengan idempotensi opId:
 *   - MOVEMENTS bersifat append-only (dedupe berdasarkan UUID klien).
 *   - TEMPLATES, TEMPLATE_PARTS, STORAGES memakai aturan konflik Last-Write-Wins ("update terbaru menang" berdasarkan updatedAt).
 * - Gambar sketch disimpan di folder Google Drive privat (maks 1 MB per gambar), diunggah lewat antrean & diunduh on-demand.
 * - Tab USERS, SESSIONS, dan SKETCHES tidak pernah dipublikasikan.
 */

const APP_VERSION = '5.0.0-offline-sync';
// Biarkan kosong untuk script yang terikat pada Spreadsheet (container-bound).
// Untuk standalone project, isi Spreadsheet ID di sini atau lewat Script Property CNC_SPREADSHEET_ID.
const SPREADSHEET_ID = '';
const MAX_SKETCH_BYTES = 1024 * 1024;
const DRIVE_REF_PREFIX = 'DRIVE_FILE:';
const TOKEN_TTL_DAYS = 30;
const TOKEN_TTL_MS = TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
const SESSION_CACHE_TTL_SEC = 21600; // 6 jam cache cepat di CacheService (sumber utama tetap tab SESSIONS 30 hari)
const OP_CACHE_TTL_SEC = 21600;

const SHEETS = {
  USERS: ['username', 'password', 'role', 'name', 'active', 'createdAt', 'updatedAt'],
  SESSIONS: ['tokenHash', 'username', 'role', 'name', 'deviceId', 'deviceName', 'createdAt', 'expiresAt', 'lastSeenAt', 'revoked'],
  STORAGES: ['code', 'name', 'area', 'createdAt', 'updatedAt', 'deleted'],
  TEMPLATES: ['id', 'buyer', 'stylekp', 'status', 'currentStorage', 'sketch', 'createdBy', 'createdAt', 'updatedAt', 'distributedAt', 'deleted'],
  TEMPLATE_PARTS: ['partId', 'templateId', 'part', 'size', 'qty', 'createdAt', 'status', 'currentStorage', 'distributedAt', 'updatedAt', 'deleted'],
  MOVEMENTS: ['id', 'templateId', 'type', 'from', 'to', 'by', 'note', 'at'],
  SKETCHES: ['templateId', 'idx', 'seq', 'chunk', 'updatedAt', 'deleted']
};

function setup() {
  Object.keys(SHEETS).forEach(function (name) { ensureSheet_(name); });
  ensureBaseData_();
  getSketchFolder_(); // buat/otorisasi folder Drive privat saat setup awal
  var migrated = migrateSketches_();
  var migratedChunks = migrateLegacySketchChunksToDrive_();
  return json_({
    ok: true,
    version: APP_VERSION,
    migratedSketch: migrated,
    migratedChunks: migratedChunks,
    message: 'Setup selesai. Spreadsheet (termasuk tab SESSIONS & kolom soft-delete) + Drive privat siap.'
  });
}

function doGet(e) {
  try {
    e = e || { parameter: {} };
    var action = String((e.parameter && e.parameter.action) || 'ping').trim();
    if (action === 'ping') {
      return json_({ ok: true, version: APP_VERSION, now: new Date().toISOString(), transport: 'POST text/plain' });
    }
    return json_({
      ok: false,
      version: APP_VERSION,
      message: 'Gunakan HTTP POST (Content-Type: text/plain) dengan body JSON {action, token, payload}.'
    });
  } catch (err) {
    return errorJson_(err, 'doGet');
  }
}

function doPost(e) {
  try {
    e = e || {};
    var req = parsePostRequest_(e);
    var action = String(req.action || '').trim();
    var token = String(req.token || (req.payload && req.payload.sessionToken) || '').trim();
    var payload = req.payload || {};

    if (!action) return json_({ ok: false, version: APP_VERSION, message: 'Action wajib diisi.' });
    if (action === 'setup') return json_({ ok: false, version: APP_VERSION, message: 'Jalankan fungsi setup() satu kali dari Apps Script editor.' });
    if (action === 'ping') return json_({ ok: true, version: APP_VERSION, now: new Date().toISOString() });
    if (action === 'login') return login_(payload.username, payload.password, payload.deviceId, payload.deviceName);

    var session = requireSession_(token, action);
    if (!session) return authError_(action);

    if (action === 'verifySession') {
      return json_({
        ok: true,
        version: APP_VERSION,
        user: { username: session.username, role: session.role, name: session.name, expiresAt: session.expiresAt }
      });
    }
    if (action === 'logout') return withWriteLock_(function () { return logout_(token); });
    if (action === 'syncDelta') return syncDelta_(payload);
    if (action === 'getSketch') return getSketch_(payload.id || payload.templateId);
    if (action === 'listUsers') return listUsers_();
    if (action === 'filterMovements') return filterMovements_(payload);

    if (action === 'pushOutbox') {
      return withWriteLock_(function () { return pushOutbox_(payload, session); }, 25000);
    }
    if (action === 'uploadSketch') {
      return withWriteLock_(function () { return uploadSketch_(payload, session); }, 20000);
    }
    if (action === 'deleteSketch') {
      return withWriteLock_(function () { return deleteSketch_(payload, session); }, 15000);
    }
    if (action === 'addTemplate') {
      return withWriteLock_(function () { return addTemplate_(payload, session); }, 15000);
    }
    if (action === 'updateTemplate') {
      return withWriteLock_(function () { return updateTemplate_(payload, session); }, 15000);
    }
    if (action === 'deleteTemplate' || action === 'softDeleteTemplate') {
      return withWriteLock_(function () { return softDeleteTemplate_(payload, session); }, 15000);
    }
    if (action === 'distributeTemplate') {
      return withWriteLock_(function () { return distributeTemplate_(payload, session); }, 15000);
    }
    if (action === 'moveTemplate') {
      return withWriteLock_(function () { return moveTemplate_(payload, session); }, 15000);
    }
    if (action === 'bulkImportExisting' || action === 'fieldBulkAddTemplates') {
      return withWriteLock_(function () { return bulkImportExisting_(payload, session); }, 20000);
    }
    if (action === 'addStorage' || action === 'upsertStorage') {
      return withWriteLock_(function () { return upsertStorage_(payload, session); }, 12000);
    }
    if (action === 'deleteStorage' || action === 'softDeleteStorage') {
      return withWriteLock_(function () { return softDeleteStorage_(payload, session); }, 12000);
    }
    if (action === 'addUser') {
      return withWriteLock_(function () { return addUser_(payload); }, 12000);
    }
    if (action === 'resetPassword') {
      return withWriteLock_(function () { return resetPassword_(payload); }, 12000);
    }
    if (action === 'toggleUserActive') {
      return withWriteLock_(function () { return toggleUserActive_(payload); }, 12000);
    }

    return json_({ ok: false, version: APP_VERSION, message: 'Action POST tidak dikenal: ' + action });
  } catch (err) {
    return errorJson_(err, 'doPost');
  }
}

function parsePostRequest_(e) {
  var p = (e && e.parameter) || {};
  var raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : '';
  var body = {};
  if (raw) {
    var trimmed = raw.trim();
    if (trimmed.charAt(0) === '{') {
      body = JSON.parse(trimmed);
    } else {
      trimmed.split('&').forEach(function (pair) {
        var idx = pair.indexOf('=');
        if (idx < 0) return;
        var k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
        var v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
        body[k] = v;
      });
      if (typeof body.payload === 'string' && body.payload.trim().charAt(0) === '{') {
        body.payload = JSON.parse(body.payload);
      }
    }
  }
  var action = body.action || p.action || '';
  var token = body.token || body.sessionToken || (body.payload && body.payload.sessionToken) || '';
  var payload = (body.payload && typeof body.payload === 'object') ? body.payload : body;
  return { action: action, token: token, payload: payload };
}

/* ================= AUTH & 30-DAY PERSISTENT DEVICE TOKENS ================= */

function tokenHash_(token) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token || ''), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

function sessionCacheKey_(hash) {
  return 'SESS5_' + String(hash || '');
}

function hasActionPermission_(role, action) {
  role = String(role || 'operator').toLowerCase();
  if (['addUser', 'resetPassword', 'listUsers', 'toggleUserActive'].indexOf(action) >= 0) {
    return role === 'super_admin';
  }
  if (['updateTemplate', 'deleteTemplate', 'softDeleteTemplate', 'deleteStorage', 'softDeleteStorage', 'deleteSketch'].indexOf(action) >= 0) {
    return role === 'admin' || role === 'super_admin';
  }
  return true;
}

function requireSession_(token, action) {
  if (!token) return null;
  var hash = tokenHash_(token);
  var cache = CacheService.getScriptCache();
  var cacheKey = sessionCacheKey_(hash);
  var session = null;

  var cachedRaw = cache.get(cacheKey);
  if (cachedRaw) {
    try { session = JSON.parse(cachedRaw); } catch (e) { session = null; }
  }

  if (!session) {
    var row = findRow_('SESSIONS', 'tokenHash', hash);
    if (!row) return null;
    if (isTrue_(row.revoked)) return null;
    var exp = parseTimeMs_(row.expiresAt);
    if (!exp || exp <= Date.now()) return null;

    var userRow = read_('USERS').find(function (u) {
      return String(u.username || '').trim().toLowerCase() === String(row.username || '').trim().toLowerCase();
    });
    if (!userRow || String(userRow.active || '').toUpperCase() === 'FALSE') return null;

    session = {
      username: String(userRow.username),
      role: String(userRow.role || 'operator').toLowerCase(),
      name: String(userRow.name || userRow.username),
      deviceId: String(row.deviceId || ''),
      expiresAt: toIso_(row.expiresAt)
    };
    try { cache.put(cacheKey, JSON.stringify(session), SESSION_CACHE_TTL_SEC); } catch (e) {}
  } else {
    var cachedExp = parseTimeMs_(session.expiresAt);
    if (!cachedExp || cachedExp <= Date.now()) {
      try { cache.remove(cacheKey); } catch (e) {}
      return null;
    }
  }

  if (action && !hasActionPermission_(session.role, action)) return null;
  return session;
}

function authError_(action) {
  return json_({
    ok: false,
    authError: true,
    version: APP_VERSION,
    message: 'Sesi tidak valid, kedaluwarsa, atau tidak memiliki izin untuk aksi ' + String(action || '') + '. Silakan login ulang.'
  });
}

function validatePassword_(password) {
  password = String(password || '');
  if (password.length < 10) throw new Error('Password minimal 10 karakter.');
}

function createPasswordHash_(password) {
  var salt = Utilities.getUuid().replace(/-/g, '');
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + ':' + String(password || ''),
    Utilities.Charset.UTF_8
  );
  return 'sha256$' + salt + '$' + Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

function verifyPassword_(stored, password) {
  stored = String(stored || '');
  password = String(password || '');
  if (!password) return false;
  if (stored.indexOf('sha256$') === 0) {
    var parts = stored.split('$');
    if (parts.length !== 3 || !parts[1] || !parts[2]) return false;
    var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      parts[1] + ':' + password,
      Utilities.Charset.UTF_8
    );
    return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '') === parts[2];
  }
  return stored === password;
}

function login_(username, password, deviceId, deviceName) {
  ensureSheet_('USERS');
  ensureSheet_('SESSIONS');
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  var u = read_('USERS').find(function (x) {
    return String(x.username || '').trim().toLowerCase() === username && String(x.active || '').toUpperCase() !== 'FALSE';
  });
  if (!u || !verifyPassword_(String(u.password || ''), password)) {
    return json_({ ok: false, version: APP_VERSION, message: 'Username/password salah atau user tidak aktif.' });
  }
  var now = new Date();
  var nowIso = now.toISOString();
  if (String(u.password || '').indexOf('sha256$') !== 0) {
    update_('USERS', u._row, { password: createPasswordHash_(password), updatedAt: nowIso });
  }

  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var hash = tokenHash_(token);
  var expiresAt = new Date(now.getTime() + TOKEN_TTL_MS).toISOString();
  var devId = String(deviceId || id_('DEV')).trim().slice(0, 80);
  var devName = String(deviceName || 'Device').trim().slice(0, 120);

  withWriteLock_(function () {
    pruneExpiredSessions_();
    append_('SESSIONS', {
      tokenHash: hash,
      username: u.username,
      role: String(u.role || 'operator').toLowerCase(),
      name: u.name || u.username,
      deviceId: devId,
      deviceName: devName,
      createdAt: nowIso,
      expiresAt: expiresAt,
      lastSeenAt: nowIso,
      revoked: 'FALSE'
    });
  }, 10000);

  var userObj = {
    username: String(u.username),
    role: String(u.role || 'operator').toLowerCase(),
    name: String(u.name || u.username),
    deviceId: devId,
    expiresAt: expiresAt
  };
  try {
    CacheService.getScriptCache().put(sessionCacheKey_(hash), JSON.stringify(userObj), SESSION_CACHE_TTL_SEC);
  } catch (e) {}

  userObj.token = token;
  userObj.sessionToken = token;
  return json_({ ok: true, version: APP_VERSION, user: userObj, tokenDays: TOKEN_TTL_DAYS });
}

function logout_(token) {
  if (!token) return json_({ ok: true, version: APP_VERSION });
  var hash = tokenHash_(token);
  try { CacheService.getScriptCache().remove(sessionCacheKey_(hash)); } catch (e) {}
  var row = findRow_('SESSIONS', 'tokenHash', hash);
  if (row && row._row) {
    update_('SESSIONS', row._row, { revoked: 'TRUE', lastSeenAt: new Date().toISOString() });
  }
  return json_({ ok: true, version: APP_VERSION, message: 'Logout berhasil.' });
}

function pruneExpiredSessions_() {
  var rows = read_('SESSIONS');
  if (rows.length < 150) return;
  var nowMs = Date.now();
  var toDelete = [];
  rows.forEach(function (r) {
    var exp = parseTimeMs_(r.expiresAt);
    if (isTrue_(r.revoked) || (exp && exp < nowMs - 7 * 24 * 60 * 60 * 1000)) {
      toDelete.push(r._row);
    }
  });
  if (toDelete.length) deleteSheetRows_('SESSIONS', toDelete);
}

function listUsers_() {
  var users = read_('USERS').map(function (u) {
    return {
      username: u.username,
      role: u.role || 'operator',
      name: u.name || u.username,
      active: String(u.active || 'TRUE').toUpperCase() !== 'FALSE',
      createdAt: toIso_(u.createdAt),
      updatedAt: toIso_(u.updatedAt)
    };
  });
  return json_({ ok: true, version: APP_VERSION, users: users });
}

/* ================= LOCK HELPER ================= */

function withWriteLock_(fn, waitMs) {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(waitMs || 10000)) {
      return json_({
        ok: false,
        retryable: true,
        version: APP_VERSION,
        message: 'Server sedang memproses sinkronisasi perangkat lain. Akan dicoba ulang otomatis.'
      });
    }
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/* ================= DELTA SYNC (since=timestamp) ================= */

function syncDelta_(p) {
  p = p || {};
  var serverTime = new Date().toISOString(); // ditangkap SEBELUM baca sheet agar tidak ada perubahan yang terlewat
  var sinceRaw = String(p.since || '').trim();
  var sinceMs = sinceRaw ? parseTimeMs_(sinceRaw) : 0;
  var isDelta = !!sinceMs;

  var allTemplates = readExcept_('TEMPLATES', ['sketch']);
  var allParts = read_('TEMPLATE_PARTS');
  hydratePartStatuses_(allParts, allTemplates);
  var allStorages = read_('STORAGES');
  var allMovements = read_('MOVEMENTS');
  var sketchMeta = getActiveSketchMeta_();

  var templates = allTemplates.filter(function (t) {
    if (!t.id) return false;
    if (!isDelta) return true;
    var u = Math.max(parseTimeMs_(t.updatedAt), parseTimeMs_(t.createdAt), sketchMeta[String(t.id)] ? sketchMeta[String(t.id)].updatedMs : 0);
    return u > sinceMs;
  }).map(function (t) {
    var tid = String(t.id);
    var sm = sketchMeta[tid];
    return {
      id: tid,
      buyer: norm_(t.buyer),
      stylekp: norm_(t.stylekp),
      status: String(t.status || (t.currentStorage ? 'DISTRIBUTED' : 'WAITING_DISTRIBUTION')).toUpperCase(),
      currentStorage: String(t.currentStorage || ''),
      hasSketch: !!(sm && sm.count > 0),
      sketchCount: sm ? sm.count : 0,
      createdBy: String(t.createdBy || ''),
      createdAt: toIso_(t.createdAt),
      updatedAt: toIso_(t.updatedAt || t.createdAt),
      distributedAt: toIso_(t.distributedAt),
      deleted: isTrue_(t.deleted)
    };
  });

  var parts = allParts.filter(function (pp) {
    if (!pp.partId && !pp.templateId) return false;
    if (!isDelta) return true;
    var u = Math.max(parseTimeMs_(pp.updatedAt), parseTimeMs_(pp.createdAt));
    return u > sinceMs;
  }).map(function (pp) {
    return {
      partId: String(pp.partId || ''),
      templateId: String(pp.templateId || ''),
      part: norm_(pp.part),
      size: norm_(pp.size || ''),
      qty: Math.max(1, Math.round(Number(pp.qty || 1))),
      status: String(pp.status || 'WAITING_DISTRIBUTION').toUpperCase(),
      currentStorage: norm_(pp.currentStorage || ''),
      createdAt: toIso_(pp.createdAt),
      distributedAt: toIso_(pp.distributedAt),
      updatedAt: toIso_(pp.updatedAt || pp.createdAt),
      deleted: isTrue_(pp.deleted)
    };
  });

  var storages = allStorages.filter(function (s) {
    if (!s.code) return false;
    if (!isDelta) return true;
    var u = Math.max(parseTimeMs_(s.updatedAt), parseTimeMs_(s.createdAt));
    return u > sinceMs;
  }).map(function (s) {
    return {
      code: norm_(s.code),
      name: String(s.name || ''),
      area: String(s.area || ''),
      createdAt: toIso_(s.createdAt),
      updatedAt: toIso_(s.updatedAt || s.createdAt),
      deleted: isTrue_(s.deleted)
    };
  });

  var movements = allMovements.filter(function (m) {
    if (!m.id) return false;
    if (!isDelta) return true;
    return parseTimeMs_(m.at) > sinceMs;
  }).map(function (m) {
    return {
      id: String(m.id),
      templateId: String(m.templateId || ''),
      type: String(m.type || '').toUpperCase(),
      from: String(m.from || ''),
      to: String(m.to || ''),
      by: String(m.by || ''),
      note: String(m.note || ''),
      at: toIso_(m.at)
    };
  });

  return json_({
    ok: true,
    version: APP_VERSION,
    fullSync: !isDelta,
    since: sinceRaw,
    serverTime: serverTime,
    data: {
      storages: storages,
      templates: templates,
      parts: parts,
      movements: movements
    }
  });
}

/* ================= BATCH OUTBOX PROCESSOR ================= */

function pushOutbox_(p, session) {
  var ops = Array.isArray(p.ops) ? p.ops : [];
  var cache = CacheService.getScriptCache();
  var results = [];

  for (var i = 0; i < ops.length; i++) {
    var op = ops[i] || {};
    var opId = String(op.opId || '').trim();
    var type = String(op.type || '').trim();
    var data = op.payload || op.data || {};
    if (opId) {
      var prev = cache.get('OP5_' + opId);
      if (prev) {
        try {
          var parsedPrev = JSON.parse(prev);
          parsedPrev.duplicateOp = true;
          results.push(parsedPrev);
          continue;
        } catch (e) {}
      }
    }

    var res = executeOutboxOp_(opId, type, data, session);
    if (opId && (res.ok || res.status === 'stale')) {
      try { cache.put('OP5_' + opId, JSON.stringify(res), OP_CACHE_TTL_SEC); } catch (e) {}
    }
    results.push(res);
  }

  return json_({
    ok: true,
    version: APP_VERSION,
    serverTime: new Date().toISOString(),
    results: results
  });
}

function executeOutboxOp_(opId, type, data, session) {
  try {
    if (!hasActionPermission_(session.role, type)) {
      return { opId: opId, ok: false, retryable: false, status: 'forbidden', message: 'Role ' + session.role + ' tidak punya izin untuk ' + type };
    }
    var rawOut;
    if (type === 'upsertTemplate' || type === 'addTemplate') rawOut = upsertTemplateCore_(data, session);
    else if (type === 'updateTemplate') rawOut = updateTemplateCore_(data, session);
    else if (type === 'softDeleteTemplate' || type === 'deleteTemplate') rawOut = softDeleteTemplateCore_(data, session);
    else if (type === 'distributeTemplate') rawOut = distributeTemplateCore_(data, session);
    else if (type === 'moveTemplate') rawOut = moveTemplateCore_(data, session);
    else if (type === 'upsertStorage' || type === 'addStorage') rawOut = upsertStorageCore_(data, session);
    else if (type === 'softDeleteStorage' || type === 'deleteStorage') rawOut = softDeleteStorageCore_(data, session);
    else if (type === 'bulkImportExisting') rawOut = bulkImportExistingCore_(data, session);
    else if (type === 'uploadSketch') rawOut = uploadSketchCore_(data, session);
    else if (type === 'deleteSketch') rawOut = deleteSketchCore_(data, session);
    else return { opId: opId, ok: false, retryable: false, status: 'unknown', message: 'Tipe outbox tidak dikenal: ' + type };

    rawOut.opId = opId;
    return rawOut;
  } catch (err) {
    return { opId: opId, ok: false, retryable: true, status: 'error', message: String(err && err.message ? err.message : err) };
  }
}

/* ================= CORE DOMAIN LOGIC (LWW + SOFT DELETE + APPEND-ONLY MOVEMENTS) ================= */

function ensureBaseData_() {
  Object.keys(SHEETS).forEach(function (name) { ensureSheet_(name); });
  var nowIso = new Date().toISOString();
  seedIfEmpty_('STORAGES', [
    ['WORKSHOP', 'Workshop / Engraving', 'Workshop', nowIso, nowIso, 'FALSE'],
    ['CNC-MEJA-01', 'Meja CNC 01', 'Area CNC', nowIso, nowIso, 'FALSE'],
    ['CNC-MEJA-02', 'Meja CNC 02', 'Area CNC', nowIso, nowIso, 'FALSE'],
    ['STORAGE-A', 'Storage Template A', 'Storage', nowIso, nowIso, 'FALSE']
  ]);
}

function hydratePartStatuses_(parts, templates) {
  var tMap = {};
  (templates || []).forEach(function (t) { tMap[String(t.id)] = t; });
  (parts || []).forEach(function (p) {
    var st = String(p.status || '').trim().toUpperCase();
    var cs = String(p.currentStorage || '').trim();
    if (st || cs) {
      if (!st && cs) p.status = 'DISTRIBUTED';
      return;
    }
    var t = tMap[String(p.templateId)] || {};
    var parentStatus = String(t.status || '').trim().toUpperCase();
    if (parentStatus === 'DISTRIBUTED') {
      p.status = 'DISTRIBUTED';
      p.currentStorage = t.currentStorage || '';
      p.distributedAt = t.distributedAt || '';
    } else if (parentStatus === 'OUT') {
      p.status = 'OUT';
      p.currentStorage = '';
      p.distributedAt = t.distributedAt || '';
    } else {
      p.status = 'WAITING_DISTRIBUTION';
      p.currentStorage = '';
      p.distributedAt = '';
    }
  });
}

function addTemplate_(p, session) {
  var out = upsertTemplateCore_(p, session);
  out.version = APP_VERSION;
  return json_(out);
}

function upsertTemplateCore_(p, session) {
  var buyer = norm_(p.buyer);
  var stylekp = norm_(p.stylekp);
  var user = String((session && session.username) || p.createdBy || p.user || 'system');
  var parts = normalizeParts_(p.parts);
  var sketches = normalizeSketchList_(p);
  if (sketches.length) validateSketchList_(sketches);
  if (!buyer || !stylekp || !parts.length) {
    return { ok: false, retryable: false, message: 'Buyer, Style/KP, dan minimal 1 part wajib diisi.' };
  }

  var templateId = String(p.id || p.templateId || id_('TPL')).trim();
  var nowIso = toIso_(p.updatedAt) || new Date().toISOString();
  var createdIso = toIso_(p.createdAt) || nowIso;

  var existing = findRow_('TEMPLATES', 'id', templateId);
  if (existing) {
    // Aturan konflik: update terbaru menang (LWW berdasarkan updatedAt)
    if (parseTimeMs_(existing.updatedAt) > parseTimeMs_(nowIso)) {
      return {
        ok: true,
        status: 'stale',
        message: 'Server memiliki versi template yang lebih baru (update terbaru menang).',
        template: cleanTemplateRow_(existing)
      };
    }
    update_('TEMPLATES', existing._row, {
      buyer: buyer,
      stylekp: stylekp,
      status: String(p.status || existing.status || 'WAITING_DISTRIBUTION').toUpperCase(),
      currentStorage: p.currentStorage != null ? String(p.currentStorage) : existing.currentStorage,
      updatedAt: nowIso,
      deleted: isTrue_(p.deleted) ? 'TRUE' : 'FALSE'
    });
    if (parts.length) {
      replaceTemplatePartsLww_(templateId, parts, nowIso);
    }
    if (sketches.length) saveSketchesForTemplate_(templateId, sketches);
    var latestParts = read_('TEMPLATE_PARTS').filter(function (pp) { return String(pp.templateId) === templateId; });
    return { ok: true, status: 'applied', id: templateId, template: cleanTemplateRow_(findRow_('TEMPLATES', 'id', templateId)), parts: latestParts, message: 'Template diperbarui.' };
  }

  // Anti-duplikat otomatis untuk template baru (hanya cek template aktif yang tidak dihapus)
  var duplicate = findExistingTemplateByKey_(buyer, stylekp, parts);
  if (duplicate) {
    return {
      ok: false,
      retryable: false,
      duplicate: true,
      message: 'Anti duplicate aktif: Template dengan Buyer + Style/KP + Part yang sama sudah ada. ID: ' + duplicate.id,
      existing: { id: duplicate.id, buyer: duplicate.buyer, stylekp: duplicate.stylekp, status: duplicate.status, currentStorage: duplicate.currentStorage }
    };
  }

  var tplStatus = String(p.status || 'WAITING_DISTRIBUTION').toUpperCase();
  var tplStorage = String(p.currentStorage || '');
  append_('TEMPLATES', {
    id: templateId,
    buyer: buyer,
    stylekp: stylekp,
    status: tplStatus,
    currentStorage: tplStorage,
    sketch: sketches.length ? 'DRIVE' : '',
    createdBy: user,
    createdAt: createdIso,
    updatedAt: nowIso,
    distributedAt: toIso_(p.distributedAt) || '',
    deleted: 'FALSE'
  });

  var partRows = parts.map(function (x) {
    return {
      partId: String(x.partId || id_('PRT')),
      templateId: templateId,
      part: norm_(x.part),
      size: norm_(x.size),
      qty: Math.max(1, Math.round(Number(x.qty || 1))),
      createdAt: toIso_(x.createdAt) || createdIso,
      status: String(x.status || tplStatus || 'WAITING_DISTRIBUTION').toUpperCase(),
      currentStorage: norm_(x.currentStorage || tplStorage || ''),
      distributedAt: toIso_(x.distributedAt) || '',
      updatedAt: toIso_(x.updatedAt) || nowIso,
      deleted: 'FALSE'
    };
  });
  appendRows_('TEMPLATE_PARTS', partRows);
  if (sketches.length) saveSketchesForTemplate_(templateId, sketches);

  var lite = {
    id: templateId,
    buyer: buyer,
    stylekp: stylekp,
    status: tplStatus,
    currentStorage: tplStorage,
    createdBy: user,
    createdAt: createdIso,
    updatedAt: nowIso,
    distributedAt: toIso_(p.distributedAt) || '',
    hasSketch: sketches.length > 0,
    sketchCount: sketches.length,
    deleted: false
  };
  return { ok: true, status: 'applied', id: templateId, template: lite, parts: partRows, message: 'Template tersimpan.' };
}

function updateTemplate_(p, session) {
  var out = updateTemplateCore_(p, session);
  out.version = APP_VERSION;
  return json_(out);
}

function updateTemplateCore_(p, session) {
  var id = String(p.id || p.templateId || '').trim();
  if (!id) return { ok: false, retryable: false, message: 'Template ID wajib.' };
  var role = String((session && session.role) || p.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'super_admin') {
    return { ok: false, retryable: false, message: 'Edit template khusus level admin dan super_admin.' };
  }
  var t = findRow_('TEMPLATES', 'id', id);
  if (!t) return { ok: false, retryable: false, message: 'Template tidak ditemukan.' };

  var incomingIso = toIso_(p.updatedAt) || new Date().toISOString();
  if (parseTimeMs_(t.updatedAt) > parseTimeMs_(incomingIso)) {
    return { ok: true, status: 'stale', template: cleanTemplateRow_(t), message: 'Server memiliki data lebih baru (update terbaru menang).' };
  }

  var partRows = [];
  if (Array.isArray(p.parts)) {
    var parts = normalizeParts_(p.parts);
    if (!parts.length) return { ok: false, retryable: false, message: 'Minimal 1 part wajib diisi.' };
    partRows = replaceTemplatePartsLww_(id, parts, incomingIso);
  }

  var hasSketch = null;
  var sketchCount = null;
  if (Array.isArray(p.sketches)) {
    validateSketchList_(p.sketches);
    sketchCount = saveSketchesForTemplate_(id, p.sketches);
    hasSketch = sketchCount > 0;
  }

  var patch = { updatedAt: incomingIso };
  if (p.buyer) patch.buyer = norm_(p.buyer);
  if (p.stylekp) patch.stylekp = norm_(p.stylekp);
  if (hasSketch !== null) patch.sketch = hasSketch ? 'DRIVE' : '';
  update_('TEMPLATES', t._row, patch);

  var updatedTpl = cleanTemplateRow_(findRow_('TEMPLATES', 'id', id));
  if (hasSketch !== null) { updatedTpl.hasSketch = hasSketch; updatedTpl.sketchCount = sketchCount; }
  return { ok: true, status: 'applied', template: updatedTpl, parts: partRows.length ? partRows : undefined, message: 'Template berhasil diperbarui.' };
}

function replaceTemplatePartsLww_(templateId, parts, nowIso) {
  var existingParts = read_('TEMPLATE_PARTS').filter(function (pp) { return String(pp.templateId) === String(templateId); });
  var byId = {};
  existingParts.forEach(function (pp) { byId[String(pp.partId)] = pp; });
  var seen = {};
  var toAppend = [];

  parts.forEach(function (x) {
    var pid = String(x.partId || id_('PRT'));
    seen[pid] = true;
    var row = byId[pid];
    var obj = {
      partId: pid,
      templateId: templateId,
      part: norm_(x.part),
      size: norm_(x.size || ''),
      qty: Math.max(1, Math.round(Number(x.qty || 1))),
      createdAt: (row && row.createdAt) || toIso_(x.createdAt) || nowIso,
      status: String(x.status || (row && row.status) || 'WAITING_DISTRIBUTION').toUpperCase(),
      currentStorage: norm_(x.currentStorage != null ? x.currentStorage : ((row && row.currentStorage) || '')),
      distributedAt: toIso_(x.distributedAt != null ? x.distributedAt : ((row && row.distributedAt) || '')),
      updatedAt: nowIso,
      deleted: 'FALSE'
    };
    if (row && row._row) {
      update_('TEMPLATE_PARTS', row._row, obj);
    } else {
      toAppend.push(obj);
    }
  });

  // Soft-delete part lama yang sudah dihapus dari template agar sinkron ke perangkat lain
  existingParts.forEach(function (pp) {
    if (!seen[String(pp.partId)] && !isTrue_(pp.deleted) && pp._row) {
      update_('TEMPLATE_PARTS', pp._row, { deleted: 'TRUE', updatedAt: nowIso });
    }
  });
  if (toAppend.length) appendRows_('TEMPLATE_PARTS', toAppend);
  return read_('TEMPLATE_PARTS').filter(function (pp) { return String(pp.templateId) === String(templateId); });
}

function softDeleteTemplate_(p, session) {
  var out = softDeleteTemplateCore_(p, session);
  out.version = APP_VERSION;
  return json_(out);
}

function softDeleteTemplateCore_(p, session) {
  var id = String(p.id || p.templateId || '').trim();
  if (!id) return { ok: false, retryable: false, message: 'Template ID wajib.' };
  var role = String((session && session.role) || '').toLowerCase();
  if (role !== 'admin' && role !== 'super_admin') {
    return { ok: false, retryable: false, message: 'Hapus template khusus admin dan super_admin.' };
  }
  var t = findRow_('TEMPLATES', 'id', id);
  if (!t) return { ok: true, status: 'applied', id: id, message: 'Template sudah tidak ada.' };

  var incomingIso = toIso_(p.updatedAt) || new Date().toISOString();
  if (parseTimeMs_(t.updatedAt) > parseTimeMs_(incomingIso)) {
    return { ok: true, status: 'stale', template: cleanTemplateRow_(t), message: 'Server memiliki perubahan lebih baru (update terbaru menang).' };
  }

  update_('TEMPLATES', t._row, { deleted: 'TRUE', updatedAt: incomingIso });
  var tParts = read_('TEMPLATE_PARTS').filter(function (pp) { return String(pp.templateId) === id && !isTrue_(pp.deleted); });
  tParts.forEach(function (pp) {
    if (pp._row) update_('TEMPLATE_PARTS', pp._row, { deleted: 'TRUE', updatedAt: incomingIso });
  });
  return { ok: true, status: 'applied', id: id, template: cleanTemplateRow_(findRow_('TEMPLATES', 'id', id)), message: 'Template ditandai terhapus (soft delete).' };
}

function distributeTemplate_(p, session) {
  var out = distributeTemplateCore_(p, session);
  out.version = APP_VERSION;
  return json_(out);
}

function distributeTemplateCore_(p, session) {
  p = p || {};
  var requestId = String(p.requestId || '').trim();
  if (requestId) {
    try {
      var prev = CacheService.getScriptCache().get('DIST_REQ_' + requestId);
      if (prev) {
        var parsedPrev = JSON.parse(prev);
        parsedPrev.duplicateRequest = true;
        return parsedPrev;
      }
    } catch (e) {}
  }

  var storage = norm_(p.storage || p.to);
  var user = String((session && session.username) || p.by || p.user || 'system');
  var baseNote = String(p.note || '').trim() || 'Distribusi template jadi';
  if (!storage) return { ok: false, retryable: false, message: 'Storage tujuan wajib dipilih.' };
  if (storage === 'WORKSHOP') return { ok: false, retryable: false, message: 'Storage tujuan tidak boleh WORKSHOP.' };
  var storageRow = findRow_('STORAGES', 'code', storage);
  if (!storageRow || isTrue_(storageRow.deleted)) {
    return { ok: false, retryable: false, message: 'Storage tujuan belum ada di master: ' + storage };
  }

  var rawItems = Array.isArray(p.items) && p.items.length
    ? p.items
    : [{ templateId: String(p.id || p.templateId || ''), splitParts: p.splitParts, movementId: p.movementId }];
  var items = normalizeDistributionItems_(rawItems);
  if (!items.length) return { ok: false, retryable: false, message: 'Pilih minimal satu template untuk didistribusikan.' };

  var allTemplates = readExcept_('TEMPLATES', ['sketch']).filter(function (t) { return !isTrue_(t.deleted); });
  var templateMap = {};
  allTemplates.forEach(function (t) { templateMap[String(t.id)] = t; });

  var allParts = read_('TEMPLATE_PARTS').filter(function (pp) { return !isTrue_(pp.deleted); });
  hydratePartStatuses_(allParts, allTemplates);
  var partsByTemplate = {};
  allParts.forEach(function (pp) {
    var tid = String(pp.templateId || '');
    if (!partsByTemplate[tid]) partsByTemplate[tid] = [];
    partsByTemplate[tid].push(pp);
  });

  var existingMovIds = {};
  read_('MOVEMENTS').forEach(function (m) { if (m.id) existingMovIds[String(m.id)] = true; });

  // Phase 1: Validasi seluruh item & anti-duplikat otomatis sebelum menulis.
  var plans = [];
  var batchSignatureMap = {};
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var tid = item.templateId;
    var t = templateMap[tid];
    if (!t) return { ok: false, retryable: false, message: 'Template tidak ditemukan: ' + tid };

    // Jika movementId dari klien sudah tercatat, anggap op sudah pernah diterapkan (idempoten).
    if (item.movementId && existingMovIds[String(item.movementId)]) {
      continue;
    }

    var tParts = partsByTemplate[tid] || [];
    var waitingParts = tParts.filter(isPartWaiting_);
    var requestedSplits = item.splitParts;

    if (!tParts.length) {
      if (String(t.status || '').toUpperCase() === 'DISTRIBUTED' && norm_(t.currentStorage) === storage) {
        return { ok: false, retryable: false, duplicate: true, message: 'Anti duplicate aktif: Template ' + tid + ' sudah berada di storage ' + storage + '.' };
      }
      if (String(t.status || '').toUpperCase() !== 'WAITING_DISTRIBUTION') {
        return { ok: false, retryable: false, message: 'Template ' + tid + ' tidak berstatus WAITING_DISTRIBUTION.' };
      }
      plans.push({ template: t, tParts: [], splits: [], splitSummary: [], movementId: item.movementId });
      continue;
    }

    if (!waitingParts.length) {
      return { ok: false, retryable: false, message: 'Template ' + t.buyer + ' · ' + t.stylekp + ' (' + tid + ') tidak memiliki part berstatus WAITING_DISTRIBUTION.' };
    }

    if (!requestedSplits.length) {
      requestedSplits = waitingParts.map(function (pp) {
        return { partId: String(pp.partId || ''), part: norm_(pp.part), size: norm_(pp.size || ''), qty: Math.max(1, Math.round(Number(pp.qty || 1))), newPartId: '' };
      });
    }

    var usedByRow = {};
    var resolvedSplits = [];
    for (var j = 0; j < requestedSplits.length; j++) {
      var sp = requestedSplits[j];
      var partRow = findPartRowForSplit_(tid, sp, waitingParts, usedByRow);
      if (!partRow || !partRow._row || !isPartWaiting_(partRow)) {
        return { ok: false, retryable: false, message: 'Part "' + (sp.part || sp.partId) + '" pada template ' + tid + ' tidak ditemukan atau sudah terdistribusi.' };
      }
      var maxQty = Math.max(1, Math.round(Number(partRow.qty || 1)));
      var alreadyPlanned = usedByRow[partRow._row] || 0;
      var remainAvail = maxQty - alreadyPlanned;
      var reqQty = Math.round(Number(sp.qty || 0));
      if (!isFinite(reqQty) || reqQty < 1) {
        return { ok: false, retryable: false, message: 'Qty distribusi untuk part ' + partRow.part + ' minimal 1.' };
      }
      if (reqQty > remainAvail) {
        return { ok: false, retryable: false, message: 'Qty distribusi part ' + partRow.part + (partRow.size ? ' [' + partRow.size + ']' : '') + ' (' + reqQty + ') melebihi sisa waiting (' + remainAvail + ').' };
      }
      usedByRow[partRow._row] = alreadyPlanned + reqQty;
      var existingPlan = resolvedSplits.find(function (x) { return x.partRow._row === partRow._row; });
      if (existingPlan) {
        existingPlan.qty += reqQty;
      } else {
        resolvedSplits.push({ partRow: partRow, maxQty: maxQty, qty: reqQty, newPartId: sp.newPartId || '' });
      }
    }

    if (!resolvedSplits.length) {
      return { ok: false, retryable: false, message: 'Tidak ada part waiting yang dipilih untuk distribusi pada template ' + tid + '.' };
    }

    var splitSummary = resolvedSplits.map(function (x) {
      return { part: norm_(x.partRow.part), size: norm_(x.partRow.size || ''), qty: x.qty };
    });
    var plannedKey = partsKey_(splitSummary);
    var buyerNorm = norm_(t.buyer);
    var styleNorm = norm_(t.stylekp);

    var dupTemplate = findDuplicateDistributedInStorage_(allTemplates, partsByTemplate, tid, buyerNorm, styleNorm, plannedKey, storage);
    if (dupTemplate) {
      return {
        ok: false,
        retryable: false,
        duplicate: true,
        existing: { id: dupTemplate.id, buyer: dupTemplate.buyer, stylekp: dupTemplate.stylekp, currentStorage: storage },
        message: 'Anti duplicate aktif: Template dengan Buyer (' + buyerNorm + ') + Style/KP (' + styleNorm + ') + Part yang sama sudah terdistribusi di storage ' + storage + ' (ID: ' + dupTemplate.id + ').'
      };
    }

    var batchSig = buyerNorm + '||' + styleNorm + '||' + plannedKey;
    if (batchSignatureMap[batchSig]) {
      return {
        ok: false,
        retryable: false,
        duplicate: true,
        message: 'Anti duplicate aktif: Terdapat dua template identik (' + buyerNorm + ' · ' + styleNorm + ') dalam satu batch distribusi ke ' + storage + '.'
      };
    }
    batchSignatureMap[batchSig] = tid;

    plans.push({ template: t, tParts: tParts, splits: resolvedSplits, splitSummary: splitSummary, movementId: item.movementId });
  }

  if (!plans.length) {
    return { ok: true, status: 'applied', duplicateRequest: true, message: 'Distribusi sudah tercatat sebelumnya.' };
  }

  // Phase 2: Eksekusi update -> append -> soft-delete (tanpa deleteRow agar sync delta menyebarkan perubahan part yang ter-merge!)
  var nowIso = toIso_(p.updatedAt) || new Date().toISOString();
  var newPartRows = [];

  plans.forEach(function (plan) {
    var t = plan.template;
    var tid = String(t.id);
    var existingDistByKey = {};
    plan.tParts.forEach(function (pp) {
      if (isPartDistributed_(pp) && norm_(pp.currentStorage) === storage) {
        var k = norm_(pp.part) + '||' + norm_(pp.size || '');
        if (!existingDistByKey[k]) existingDistByKey[k] = pp;
      }
    });

    plan.splits.forEach(function (sp) {
      var partRow = sp.partRow;
      var maxQty = sp.maxQty;
      var qty = sp.qty;
      var partKey = norm_(partRow.part) + '||' + norm_(partRow.size || '');
      var existingDist = existingDistByKey[partKey];

      if (existingDist) {
        var mergedQty = Math.max(1, Number(existingDist.qty || 0)) + qty;
        if (existingDist._row) {
          update_('TEMPLATE_PARTS', existingDist._row, { qty: mergedQty, status: 'DISTRIBUTED', currentStorage: storage, distributedAt: nowIso, updatedAt: nowIso, deleted: 'FALSE' });
        }
        existingDist.qty = mergedQty;
        if (qty >= maxQty) {
          // Soft-delete baris waiting yang sudah digabung penuh agar perangkat lain ikut menghapusnya saat delta sync
          update_('TEMPLATE_PARTS', partRow._row, { deleted: 'TRUE', updatedAt: nowIso });
        } else {
          update_('TEMPLATE_PARTS', partRow._row, { qty: maxQty - qty, status: 'WAITING_DISTRIBUTION', currentStorage: '', distributedAt: '', updatedAt: nowIso, deleted: 'FALSE' });
          partRow.qty = maxQty - qty;
        }
      } else if (qty >= maxQty) {
        update_('TEMPLATE_PARTS', partRow._row, { qty: qty, status: 'DISTRIBUTED', currentStorage: storage, distributedAt: nowIso, updatedAt: nowIso, deleted: 'FALSE' });
        partRow.status = 'DISTRIBUTED';
        partRow.currentStorage = storage;
        partRow.qty = qty;
        existingDistByKey[partKey] = partRow;
      } else {
        update_('TEMPLATE_PARTS', partRow._row, { qty: maxQty - qty, status: 'WAITING_DISTRIBUTION', currentStorage: '', distributedAt: '', updatedAt: nowIso, deleted: 'FALSE' });
        partRow.qty = maxQty - qty;
        var distributedRow = {
          partId: sp.newPartId || id_('PRT'),
          templateId: tid,
          part: norm_(partRow.part),
          size: norm_(partRow.size || ''),
          qty: qty,
          createdAt: toIso_(partRow.createdAt) || nowIso,
          status: 'DISTRIBUTED',
          currentStorage: storage,
          distributedAt: nowIso,
          updatedAt: nowIso,
          deleted: 'FALSE'
        };
        newPartRows.push(distributedRow);
        existingDistByKey[partKey] = distributedRow;
      }
    });
  });

  if (newPartRows.length) appendRows_('TEMPLATE_PARTS', newPartRows);

  // Phase 3: Hitung ulang status & lokasi dari TEMPLATE_PARTS aktif terbaru.
  var refreshedParts = read_('TEMPLATE_PARTS');
  var updatedTemplates = [];
  var updatedPartsByTemplate = {};
  var movements = [];
  var anyPartial = false;

  plans.forEach(function (plan) {
    var t = plan.template;
    var tid = String(t.id);
    var tAllParts = refreshedParts.filter(function (pp) { return String(pp.templateId) === tid; });
    var tActiveParts = tAllParts.filter(function (pp) { return !isTrue_(pp.deleted); });
    var remainingWaiting = tActiveParts.some(isPartWaiting_);
    var distStorages = unique_(tActiveParts.filter(isPartDistributed_).map(function (pp) { return pp.currentStorage; }));
    var newStatus = tActiveParts.length
      ? (remainingWaiting ? 'WAITING_DISTRIBUTION' : (distStorages.length ? 'DISTRIBUTED' : (tActiveParts.some(isPartOut_) ? 'OUT' : 'DISTRIBUTED')))
      : 'DISTRIBUTED';
    var newStorage = tActiveParts.length ? distStorages.join(', ') : storage;
    var newDistributedAt = toIso_(t.distributedAt) || nowIso;
    if (remainingWaiting) anyPartial = true;

    update_('TEMPLATES', t._row, { status: newStatus, currentStorage: newStorage, updatedAt: nowIso, distributedAt: newDistributedAt });
    var updatedTpl = { id: tid, status: newStatus, currentStorage: newStorage, updatedAt: nowIso, distributedAt: newDistributedAt, deleted: false };
    updatedTemplates.push(updatedTpl);
    updatedPartsByTemplate[tid] = tAllParts.map(cleanPartRow_);

    var note = baseNote;
    if (plan.splitSummary.length) {
      var splitText = plan.splitSummary.map(function (x) {
        return norm_(x.part) + (x.size ? ' [' + norm_(x.size) + ']' : '') + ' x' + Math.max(1, Number(x.qty || 1));
      }).join(', ');
      if (splitText && String(note).indexOf('Split Part/Size/Qty:') < 0) note += ' | Split Part/Size/Qty: ' + splitText;
    }
    var movId = plan.movementId || id_('MOV');
    if (!existingMovIds[movId]) {
      existingMovIds[movId] = true;
      movements.push({ id: movId, templateId: tid, type: 'DISTRIBUTE', from: 'WORKSHOP', to: storage, by: user, note: note, at: nowIso });
    }
  });

  if (movements.length) appendRows_('MOVEMENTS', movements);

  var firstTpl = updatedTemplates[0] || null;
  var firstParts = firstTpl ? (updatedPartsByTemplate[firstTpl.id] || []) : [];
  var firstMov = movements[0] || null;
  var msg = updatedTemplates.length > 1
    ? (anyPartial
      ? ('Distribusi ' + updatedTemplates.length + ' template ke ' + storage + ' tersimpan (sebagian split, sisa tetap waiting).')
      : (updatedTemplates.length + ' template berhasil didistribusikan ke ' + storage + '.'))
    : (anyPartial
      ? ('Distribusi split ke ' + storage + ' tersimpan. Part yang belum dipilih tetap waiting.')
      : ('Template berhasil didistribusikan ke ' + storage + '.'));

  var result = {
    ok: true,
    status: 'applied',
    template: firstTpl,
    templates: updatedTemplates,
    parts: firstParts,
    partsByTemplate: updatedPartsByTemplate,
    movement: firstMov,
    movements: movements,
    partial: anyPartial,
    distributedCount: updatedTemplates.length,
    message: msg
  };

  if (requestId) {
    try { CacheService.getScriptCache().put('DIST_REQ_' + requestId, JSON.stringify(result), 300); } catch (e) {}
  }
  return result;
}

function moveTemplate_(p, session) {
  var out = moveTemplateCore_(p, session);
  out.version = APP_VERSION;
  return json_(out);
}

function moveTemplateCore_(p, session) {
  var id = String(p.id || p.templateId || '').trim();
  var type = String(p.type || 'TRANSFER').toUpperCase();
  var user = String((session && session.username) || p.by || p.user || 'system');
  var t = findRow_('TEMPLATES', 'id', id);
  if (!t || isTrue_(t.deleted)) return { ok: false, retryable: false, message: 'Template tidak ditemukan.' };

  var from = norm_(p.from || t.currentStorage || '');
  var to = type === 'OUT' ? '' : norm_(p.to);
  if (type !== 'OUT' && !to) return { ok: false, retryable: false, message: 'Storage tujuan wajib diisi.' };
  if (type !== 'OUT' && to) {
    var stRow = findRow_('STORAGES', 'code', to);
    if (!stRow || isTrue_(stRow.deleted)) return { ok: false, retryable: false, message: 'Storage tujuan belum ada di master.' };
  }

  if (type !== 'OUT' && from && from === to) {
    return { ok: true, status: 'applied', noChange: true, template: cleanTemplateRow_(t), message: 'Anti duplicate aktif: Storage asal dan tujuan sama.' };
  }

  var movId = String(p.movementId || id_('MOV'));
  if (findRow_('MOVEMENTS', 'id', movId)) {
    return { ok: true, status: 'applied', duplicateRequest: true, template: cleanTemplateRow_(t), message: 'Movement sudah tercatat sebelumnya.' };
  }

  var nowIso = toIso_(p.updatedAt) || new Date().toISOString();
  var tParts = read_('TEMPLATE_PARTS').filter(function (pp) { return String(pp.templateId) === id && !isTrue_(pp.deleted); });
  hydratePartStatuses_(tParts, [t]);

  if (tParts.length) {
    var matchingParts = from
      ? tParts.filter(function (pp) { return isPartDistributed_(pp) && norm_(pp.currentStorage) === from; })
      : tParts.filter(isPartDistributed_);
    if (!matchingParts.length) matchingParts = tParts.filter(isPartDistributed_);

    var destByKey = {};
    if (type !== 'OUT') {
      tParts.forEach(function (pp) {
        if (isPartDistributed_(pp) && norm_(pp.currentStorage) === to) {
          var k = norm_(pp.part) + '||' + norm_(pp.size || '');
          if (!destByKey[k]) destByKey[k] = pp;
        }
      });
    }

    matchingParts.forEach(function (pp) {
      if (!pp._row) return;
      if (type === 'OUT') {
        update_('TEMPLATE_PARTS', pp._row, { status: 'OUT', currentStorage: '', updatedAt: nowIso });
      } else {
        var k = norm_(pp.part) + '||' + norm_(pp.size || '');
        var dest = destByKey[k];
        if (dest && dest._row && dest._row !== pp._row) {
          var mergedQty = Math.max(1, Number(dest.qty || 0)) + Math.max(1, Number(pp.qty || 1));
          update_('TEMPLATE_PARTS', dest._row, { qty: mergedQty, status: 'DISTRIBUTED', currentStorage: to, updatedAt: nowIso });
          dest.qty = mergedQty;
          update_('TEMPLATE_PARTS', pp._row, { deleted: 'TRUE', updatedAt: nowIso });
        } else {
          update_('TEMPLATE_PARTS', pp._row, { status: 'DISTRIBUTED', currentStorage: to, updatedAt: nowIso });
          destByKey[k] = pp;
        }
      }
    });
  }

  var allPartsAfter = read_('TEMPLATE_PARTS').filter(function (pp) { return String(pp.templateId) === id; });
  var activePartsAfter = allPartsAfter.filter(function (pp) { return !isTrue_(pp.deleted); });
  var newStatus = type === 'OUT' ? 'OUT' : 'DISTRIBUTED';
  var newStorage = type === 'OUT' ? '' : to;
  if (activePartsAfter.length) {
    var remainingWaiting = activePartsAfter.some(isPartWaiting_);
    var distStorages = unique_(activePartsAfter.filter(isPartDistributed_).map(function (pp) { return pp.currentStorage; }));
    newStatus = remainingWaiting ? 'WAITING_DISTRIBUTION' : (distStorages.length ? 'DISTRIBUTED' : 'OUT');
    newStorage = distStorages.join(', ');
  }

  update_('TEMPLATES', t._row, { status: newStatus, currentStorage: newStorage, updatedAt: nowIso });
  var movement = { id: movId, templateId: id, type: type, from: from, to: to, by: user, note: String(p.note || ''), at: nowIso };
  append_('MOVEMENTS', movement);
  var template = { id: id, status: newStatus, currentStorage: newStorage, updatedAt: nowIso, deleted: false };
  return { ok: true, status: 'applied', template: template, parts: allPartsAfter.map(cleanPartRow_), movement: movement, message: 'Movement tersimpan.' };
}

function upsertStorage_(p, session) {
  var out = upsertStorageCore_(p, session);
  out.version = APP_VERSION;
  return json_(out);
}

function upsertStorageCore_(p) {
  var code = norm_(p.code);
  var name = String(p.name || '').trim();
  var area = String(p.area || '').trim();
  if (!code || !name) return { ok: false, retryable: false, message: 'Kode dan nama storage wajib.' };

  var nowIso = toIso_(p.updatedAt) || new Date().toISOString();
  var createdIso = toIso_(p.createdAt) || nowIso;
  var existing = findRow_('STORAGES', 'code', code);

  if (existing) {
    if (parseTimeMs_(existing.updatedAt) > parseTimeMs_(nowIso)) {
      return { ok: true, status: 'stale', storage: cleanStorageRow_(existing), message: 'Server memiliki versi storage yang lebih baru.' };
    }
    update_('STORAGES', existing._row, { name: name, area: area, updatedAt: nowIso, deleted: isTrue_(p.deleted) ? 'TRUE' : 'FALSE' });
    return { ok: true, status: 'applied', storage: { code: code, name: name, area: area, createdAt: toIso_(existing.createdAt), updatedAt: nowIso, deleted: isTrue_(p.deleted) } };
  }

  var storage = { code: code, name: name, area: area, createdAt: createdIso, updatedAt: nowIso, deleted: 'FALSE' };
  append_('STORAGES', storage);
  storage.deleted = false;
  return { ok: true, status: 'applied', storage: storage };
}

function softDeleteStorage_(p, session) {
  var out = softDeleteStorageCore_(p, session);
  out.version = APP_VERSION;
  return json_(out);
}

function softDeleteStorageCore_(p, session) {
  var code = norm_(p.code);
  if (!code) return { ok: false, retryable: false, message: 'Kode storage wajib.' };
  if (code === 'WORKSHOP') return { ok: false, retryable: false, message: 'Storage WORKSHOP tidak boleh dihapus.' };
  var role = String((session && session.role) || '').toLowerCase();
  if (role !== 'admin' && role !== 'super_admin') {
    return { ok: false, retryable: false, message: 'Hapus storage khusus admin dan super_admin.' };
  }
  var existing = findRow_('STORAGES', 'code', code);
  if (!existing) return { ok: true, status: 'applied', code: code, message: 'Storage sudah tidak ada.' };

  var incomingIso = toIso_(p.updatedAt) || new Date().toISOString();
  if (parseTimeMs_(existing.updatedAt) > parseTimeMs_(incomingIso)) {
    return { ok: true, status: 'stale', storage: cleanStorageRow_(existing), message: 'Server memiliki perubahan storage lebih baru.' };
  }
  update_('STORAGES', existing._row, { deleted: 'TRUE', updatedAt: incomingIso });
  return { ok: true, status: 'applied', storage: cleanStorageRow_(findRow_('STORAGES', 'code', code)), message: 'Storage ditandai terhapus.' };
}

function bulkImportExisting_(p, session) {
  var out = bulkImportExistingCore_(p, session);
  out.version = APP_VERSION;
  return json_(out);
}

function bulkImportExistingCore_(p, session) {
  var rows = Array.isArray(p.rows) ? p.rows : [];
  var user = String((session && session.username) || p.by || p.user || 'import');
  var defaultStorage = norm_(p.defaultStorage || p.storageTarget || p.mainStorage || p.storage || '');
  var forceDefaultStorage = p.forceDefaultStorage === true;
  var createMissingStorage = p.createMissingStorage !== false;
  var errors = [];
  var inserted = 0;
  var updated = 0;
  var nowIso = toIso_(p.updatedAt) || new Date().toISOString();

  var storages = read_('STORAGES').filter(function (s) { return !isTrue_(s.deleted); });
  var storageMap = {};
  storages.forEach(function (s) { if (s.code) storageMap[norm_(s.code)] = true; });

  var templates = readExcept_('TEMPLATES', ['sketch']).filter(function (t) { return !isTrue_(t.deleted); });
  var allParts = read_('TEMPLATE_PARTS').filter(function (pp) { return !isTrue_(pp.deleted); });
  var partsByTemplate = {};
  allParts.forEach(function (pp) {
    var tid = String(pp.templateId || '');
    if (!partsByTemplate[tid]) partsByTemplate[tid] = [];
    partsByTemplate[tid].push(pp);
  });

  var keyMap = {};
  var idMap = {};
  templates.forEach(function (t) {
    idMap[String(t.id)] = t;
    var k = norm_(t.buyer) + '||' + norm_(t.stylekp) + '||' + partsKey_(partsByTemplate[String(t.id)] || []);
    if (!keyMap[k]) keyMap[k] = t;
  });

  var existingMovIds = {};
  read_('MOVEMENTS').forEach(function (m) { if (m.id) existingMovIds[String(m.id)] = true; });

  var storageRows = [];
  var templateRows = [];
  var partRows = [];
  var movementRows = [];

  rows.forEach(function (r, idx) {
    var buyer = norm_(r.buyer);
    var stylekp = norm_(r.stylekp);
    var parts = normalizeParts_(r.parts);
    var rowStorage = norm_(r.storage || r.currentStorage || r.to || '');
    var storage = (forceDefaultStorage && defaultStorage) ? defaultStorage : norm_(rowStorage || defaultStorage);
    var note = String(r.note || 'Update template existing/lapangan');

    if (!buyer || !stylekp || !parts.length) { errors.push('Baris ' + (idx + 1) + ': Buyer/Style/Part wajib'); return; }
    if (!storage) { errors.push('Baris ' + (idx + 1) + ': Storage wajib untuk update lapangan'); return; }

    if (storage && !storageMap[storage]) {
      if (createMissingStorage) {
        storageMap[storage] = true;
        storageRows.push({ code: storage, name: storage, area: 'Import Lapangan', createdAt: nowIso, updatedAt: nowIso, deleted: 'FALSE' });
      } else {
        errors.push('Baris ' + (idx + 1) + ': Storage ' + storage + ' belum ada di master');
        return;
      }
    }

    var key = buyer + '||' + stylekp + '||' + partsKey_(parts);
    var existing = (r.id && idMap[String(r.id)]) || keyMap[key];
    var movId = String(r.movementId || id_('MOV'));

    if (existing) {
      var oldStorage = existing.currentStorage || '';
      update_('TEMPLATES', existing._row, { status: 'DISTRIBUTED', currentStorage: storage, updatedAt: nowIso, distributedAt: toIso_(existing.distributedAt) || nowIso, deleted: 'FALSE' });
      (partsByTemplate[String(existing.id)] || []).forEach(function (pp) {
        if (pp._row) update_('TEMPLATE_PARTS', pp._row, { status: 'DISTRIBUTED', currentStorage: storage, distributedAt: toIso_(pp.distributedAt) || nowIso, updatedAt: nowIso, deleted: 'FALSE' });
      });
      existing.currentStorage = storage;
      existing.status = 'DISTRIBUTED';
      if (!existingMovIds[movId]) {
        existingMovIds[movId] = true;
        movementRows.push({ id: movId, templateId: existing.id, type: 'UPDATE_EXISTING', from: oldStorage || 'LAPANGAN', to: storage, by: user, note: note, at: nowIso });
      }
      updated++;
      return;
    }

    var templateId = String(r.id || id_('TPL'));
    var templateObj = {
      id: templateId,
      buyer: buyer,
      stylekp: stylekp,
      status: 'DISTRIBUTED',
      currentStorage: storage,
      sketch: '',
      createdBy: user,
      createdAt: toIso_(r.createdAt) || nowIso,
      updatedAt: nowIso,
      distributedAt: nowIso,
      deleted: 'FALSE'
    };
    templateRows.push(templateObj);
    parts.forEach(function (x) {
      partRows.push({
        partId: String(x.partId || id_('PRT')),
        templateId: templateId,
        part: norm_(x.part),
        size: norm_(x.size),
        qty: Math.max(1, Math.round(Number(x.qty || 1))),
        createdAt: nowIso,
        status: 'DISTRIBUTED',
        currentStorage: storage,
        distributedAt: nowIso,
        updatedAt: nowIso,
        deleted: 'FALSE'
      });
    });
    if (!existingMovIds[movId]) {
      existingMovIds[movId] = true;
      movementRows.push({ id: movId, templateId: templateId, type: 'IMPORT_EXISTING', from: 'LAPANGAN', to: storage, by: user, note: note, at: nowIso });
    }
    keyMap[key] = templateObj;
    idMap[templateId] = templateObj;
    inserted++;
  });

  appendRows_('STORAGES', storageRows);
  appendRows_('TEMPLATES', templateRows);
  appendRows_('TEMPLATE_PARTS', partRows);
  appendRows_('MOVEMENTS', movementRows);

  return { ok: true, status: 'applied', inserted: inserted, updated: updated, errors: errors, message: 'Update import lapangan selesai.' };
}

function addUser_(p) {
  var username = String(p.username || '').trim().toLowerCase();
  if (!username || !p.password) return json_({ ok: false, version: APP_VERSION, message: 'Username dan password wajib.' });
  if (findRow_('USERS', 'username', username)) return json_({ ok: false, version: APP_VERSION, message: 'Username sudah ada.' });
  validatePassword_(p.password);
  var nowIso = new Date().toISOString();
  var user = {
    username: username,
    password: createPasswordHash_(p.password),
    role: String(p.role || 'operator').toLowerCase(),
    name: String(p.name || username).trim(),
    active: String(p.active || 'TRUE').toUpperCase() === 'FALSE' ? 'FALSE' : 'TRUE',
    createdAt: nowIso,
    updatedAt: nowIso
  };
  append_('USERS', user);
  delete user.password;
  return json_({ ok: true, version: APP_VERSION, user: user });
}

function resetPassword_(p) {
  var r = findRow_('USERS', 'username', String(p.username || '').trim().toLowerCase());
  if (!r) return json_({ ok: false, version: APP_VERSION, message: 'User tidak ditemukan.' });
  validatePassword_(p.password);
  update_('USERS', r._row, { password: createPasswordHash_(p.password), updatedAt: new Date().toISOString() });
  return json_({ ok: true, version: APP_VERSION, message: 'Password berhasil direset.' });
}

function toggleUserActive_(p) {
  var username = String(p.username || '').trim().toLowerCase();
  var r = findRow_('USERS', 'username', username);
  if (!r) return json_({ ok: false, version: APP_VERSION, message: 'User tidak ditemukan.' });
  var active = p.active === false || String(p.active).toUpperCase() === 'FALSE' ? 'FALSE' : 'TRUE';
  update_('USERS', r._row, { active: active, updatedAt: new Date().toISOString() });
  if (active === 'FALSE') {
    // Cabut semua token perangkat user yang dinonaktifkan
    var sessions = read_('SESSIONS');
    var cache = CacheService.getScriptCache();
    sessions.forEach(function (s) {
      if (String(s.username || '').toLowerCase() === username && !isTrue_(s.revoked)) {
        update_('SESSIONS', s._row, { revoked: 'TRUE', lastSeenAt: new Date().toISOString() });
        try { cache.remove(sessionCacheKey_(s.tokenHash)); } catch (e) {}
      }
    });
  }
  return json_({ ok: true, version: APP_VERSION, username: username, active: active === 'TRUE' });
}

/* ================= SKETCHES (GOOGLE DRIVE PRIVAT) ================= */

function getSketch_(id) {
  id = String(id || '').trim();
  if (!id) return json_({ ok: false, version: APP_VERSION, message: 'ID template wajib.' });
  var legacy = readLegacySketch_(id);
  if (legacy) { saveSketchesForTemplate_(id, [legacy]); clearLegacySketch_(id); }
  var sketches = readSketchesForTemplate_(id);
  if (sketches.length && !hasDriveSketchRef_(id)) {
    saveSketchesForTemplate_(id, sketches);
    var t = findRow_('TEMPLATES', 'id', id);
    if (t) update_('TEMPLATES', t._row, { sketch: 'DRIVE', updatedAt: new Date().toISOString() });
    sketches = readSketchesForTemplate_(id);
  }
  return json_({ ok: true, version: APP_VERSION, id: id, sketches: sketches, sketch: sketches[0] || '' });
}

function uploadSketch_(p, session) {
  var out = uploadSketchCore_(p, session);
  out.version = APP_VERSION;
  return json_(out);
}

function uploadSketchCore_(p) {
  var id = String(p.id || p.templateId || '').trim();
  if (!id) return { ok: false, retryable: false, message: 'Template ID wajib untuk upload sketch.' };
  var t = findRow_('TEMPLATES', 'id', id);
  if (!t || isTrue_(t.deleted)) return { ok: false, retryable: false, message: 'Template tidak ditemukan untuk sketch: ' + id };
  var sketches = normalizeSketchList_(p);
  if (!sketches.length) return { ok: false, retryable: false, message: 'Data gambar sketch kosong.' };
  validateSketchList_(sketches);
  var count = saveSketchesForTemplate_(id, sketches);
  return { ok: true, status: 'applied', id: id, sketchCount: count, hasSketch: count > 0, updatedAt: new Date().toISOString(), message: 'Sketch berhasil diunggah ke Drive.' };
}

function deleteSketch_(p, session) {
  var out = deleteSketchCore_(p, session);
  out.version = APP_VERSION;
  return json_(out);
}

function deleteSketchCore_(p, session) {
  var role = String((session && session.role) || '').toLowerCase();
  if (role !== 'admin' && role !== 'super_admin') {
    return { ok: false, retryable: false, message: 'Hapus sketch khusus admin dan super_admin.' };
  }
  var id = String(p.id || p.templateId || '').trim();
  if (!id) return { ok: false, retryable: false, message: 'Template ID wajib.' };
  deleteSketchChunks_(id);
  var nowIso = new Date().toISOString();
  var t = findRow_('TEMPLATES', 'id', id);
  if (t && t._row) update_('TEMPLATES', t._row, { sketch: '', updatedAt: nowIso });
  return { ok: true, status: 'applied', id: id, hasSketch: false, updatedAt: nowIso, message: 'Sketch dihapus.' };
}

function normalizeSketchList_(p) {
  var list = Array.isArray(p.sketches) ? p.sketches : [];
  if (!list.length && (p.sketch || p.photo)) list = [String(p.sketch || p.photo)];
  return list.map(function (s) { return String(s || ''); }).filter(Boolean);
}

function validateSketchList_(sketches) {
  (sketches || []).forEach(function (s) {
    var m = String(s || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new Error('Format sketch tidak valid. Gunakan JPG/PNG/WebP.');
    if (Utilities.base64Decode(m[2]).length > MAX_SKETCH_BYTES) throw new Error('Ukuran setiap sketch maksimal 1 MB.');
  });
}

function getSketchFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('CNC_SKETCH_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { props.deleteProperty('CNC_SKETCH_FOLDER_ID'); }
  }
  var folder = DriveApp.createFolder('CNC Template Tracker - Sketches');
  props.setProperty('CNC_SKETCH_FOLDER_ID', folder.getId());
  return folder;
}

function fileIdFromRef_(v) {
  v = String(v || '');
  return v.indexOf(DRIVE_REF_PREFIX) === 0 ? v.slice(DRIVE_REF_PREFIX.length) : '';
}

function dataUrlFromDrive_(fileId) {
  var blob = DriveApp.getFileById(fileId).getBlob();
  var bytes = blob.getBytes();
  if (bytes.length > MAX_SKETCH_BYTES) throw new Error('Sketch di Drive melebihi batas 1 MB.');
  return 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(bytes);
}

function hasDriveSketchRef_(templateId) {
  return read_('SKETCHES').some(function (r) {
    return String(r.templateId) === String(templateId) && !isTrue_(r.deleted) && !!fileIdFromRef_(r.chunk);
  });
}

function getActiveSketchMeta_() {
  var out = {};
  read_('SKETCHES').forEach(function (r) {
    if (!r.templateId || isTrue_(r.deleted)) return;
    var tid = String(r.templateId);
    if (!out[tid]) out[tid] = { count: 0, updatedMs: 0 };
    if (Number(r.seq || 0) === 0) out[tid].count++;
    var ms = parseTimeMs_(r.updatedAt);
    if (ms > out[tid].updatedMs) out[tid].updatedMs = ms;
  });
  return out;
}

function saveSketchesForTemplate_(templateId, sketches) {
  sketches = (sketches || []).map(function (s) { return String(s || ''); }).filter(Boolean);
  validateSketchList_(sketches);
  var created = [];
  var nowIso = new Date().toISOString();
  try {
    var folder = getSketchFolder_();
    var rows = [];
    sketches.forEach(function (s, idx) {
      var m = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
      var bytes = Utilities.base64Decode(m[2]);
      var ext = m[1].split('/')[1].replace('jpeg', 'jpg');
      var file = folder.createFile(Utilities.newBlob(bytes, m[1], 'sketch-' + templateId + '-' + (idx + 1) + '.' + ext));
      created.push(file);
      rows.push({ templateId: templateId, idx: idx, seq: 0, chunk: DRIVE_REF_PREFIX + file.getId(), updatedAt: nowIso, deleted: 'FALSE' });
    });
    deleteSketchChunks_(templateId);
    if (rows.length) appendRows_('SKETCHES', rows);
    var t = findRow_('TEMPLATES', 'id', templateId);
    if (t && t._row) update_('TEMPLATES', t._row, { sketch: rows.length ? 'DRIVE' : '', updatedAt: nowIso });
    return rows.length;
  } catch (err) {
    created.forEach(function (f) { try { f.setTrashed(true); } catch (e) {} });
    throw err;
  }
}

function readSketchesForTemplate_(templateId) {
  var rows = read_('SKETCHES').filter(function (r) { return String(r.templateId) === String(templateId) && !isTrue_(r.deleted); });
  var byIdx = {};
  rows.forEach(function (r) {
    var idx = Number(r.idx || 0);
    if (!byIdx[idx]) byIdx[idx] = [];
    byIdx[idx].push({ seq: Number(r.seq || 0), chunk: String(r.chunk || '') });
  });
  return Object.keys(byIdx).map(Number).sort(function (a, b) { return a - b; }).map(function (idx) {
    var chunks = byIdx[idx].sort(function (a, b) { return a.seq - b.seq; });
    if (chunks.length === 1 && fileIdFromRef_(chunks[0].chunk)) return dataUrlFromDrive_(fileIdFromRef_(chunks[0].chunk));
    return chunks.map(function (c) { return c.chunk; }).join('');
  });
}

function deleteSketchChunks_(templateId) {
  var rows = read_('SKETCHES').filter(function (r) { return String(r.templateId) === String(templateId); });
  rows.forEach(function (r) {
    var fid = fileIdFromRef_(r.chunk);
    if (fid) { try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) {} }
  });
  var sh = ensureSheet_('SKETCHES');
  var last = sh.getLastRow();
  if (last <= 1) return;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === String(templateId)) sh.deleteRow(i + 2);
  }
}

function migrateLegacySketchChunksToDrive_() {
  var rows = read_('SKETCHES');
  var ids = {};
  rows.forEach(function (r) { if (r.templateId && !isTrue_(r.deleted)) ids[String(r.templateId)] = true; });
  var migrated = 0;
  Object.keys(ids).forEach(function (id) {
    if (hasDriveSketchRef_(id)) return;
    var images = readSketchesForTemplate_(id);
    if (images.length) {
      saveSketchesForTemplate_(id, images);
      var t = findRow_('TEMPLATES', 'id', id);
      if (t && t._row) update_('TEMPLATES', t._row, { sketch: 'DRIVE', updatedAt: new Date().toISOString() });
      migrated += images.length;
    }
  });
  return migrated;
}

function readLegacySketch_(templateId) {
  var row = findRowNumberByValue_('TEMPLATES', 'id', templateId);
  if (!row) return '';
  var col = colIndex_('TEMPLATES', 'sketch');
  if (!col) return '';
  var value = String(ensureSheet_('TEMPLATES').getRange(row, col).getValue() || '');
  return /^data:image\//i.test(value) ? value : '';
}

function clearLegacySketch_(templateId) {
  var row = findRowNumberByValue_('TEMPLATES', 'id', templateId);
  var col = colIndex_('TEMPLATES', 'sketch');
  if (row && col) ensureSheet_('TEMPLATES').getRange(row, col).setValue('DRIVE');
}

function migrateSketches_() {
  var sh = ensureSheet_('TEMPLATES');
  var last = sh.getLastRow();
  if (last <= 1) return 0;
  var idCol = colIndex_('TEMPLATES', 'id');
  var sketchCol = colIndex_('TEMPLATES', 'sketch');
  if (!idCol || !sketchCol) return 0;
  var ids = sh.getRange(2, idCol, last - 1, 1).getValues();
  var migrated = 0;
  for (var i = 0; i < ids.length; i++) {
    var templateId = ids[i][0];
    if (!templateId) continue;
    var sketch = String(sh.getRange(i + 2, sketchCol).getValue() || '');
    if (/^data:image\//i.test(sketch)) {
      saveSketchesForTemplate_(templateId, [sketch]);
      sh.getRange(i + 2, sketchCol).setValue('DRIVE');
      migrated++;
    }
  }
  return migrated;
}

/* ================= FILTER MOVEMENTS ================= */

function filterMovements_(p) {
  p = p || {};
  var from = p.from ? new Date(p.from) : null;
  var to = p.to ? new Date(p.to) : null;
  var type = norm_(p.type || '');
  var storage = norm_(p.storage || '');
  var templateId = String(p.templateId || '').trim();
  var q = String(p.q || '').trim().toUpperCase();
  var limit = Math.max(1, Math.min(2000, Number(p.limit || 500)));
  if (to) { to = new Date(to.getTime()); to.setHours(23, 59, 59, 999); }

  var movements = read_('MOVEMENTS');
  var templates = readExcept_('TEMPLATES', ['sketch']);
  var tMap = {};
  templates.forEach(function (t) { tMap[String(t.id)] = t; });

  var rows = movements.filter(function (m) {
    var at = m.at ? new Date(m.at) : null;
    if (from && (!at || at < from)) return false;
    if (to && (!at || at > to)) return false;
    if (type && norm_(m.type) !== type) return false;
    if (storage && norm_(m.from) !== storage && norm_(m.to) !== storage) return false;
    if (templateId && String(m.templateId) !== templateId) return false;
    if (q) {
      var t = tMap[String(m.templateId)] || {};
      var hay = [m.type, m.from, m.to, m.by, m.note, m.templateId, t.buyer, t.stylekp].join(' ').toUpperCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });

  rows.sort(function (a, b) { return parseTimeMs_(b.at) - parseTimeMs_(a.at); });
  var total = rows.length;
  rows = rows.slice(0, limit).map(function (m) {
    var t = tMap[String(m.templateId)] || {};
    return { id: m.id, templateId: m.templateId, type: m.type, from: m.from, to: m.to, by: m.by, note: m.note, at: toIso_(m.at), buyer: t.buyer || '', stylekp: t.stylekp || '' };
  });
  return json_({ ok: true, version: APP_VERSION, total: total, returned: rows.length, movements: rows });
}

/* ================= PART / SPLIT / ANTI-DUPLICATE HELPERS ================= */

function isPartWaiting_(p) {
  if (!p || isTrue_(p.deleted)) return false;
  var st = String(p.status || '').trim().toUpperCase();
  return st !== 'DISTRIBUTED' && st !== 'OUT' && !String(p.currentStorage || '').trim();
}

function isPartDistributed_(p) {
  if (!p || isTrue_(p.deleted)) return false;
  return String(p.status || '').trim().toUpperCase() === 'DISTRIBUTED' && !!String(p.currentStorage || '').trim();
}

function isPartOut_(p) {
  if (!p || isTrue_(p.deleted)) return false;
  return String(p.status || '').trim().toUpperCase() === 'OUT';
}

function normalizeDistributionItems_(rawItems) {
  var byId = {};
  var order = [];
  (rawItems || []).forEach(function (item) {
    if (!item) return;
    var tid = String(item.templateId || item.id || '').trim();
    if (!tid) return;
    var sp = normalizeSplitParts_(item.splitParts);
    if (!byId[tid]) {
      byId[tid] = { templateId: tid, splitParts: sp, movementId: String(item.movementId || '') };
      order.push(tid);
    } else if (sp.length) {
      byId[tid].splitParts = normalizeSplitParts_(byId[tid].splitParts.concat(sp));
    }
  });
  return order.map(function (tid) { return byId[tid]; });
}

function normalizeSplitParts_(rows) {
  if (!Array.isArray(rows)) return [];
  var dedup = {};
  var order = [];
  rows.forEach(function (x) {
    if (!x) return;
    var partId = String(x.partId || '').trim();
    var part = norm_(x.part || x.name);
    var size = norm_(x.size || x.ukuran || '');
    var qty = Math.round(Number(x.qty || 0));
    if (!partId && !part) return;
    if (!isFinite(qty) || qty < 1) qty = 1;
    var key = partId ? ('ID:' + partId) : ('PS:' + part + '||' + size);
    if (!dedup[key]) {
      dedup[key] = { partId: partId, part: part, size: size, qty: qty, newPartId: String(x.newPartId || '') };
      order.push(key);
    } else {
      dedup[key].qty += qty;
    }
  });
  return order.map(function (k) { return dedup[k]; });
}

function findPartRowForSplit_(templateId, sp, allParts, usedByRow) {
  var rows = allParts || read_('TEMPLATE_PARTS').filter(function (pp) { return String(pp.templateId) === String(templateId) && !isTrue_(pp.deleted); });
  usedByRow = usedByRow || {};
  if (sp.partId) {
    var byId = rows.find(function (pp) { return String(pp.partId) === String(sp.partId); });
    if (byId) return byId;
  }
  return rows.find(function (pp) {
    if (!isPartWaiting_(pp)) return false;
    var maxQty = Math.max(1, Math.round(Number(pp.qty || 1)));
    if ((usedByRow[pp._row] || 0) >= maxQty) return false;
    return norm_(pp.part) === norm_(sp.part) && norm_(pp.size || '') === norm_(sp.size || '');
  });
}

function findDuplicateDistributedInStorage_(allTemplates, partsByTemplate, currentTemplateId, buyerNorm, styleNorm, plannedKey, storage) {
  if (!plannedKey) return null;
  for (var i = 0; i < allTemplates.length; i++) {
    var other = allTemplates[i];
    if (String(other.id) === String(currentTemplateId) || isTrue_(other.deleted)) continue;
    if (norm_(other.buyer) !== buyerNorm || norm_(other.stylekp) !== styleNorm) continue;
    var otherDistInStorage = (partsByTemplate[String(other.id)] || []).filter(function (pp) {
      return isPartDistributed_(pp) && norm_(pp.currentStorage) === storage;
    });
    if (!otherDistInStorage.length) continue;
    if (partsKey_(otherDistInStorage) === plannedKey) return other;
  }
  return null;
}

function findExistingTemplateByKey_(buyer, stylekp, parts) {
  var key = partsKey_(parts);
  var templates = readExcept_('TEMPLATES', ['sketch']).filter(function (t) {
    return !isTrue_(t.deleted) && norm_(t.buyer) === buyer && norm_(t.stylekp) === stylekp;
  });
  if (!templates.length) return null;
  var wanted = {};
  templates.forEach(function (t) { wanted[String(t.id)] = t; });
  var partsByTemplate = {};
  read_('TEMPLATE_PARTS').forEach(function (pp) {
    if (isTrue_(pp.deleted)) return;
    var tid = String(pp.templateId || '');
    if (!wanted[tid]) return;
    if (!partsByTemplate[tid]) partsByTemplate[tid] = [];
    partsByTemplate[tid].push(pp);
  });
  for (var i = 0; i < templates.length; i++) {
    if (partsKey_(partsByTemplate[String(templates[i].id)] || []) === key) return templates[i];
  }
  return null;
}

function partsKey_(parts) {
  var agg = {};
  normalizeParts_(parts).forEach(function (x) {
    var k = norm_(x.part) + '[' + norm_(x.size) + ']';
    agg[k] = (agg[k] || 0) + Math.max(1, Math.round(Number(x.qty || 1)));
  });
  return Object.keys(agg).sort().map(function (k) { return k + '#' + agg[k]; }).join('|');
}

function normalizeParts_(parts) {
  if (typeof parts === 'string') parts = parts.split(/[,/]+/).map(function (x) { return { part: x, qty: 1 }; });
  if (!Array.isArray(parts)) return [];
  return parts.map(function (x) {
    if (typeof x === 'string') return { part: norm_(x), size: '', qty: 1 };
    return {
      part: norm_(x.part || x.name),
      size: norm_(x.size || x.ukuran || ''),
      qty: Math.max(1, Math.round(Number(x.qty || 1))),
      partId: String(x.partId || ''),
      status: x.status,
      currentStorage: x.currentStorage,
      createdAt: x.createdAt,
      distributedAt: x.distributedAt,
      updatedAt: x.updatedAt
    };
  }).filter(function (x) { return x.part; });
}

/* ================= ROW CLEANERS & SHEET IO ================= */

function cleanTemplateRow_(t) {
  if (!t) return null;
  return {
    id: String(t.id || ''),
    buyer: norm_(t.buyer),
    stylekp: norm_(t.stylekp),
    status: String(t.status || 'WAITING_DISTRIBUTION').toUpperCase(),
    currentStorage: String(t.currentStorage || ''),
    hasSketch: String(t.sketch || '').toUpperCase() === 'DRIVE',
    createdBy: String(t.createdBy || ''),
    createdAt: toIso_(t.createdAt),
    updatedAt: toIso_(t.updatedAt || t.createdAt),
    distributedAt: toIso_(t.distributedAt),
    deleted: isTrue_(t.deleted)
  };
}

function cleanPartRow_(pp) {
  return {
    partId: String(pp.partId || ''),
    templateId: String(pp.templateId || ''),
    part: norm_(pp.part),
    size: norm_(pp.size || ''),
    qty: Math.max(1, Math.round(Number(pp.qty || 1))),
    status: String(pp.status || 'WAITING_DISTRIBUTION').toUpperCase(),
    currentStorage: norm_(pp.currentStorage || ''),
    createdAt: toIso_(pp.createdAt),
    distributedAt: toIso_(pp.distributedAt),
    updatedAt: toIso_(pp.updatedAt || pp.createdAt),
    deleted: isTrue_(pp.deleted)
  };
}

function cleanStorageRow_(s) {
  if (!s) return null;
  return {
    code: norm_(s.code),
    name: String(s.name || ''),
    area: String(s.area || ''),
    createdAt: toIso_(s.createdAt),
    updatedAt: toIso_(s.updatedAt || s.createdAt),
    deleted: isTrue_(s.deleted)
  };
}

function getSS_() {
  var id = SPREADSHEET_ID || PropertiesService.getScriptProperties().getProperty('CNC_SPREADSHEET_ID') || '';
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Spreadsheet tidak ditemukan. Gunakan script terikat (Extensions > Apps Script) atau isi SPREADSHEET_ID.');
  }
  return ss;
}

function ensureSheet_(name) {
  var ss = getSS_();
  var sh = ss.getSheetByName(name);
  var headers = SHEETS[name];
  if (!sh) sh = ss.insertSheet(name);
  var lastCol = Math.max(sh.getLastColumn(), headers.length);
  var old = sh.getLastRow() ? sh.getRange(1, 1, 1, lastCol).getValues()[0].slice(0, headers.length).map(String) : [];
  if (old.join('|') !== headers.join('|')) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0f766e').setFontColor('#fff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function seedIfEmpty_(name, rows) {
  var sh = ensureSheet_(name);
  if (sh.getLastRow() <= 1) sh.getRange(2, 1, rows.length, SHEETS[name].length).setValues(rows);
}

function read_(name) {
  var sh = ensureSheet_(name);
  var v = sh.getDataRange().getValues();
  if (v.length <= 1) return [];
  var h = v[0].map(String);
  return v.slice(1).filter(function (r) { return r.join('') !== ''; }).map(function (r, i) {
    var o = { _row: i + 2 };
    h.forEach(function (x, j) { o[x] = r[j]; });
    return o;
  });
}

function readExcept_(name, excludeHeaders) {
  var sh = ensureSheet_(name);
  var headers = SHEETS[name];
  var lastRow = sh.getLastRow();
  if (lastRow <= 1) return [];
  var rowCount = lastRow - 1;
  var ex = {};
  (excludeHeaders || []).forEach(function (x) { ex[x] = true; });
  var out = [];
  for (var r = 0; r < rowCount; r++) out.push({ _row: r + 2 });

  var start = -1;
  for (var i = 0; i <= headers.length; i++) {
    var include = i < headers.length && !ex[headers[i]];
    if (include && start < 0) start = i;
    if ((!include || i === headers.length) && start >= 0) {
      var end = i;
      var vals = sh.getRange(2, start + 1, rowCount, end - start).getValues();
      vals.forEach(function (rowVals, rr) {
        for (var c = 0; c < rowVals.length; c++) out[rr][headers[start + c]] = rowVals[c];
      });
      start = -1;
    }
  }
  return out.filter(function (o) {
    return headers.some(function (h) { return !ex[h] && String(o[h] || '') !== ''; });
  });
}

function append_(name, obj) {
  appendRows_(name, [obj]);
}

function appendRows_(name, rows) {
  if (!rows || !rows.length) return 0;
  var h = SHEETS[name];
  var sh = ensureSheet_(name);
  var values = rows.map(function (obj) { return h.map(function (x) { return obj[x] == null ? '' : obj[x]; }); });
  sh.getRange(sh.getLastRow() + 1, 1, values.length, h.length).setValues(values);
  return values.length;
}

function update_(name, row, obj) {
  var sh = ensureSheet_(name);
  var h = SHEETS[name];
  var old = sh.getRange(row, 1, 1, h.length).getValues()[0];
  sh.getRange(row, 1, 1, h.length).setValues([h.map(function (x, i) { return obj[x] == null ? old[i] : obj[x]; })]);
}

function deleteSheetRows_(sheetName, rowNumbers) {
  var uniqueRows = {};
  (rowNumbers || []).forEach(function (r) { var n = Number(r); if (n > 1) uniqueRows[n] = true; });
  var sorted = Object.keys(uniqueRows).map(Number).sort(function (a, b) { return b - a; });
  if (!sorted.length) return;
  var sh = ensureSheet_(sheetName);
  sorted.forEach(function (row) { sh.deleteRow(row); });
}

function findRow_(name, key, val) {
  return read_(name).find(function (x) { return String(x[key]).toUpperCase() === String(val).toUpperCase(); });
}

function findRowNumberByValue_(name, key, val) {
  var sh = ensureSheet_(name);
  var col = colIndex_(name, key);
  var last = sh.getLastRow();
  if (!col || last <= 1) return 0;
  var vals = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).toUpperCase() === String(val).toUpperCase()) return i + 2;
  }
  return 0;
}

function colIndex_(name, key) {
  return SHEETS[name].indexOf(key) + 1;
}

function isTrue_(v) {
  if (v === true) return true;
  var s = String(v || '').trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'YES';
}

function toIso_(v) {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  var d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function parseTimeMs_(v) {
  if (!v) return 0;
  if (v instanceof Date) return isNaN(v.getTime()) ? 0 : v.getTime();
  var t = Date.parse(String(v));
  return isNaN(t) ? 0 : t;
}

function norm_(v) { return String(v || '').trim().replace(/\s+/g, ' ').toUpperCase(); }
function id_(p) { return p + '-' + Utilities.getUuid().toUpperCase(); }
function unique_(arr) {
  var seen = {};
  return arr.map(norm_).filter(function (x) { if (!x || seen[x]) return false; seen[x] = true; return true; }).sort();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorJson_(err, where) {
  var msg = err && err.stack ? String(err.stack).split('\n').slice(0, 3).join(' | ') : String(err);
  return json_({ ok: false, version: APP_VERSION, where: where, message: msg });
}