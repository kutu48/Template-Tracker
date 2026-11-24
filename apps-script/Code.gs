/**
 * CNC Template Tracker V2 - Cloud Efficient FIX
 * Build: 2026-06-30-v2-cloud-fix-json-speed
 *
 * Perbaikan utama:
 * - Semua endpoint selalu return JSON.
 * - doGet support setup, ping, list, login, getSketch.
 * - doPost support form-urlencoded, JSON body, dan payload.
 * - List data tidak membaca kolom sketch/base64, jadi login/sync lebih cepat.
 * - Sketch disimpan chunk di sheet SKETCHES agar tidak bentrok limit 50.000 karakter per cell Google Sheet.
 * - Distribusi/movement/add storage/add user return data update, frontend tidak wajib sync ulang penuh.
 * - Spreadsheet ID tidak ditanam di source; gunakan script terikat ke Spreadsheet atau konfigurasi sendiri.
 */

const APP_VERSION = '2026-11-sheets-opensheet-drive-authfix';
// Leave blank for a container-bound script. Standalone projects may set the Spreadsheet ID here.
const SPREADSHEET_ID = '';
const MAX_SKETCH_BYTES = 1024 * 1024;
const DRIVE_REF_PREFIX = 'DRIVE_FILE:';
const SKETCH_CHUNK_SIZE = 45000;
const LIST_CACHE_TTL = 120;        // detik, cache list di CacheService
const DEFAULT_SYNC_DAYS = 7;       // sync default hanya movement 1 minggu terakhir
const CACHE_CHUNK_SIZE = 90000;    // CacheService limit 100KB per key
var __JSONP_CALLBACK__ = ''; // dipakai untuk akses dari file:// / APK asset tanpa CORS

const SHEETS = {
  USERS: ['username','password','role','name','active','createdAt','updatedAt'],
  STORAGES: ['code','name','area','createdAt','updatedAt'],
  TEMPLATES: ['id','buyer','stylekp','status','currentStorage','sketch','createdBy','createdAt','updatedAt','distributedAt'],
  TEMPLATE_PARTS: ['partId','templateId','part','size','qty','createdAt','status','currentStorage','distributedAt','updatedAt'],
  MOVEMENTS: ['id','templateId','type','from','to','by','note','at'],
  SKETCHES: ['templateId','idx','seq','chunk','updatedAt']
};

function setup(){
  Object.keys(SHEETS).forEach(function(name){ ensureSheet_(name); });
  ensureBaseData_();
  getSketchFolder_(); // creates/authorizes the private Drive folder on first setup
  var migrated = migrateSketches_();
  var migratedChunks = migrateLegacySketchChunksToDrive_();
  return json_({ok:true, version:APP_VERSION, migratedSketch:migrated, migratedChunks:migratedChunks, message:'Setup selesai. Spreadsheet + Drive siap.'});
}

function doGet(e){
  try{
    e = e || {parameter:{}};
    __JSONP_CALLBACK__ = String((e.parameter && e.parameter.callback) || '').trim();
    var action = String((e.parameter && e.parameter.action) || 'ping').trim();
    if(action === 'setup') return json_({ok:false,message:'Jalankan fungsi setup() satu kali dari Apps Script editor.'});
    if(action === 'ping') return json_({ok:true, now:new Date(), version:APP_VERSION});
    if(action === 'list') { if(!requireSession_(e.parameter.sessionToken,action)) return authError_(); return listCached_(e.parameter.days,e.parameter.since); }
    if(action === 'filterMovements') { if(!requireSession_(e.parameter.sessionToken,action)) return authError_(); return filterMovements_(e.parameter); }
    if(action === 'login') return login_(e.parameter.username,e.parameter.password);
    if(action === 'getSketch') { if(!requireSession_(e.parameter.sessionToken,action)) return authError_(); return getSketch_(e.parameter.id||e.parameter.templateId); }
    if(action === 'listUsers') { var ls=requireSession_(e.parameter.sessionToken,action); if(!ls) return authError_(); if(ls.role!=='super_admin') return json_({ok:false,message:'Khusus super admin'}); return listUsers_(); }
    var payload=parsePayloadParam_(e);
    if(isWriteAction_(action) && !requireSession_(payload.sessionToken,action)) return authError_();
    if(action === 'updateTemplate') payload.role=requireSession_(payload.sessionToken,action).role;
    if(action === 'addTemplate') return withWriteLock_(function(){return addTemplate_(payload);},12000);
    if(action === 'updateTemplate') return withWriteLock_(function(){return updateTemplate_(payload);},12000);
    if(action === 'distributeTemplate') return withWriteLock_(function(){return distributeTemplate_(payload);});
    if(action === 'moveTemplate') return withWriteLock_(function(){return moveTemplate_(payload);});
    if(action === 'bulkImportExisting'||action === 'fieldBulkAddTemplates') return withWriteLock_(function(){return bulkImportExisting_(payload);});
    if(action === 'addStorage') return withWriteLock_(function(){return addStorage_(payload);},12000);
    if(action === 'addUser') return withWriteLock_(function(){return addUser_(payload);});
    if(action === 'resetPassword') return withWriteLock_(function(){return resetPassword_(payload);});
    if(action === 'migrateSketches') return withWriteLock_(function(){return json_({ok:true,migrated:migrateSketches_(),migratedChunks:migrateLegacySketchChunksToDrive_(),version:APP_VERSION});},20000);
    return json_({ok:false,version:APP_VERSION,message:'Action GET tidak dikenal: '+action});
  }catch(err){ return errorJson_(err,'doGet'); }
}

function doPost(e){
  try{
    e=e||{parameter:{}};
    var req=parseRequest_(e), action=String(req.action||'').trim(), payload=req.payload||{};
    if(action==='setup') return json_({ok:false,message:'Jalankan fungsi setup() satu kali dari Apps Script editor.'});
    if(isWriteAction_(action)&&!requireSession_(payload.sessionToken,action)) return authError_();
    if(action==='updateTemplate') payload.role=requireSession_(payload.sessionToken,action).role;
    if(action==='addTemplate') return withWriteLock_(function(){return addTemplate_(payload);},12000);
    if(action==='updateTemplate') return withWriteLock_(function(){return updateTemplate_(payload);},12000);
    if(action==='bulkImportExisting'||action==='fieldBulkAddTemplates') return withWriteLock_(function(){return bulkImportExisting_(payload);},12000);
    if(action==='distributeTemplate') return withWriteLock_(function(){return distributeTemplate_(payload);});
    if(action==='moveTemplate') return withWriteLock_(function(){return moveTemplate_(payload);});
    if(action==='addStorage') return withWriteLock_(function(){return addStorage_(payload);});
    if(action==='addUser') return withWriteLock_(function(){return addUser_(payload);});
    if(action==='resetPassword') return withWriteLock_(function(){return resetPassword_(payload);});
    return json_({ok:false,version:APP_VERSION,message:'Action POST tidak dikenal: '+action});
  }catch(err){return errorJson_(err,'doPost');}
}

function isWriteAction_(action){
  return ['addTemplate','updateTemplate','distributeTemplate','moveTemplate','bulkImportExisting','fieldBulkAddTemplates','addStorage','addUser','resetPassword','migrateSketches'].indexOf(String(action))>=0;
}
function sessionCacheKey_(token){
  var digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(token||''),Utilities.Charset.UTF_8);
  return 'SESSION_'+Utilities.base64EncodeWebSafe(digest).replace(/=+$/,'');
}
function requireSession_(token,action){
  if(!token) return null;
  var raw=CacheService.getScriptCache().get(sessionCacheKey_(token)); if(!raw) return null;
  var session; try{session=JSON.parse(raw);}catch(e){return null;}
  if(action==='addUser'||action==='resetPassword') return session.role==='super_admin'?session:null;
  if(action==='updateTemplate'||action==='migrateSketches') return ['admin','super_admin'].indexOf(session.role)>=0?session:null;
  return session;
}
function authError_(){return json_({ok:false,version:APP_VERSION,message:'Sesi tidak valid/kedaluwarsa atau tidak punya izin. Silakan login ulang.'});}
function listUsers_(){
  var users=read_('USERS').map(function(u){var c={};Object.keys(u).forEach(function(k){if(k!=='password')c[k]=u[k];});return c;});
  return json_({ok:true,version:APP_VERSION,users:users});
}

function withWriteLock_(fn, waitMs){
  var lock = LockService.getScriptLock();
  try{
    if(!lock.tryLock(waitMs || 8000)){
      return json_({ok:false, version:APP_VERSION, message:'Server sedang memproses request lain. Coba klik simpan lagi beberapa detik.'});
    }
    var out = fn();
    bustListCache_(); // setiap write sukses, cache list dihapus agar data selalu fresh
    return out;
  }finally{
    try{ lock.releaseLock(); }catch(e){}
  }
}

/* ================= CACHING (CacheService, chunked) ================= */
function listCacheKey_(days){ return 'LISTV8_' + Number(days || DEFAULT_SYNC_DAYS); }

function listCached_(days, since){
  var serverTime = new Date(); // anchor ditangkap SEBELUM baca sheet manapun (aman: lebih baik sedikit basi drpd kelewat data)
  since = String(since || '').trim();
  if(since) return incrementalData_(since, days, serverTime);

  days = Math.max(1, Math.min(3650, Number(days || DEFAULT_SYNC_DAYS)));
  var cache = CacheService.getScriptCache();
  var key = listCacheKey_(days);
  var cached = cacheGetLarge_(cache, key);
  if(cached){
    try{
      var data = JSON.parse(cached);
      return json_({ok:true, version:APP_VERSION, cached:true, days:days, serverTime:serverTime, data:data});
    }catch(e){ /* cache korup, lanjut baca sheet */ }
  }
  var fresh = getFullData_(days);
  try{ cachePutLarge_(cache, key, JSON.stringify(fresh), LIST_CACHE_TTL); }catch(e){}
  return json_({ok:true, version:APP_VERSION, cached:false, days:days, serverTime:serverTime, data:fresh});
}

/* ============ INCREMENTAL SYNC (hanya kirim baris yang berubah setelah 'since') ============
   Aman dipakai karena TEMPLATES/USERS/STORAGES selalu bump updatedAt tiap ditulis, TEMPLATE_PARTS
   & MOVEMENTS append-only (createdAt/at), dan tidak ada baris yang dihapus di sheet-sheet ini. */
function incrementalData_(since, days, serverTime){
  var sinceDate = new Date(since);
  if(isNaN(sinceDate.getTime())) sinceDate = new Date(0); // since rusak/kosong -> anggap dari awal (fallback aman)

  var templates = readExcept_('TEMPLATES', ['sketch']).filter(function(t){
    var u = t.updatedAt ? new Date(t.updatedAt) : null;
    return u && !isNaN(u) && u > sinceDate;
  });
  if(templates.length){
    var sketchIds = getSketchIdSet_();
    templates.forEach(function(t){
      t.hasSketch = !!sketchIds[String(t.id)];
      if(!t.status) t.status = t.currentStorage ? 'DISTRIBUTED' : 'WAITING_DISTRIBUTION';
    });
  }

  var parts = read_('TEMPLATE_PARTS').filter(function(p){
    var c = p.createdAt ? new Date(p.createdAt) : null;
    var u = p.updatedAt ? new Date(p.updatedAt) : null;
    return (c && !isNaN(c) && c > sinceDate) || (u && !isNaN(u) && u > sinceDate);
  });

  var movements = read_('MOVEMENTS').filter(function(m){
    var a = m.at ? new Date(m.at) : null;
    return a && !isNaN(a) && a > sinceDate;
  });

  var storages = read_('STORAGES').filter(function(s){
    var u = s.updatedAt ? new Date(s.updatedAt) : null;
    return u && !isNaN(u) && u > sinceDate;
  });

  var users = read_('USERS').filter(function(u){
    var d = u.updatedAt ? new Date(u.updatedAt) : null;
    return d && !isNaN(d) && d > sinceDate;
  }).map(function(u){ var c={}; Object.keys(u).forEach(function(k){ if(k!=='password') c[k]=u[k]; }); return c; });

  return json_({
    ok:true, version:APP_VERSION, incremental:true, since:since, serverTime:serverTime,
    data:{templates:templates, parts:parts, movements:movements, storages:storages, users:users}
  });
}

function bustListCache_(){
  try{
    var cache = CacheService.getScriptCache();
    [7,14,30,90,365,3650].forEach(function(d){ cacheRemoveLarge_(cache, listCacheKey_(d)); });
  }catch(e){}
}

function cachePutLarge_(cache, key, str, ttl){
  var parts = [];
  for(var i=0; i<str.length; i += CACHE_CHUNK_SIZE) parts.push(str.slice(i, i+CACHE_CHUNK_SIZE));
  if(parts.length > 9) return; // terlalu besar, skip cache
  var payload = {};
  payload[key+'_n'] = String(parts.length);
  parts.forEach(function(p,idx){ payload[key+'_'+idx] = p; });
  cache.putAll(payload, ttl);
}

function cacheGetLarge_(cache, key){
  var n = cache.get(key+'_n');
  if(!n) return null;
  var count = Number(n);
  var keys = [];
  for(var i=0; i<count; i++) keys.push(key+'_'+i);
  var got = cache.getAll(keys);
  var out = '';
  for(var j=0; j<count; j++){
    var chunk = got[key+'_'+j];
    if(chunk == null) return null;
    out += chunk;
  }
  return out;
}

function cacheRemoveLarge_(cache, key){
  var keys = [key+'_n'];
  for(var i=0; i<10; i++) keys.push(key+'_'+i);
  cache.removeAll(keys);
}

/* ============ FILTER MOVEMENTS (data > 1 minggu lewat sini) ============ */
function filterMovements_(p){
  p = p || {};
  var from = p.from ? new Date(p.from) : null;   // tanggal awal
  var to = p.to ? new Date(p.to) : null;         // tanggal akhir
  var type = norm_(p.type || '');
  var storage = norm_(p.storage || '');
  var templateId = String(p.templateId || '').trim();
  var q = String(p.q || '').trim().toUpperCase();
  var limit = Math.max(1, Math.min(2000, Number(p.limit || 500)));
  if(to){ to = new Date(to.getTime()); to.setHours(23,59,59,999); }

  var movements = read_('MOVEMENTS');
  var templates = readExcept_('TEMPLATES', ['sketch']);
  var tMap = {};
  templates.forEach(function(t){ tMap[String(t.id)] = t; });

  var rows = movements.filter(function(m){
    var at = m.at ? new Date(m.at) : null;
    if(from && (!at || at < from)) return false;
    if(to && (!at || at > to)) return false;
    if(type && norm_(m.type) !== type) return false;
    if(storage && norm_(m.from) !== storage && norm_(m.to) !== storage) return false;
    if(templateId && String(m.templateId) !== templateId) return false;
    if(q){
      var t = tMap[String(m.templateId)] || {};
      var hay = [m.type, m.from, m.to, m.by, m.note, m.templateId, t.buyer, t.stylekp].join(' ').toUpperCase();
      if(hay.indexOf(q) < 0) return false;
    }
    return true;
  });

  rows.sort(function(a,b){ return new Date(b.at||0) - new Date(a.at||0); });
  var total = rows.length;
  rows = rows.slice(0, limit).map(function(m){
    var t = tMap[String(m.templateId)] || {};
    return {id:m.id, templateId:m.templateId, type:m.type, from:m.from, to:m.to, by:m.by, note:m.note, at:m.at, buyer:t.buyer||'', stylekp:t.stylekp||''};
  });
  return json_({ok:true, version:APP_VERSION, total:total, returned:rows.length, movements:rows});
}

function parsePayloadParam_(e){
  var p = (e && e.parameter) || {};
  if(p.payload){
    try{ return JSON.parse(String(p.payload || '{}')); }catch(err){ throw new Error('Payload JSON tidak valid: '+err); }
  }
  return p;
}

function parseRequest_(e){
  var p = e.parameter || {};
  var action = p.action || '';
  var payload = {};

  if(p.payload){
    payload = JSON.parse(p.payload || '{}');
  }else if(e.postData && e.postData.contents){
    var raw = String(e.postData.contents || '');
    var parsed = {};
    if(raw.charAt(0) === '{'){
      parsed = JSON.parse(raw || '{}');
    }else{
      raw.split('&').forEach(function(pair){
        var idx = pair.indexOf('=');
        if(idx < 0) return;
        var k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g,' '));
        var v = decodeURIComponent(pair.slice(idx+1).replace(/\+/g,' '));
        parsed[k] = v;
      });
    }
    action = action || parsed.action || '';
    if(parsed.payload){ payload = JSON.parse(parsed.payload || '{}'); }
    else { payload = parsed; }
  }
  action = action || payload.action || '';
  return {action:action, payload:payload};
}

function ensureBaseData_(){
  Object.keys(SHEETS).forEach(function(name){ ensureSheet_(name); });
  // No default credentials. Add the first super_admin manually to the private USERS tab.
  seedIfEmpty_('STORAGES', [
    ['WORKSHOP','Workshop / Engraving','Workshop',new Date(),new Date()],
    ['CNC-MEJA-01','Meja CNC 01','Area CNC',new Date(),new Date()],
    ['CNC-MEJA-02','Meja CNC 02','Area CNC',new Date(),new Date()],
    ['STORAGE-A','Storage Template A','Storage',new Date(),new Date()]
  ]);
}

function ensureUsers_(){
  ensureSheet_('USERS');
  // User rows are provisioned manually; never seed known default passwords.
}

function hydratePartStatuses_(parts, templates){
  var tMap = {};
  (templates || []).forEach(function(t){ tMap[String(t.id)] = t; });
  (parts || []).forEach(function(p){
    if(p.status || p.currentStorage) return;
    var t = tMap[String(p.templateId)] || {};
    if(String(t.status || '').toUpperCase() === 'DISTRIBUTED' || t.currentStorage){
      p.status = 'DISTRIBUTED';
      p.currentStorage = t.currentStorage || '';
      p.distributedAt = t.distributedAt || '';
    }else{
      p.status = 'WAITING_DISTRIBUTION';
      p.currentStorage = '';
      p.distributedAt = '';
    }
  });
}

function getFullData_(days){
  days = Math.max(1, Math.min(3650, Number(days || DEFAULT_SYNC_DAYS)));
  var templates = readExcept_('TEMPLATES', ['sketch']);
  var users = read_('USERS').map(function(u){ delete u.password; return u; });
  var parts = read_('TEMPLATE_PARTS');
  hydratePartStatuses_(parts, templates);
  var sketchIds = getSketchIdSet_();

  templates.forEach(function(t){
    t.hasSketch = !!sketchIds[String(t.id)];
    if(!t.status) t.status = t.currentStorage ? 'DISTRIBUTED' : 'WAITING_DISTRIBUTION';
  });

  // Sync default hanya movement <= N hari (1 minggu). Data lama diambil lewat filterMovements.
  var cutoff = new Date(Date.now() - days*24*60*60*1000);
  var allMovements = read_('MOVEMENTS');
  var movements = allMovements.filter(function(m){
    var at = m.at ? new Date(m.at) : null;
    return at && !isNaN(at) && at >= cutoff;
  });

  return {
    users: users,
    storages: read_('STORAGES'),
    templates: templates,
    parts: parts,
    movements: movements,
    movementsTotal: allMovements.length,
    movementsDays: days,
    masters: {
      buyers: unique_(templates.map(function(t){return t.buyer}).filter(Boolean)),
      parts: unique_(parts.map(function(p){return p.part}).filter(Boolean))
    }
  };
}

function getSketch_(id){
  id=String(id||'').trim(); if(!id) return json_({ok:false,message:'ID template wajib'});
  var legacy=readLegacySketch_(id);
  if(legacy){saveSketchesForTemplate_(id,[legacy]);clearLegacySketch_(id);}
  var sketches=readSketchesForTemplate_(id);
  if(sketches.length&&!hasDriveSketchRef_(id)){
    saveSketchesForTemplate_(id,sketches);
    var t=findRow_('TEMPLATES','id',id);if(t)update_('TEMPLATES',t._row,{sketch:'DRIVE',updatedAt:new Date()});
    sketches=readSketchesForTemplate_(id);
  }
  return json_({ok:true,version:APP_VERSION,id:id,sketches:sketches,sketch:sketches[0]||''});
}

// Password row lama boleh berupa teks biasa untuk provisioning pertama.
// Setelah login berhasil, login_ menggantinya dengan format sha256$salt$digest.
function validatePassword_(password){
  password=String(password||'');
  if(password.length<10) throw new Error('Password minimal 10 karakter.');
}
function createPasswordHash_(password){
  var salt=Utilities.getUuid().replace(/-/g,'');
  var digest=Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt+':'+String(password||''),
    Utilities.Charset.UTF_8
  );
  return 'sha256$'+salt+'$'+Utilities.base64EncodeWebSafe(digest).replace(/=+$/,'');
}
function verifyPassword_(stored,password){
  stored=String(stored||'');
  password=String(password||'');
  if(!password) return false;
  if(stored.indexOf('sha256$')===0){
    var parts=stored.split('$');
    if(parts.length!==3||!parts[1]||!parts[2]) return false;
    var digest=Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      parts[1]+':'+password,
      Utilities.Charset.UTF_8
    );
    return Utilities.base64EncodeWebSafe(digest).replace(/=+$/,'')===parts[2];
  }
  return stored===password;
}

function login_(username,password){
  ensureUsers_(); username=String(username||'').trim().toLowerCase(); password=String(password||'');
  var u=read_('USERS').find(function(x){return String(x.username).toLowerCase()===username&&String(x.active).toUpperCase()!=='FALSE';});
  if(!u||!verifyPassword_(String(u.password||''),password)) return json_({ok:false,version:APP_VERSION,message:'Username/password salah atau user tidak aktif'});
  if(String(u.password||'').indexOf('sha256$')!==0) update_('USERS',u._row,{password:createPasswordHash_(password),updatedAt:new Date()});
  var sessionToken=Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,'');
  var user={username:u.username,role:u.role||'operator',name:u.name||u.username};
  CacheService.getScriptCache().put(sessionCacheKey_(sessionToken),JSON.stringify(user),21600);
  user.sessionToken=sessionToken;
  return json_({ok:true,version:APP_VERSION,user:user});
}

function addTemplate_(p){
  var buyer = norm_(p.buyer);
  var stylekp = norm_(p.stylekp);
  var user = String(p.createdBy || p.user || 'system');
  var parts = normalizeParts_(p.parts);
  var sketches = normalizeSketchList_(p);
  validateSketchList_(sketches);
  if(!buyer || !stylekp || !parts.length) return json_({ok:false, message:'Buyer, Style/KP, dan minimal 1 part wajib diisi'});

  var duplicate = findExistingTemplateByKey_(buyer, stylekp, parts);
  if(duplicate){
    return json_({ok:false, version:APP_VERSION, duplicate:true, message:'Anti duplicate aktif: Template dengan Buyer + Style/KP + Part yang sama sudah ada. ID: '+duplicate.id, existing:{id:duplicate.id,buyer:duplicate.buyer,stylekp:duplicate.stylekp,status:duplicate.status,currentStorage:duplicate.currentStorage}});
  }

  var templateId = p.id || id_('TPL');
  var now = new Date();
  append_('TEMPLATES', {
    id:templateId,
    buyer:buyer,
    stylekp:stylekp,
    status:'WAITING_DISTRIBUTION',
    currentStorage:'',
    sketch:sketches.length ? 'DRIVE' : '',
    createdBy:user,
    createdAt:p.createdAt || now,
    updatedAt:now,
    distributedAt:''
  });
  var partRows = parts.map(function(x){
    return {partId:x.partId || id_('PRT'), templateId:templateId, part:norm_(x.part), size:norm_(x.size), qty:Number(x.qty || 1), createdAt:now, status:'WAITING_DISTRIBUTION', currentStorage:'', distributedAt:'', updatedAt:now};
  });
  appendRows_('TEMPLATE_PARTS', partRows);
  if(sketches.length) saveSketchesForTemplate_(templateId, sketches);

  var lite = {id:templateId,buyer:buyer,stylekp:stylekp,status:'WAITING_DISTRIBUTION',currentStorage:'',createdBy:user,createdAt:now,updatedAt:now,distributedAt:'',hasSketch:sketches.length>0,sketchCount:sketches.length};
  return json_({ok:true, version:APP_VERSION, id:templateId, template:lite, parts:partRows, message:'Template tersimpan dan menunggu distribusi'});
}

/* Terima payload lama (p.sketch / p.photo tunggal) maupun baru (p.sketches array) supaya kompatibel dua arah */
function normalizeSketchList_(p){
  var list = Array.isArray(p.sketches) ? p.sketches : [];
  if(!list.length && (p.sketch || p.photo)) list = [String(p.sketch || p.photo)];
  return list.map(function(s){ return String(s || ''); }).filter(Boolean);
}

function updateTemplate_(p){
  var id = String(p.id || p.templateId || '');
  if(!id) return json_({ok:false, message:'Template ID wajib'});
  var role = String(p.role || p.userRole || '').toLowerCase();
  if(['admin','super_admin'].indexOf(role) < 0) return json_({ok:false, version:APP_VERSION, message:'Edit Part & Sketch khusus level admin dan superadmin'});
  var t = findRow_('TEMPLATES','id',id);
  if(!t) return json_({ok:false, message:'Template tidak ditemukan'});

  var now = new Date();
  var partRows = [];
  if(Array.isArray(p.parts)){
    var parts = normalizeParts_(p.parts);
    if(!parts.length) return json_({ok:false, message:'Minimal 1 part wajib diisi'});
    deleteTemplateParts_(id);
    partRows = parts.map(function(x){
      return {partId:x.partId || id_('PRT'), templateId:id, part:norm_(x.part), size:norm_(x.size), qty:Number(x.qty || 1), createdAt:now, status:'WAITING_DISTRIBUTION', currentStorage:'', distributedAt:'', updatedAt:now};
    });
    appendRows_('TEMPLATE_PARTS', partRows);
  }

  var hasSketch = null;
  var sketchCount = null;
  if(Array.isArray(p.sketches)){
    validateSketchList_(p.sketches);
    sketchCount = saveSketchesForTemplate_(id, p.sketches);
    hasSketch = sketchCount > 0;
  }

  update_('TEMPLATES', t._row, {updatedAt: now, sketch:hasSketch===null?t.sketch:(hasSketch?'DRIVE':'')});
  var template = {id:id, updatedAt:now};
  if(hasSketch !== null){ template.hasSketch = hasSketch; template.sketchCount = sketchCount; }

  return json_({ok:true, version:APP_VERSION, template:template, parts:partRows.length ? partRows : undefined, message:'Template berhasil diperbarui'});
}

function deleteTemplateParts_(templateId){
  var sh = ensureSheet_('TEMPLATE_PARTS');
  var last = sh.getLastRow();
  if(last <= 1) return;
  var col = colIndex_('TEMPLATE_PARTS','templateId');
  var vals = sh.getRange(2,col,last-1,1).getValues();
  var rows = [];
  vals.forEach(function(r,i){ if(String(r[0]) === String(templateId)) rows.push(i+2); });
  rows.reverse().forEach(function(row){ sh.deleteRow(row); });
}

function bulkImportExisting_(p){
  var rows = Array.isArray(p.rows) ? p.rows : [];
  var user = String(p.by || p.user || 'import');
  var defaultStorage = norm_(p.defaultStorage || p.storageTarget || p.mainStorage || p.storage || '');
  var forceDefaultStorage = p.forceDefaultStorage === true;
  var createMissingStorage = p.createMissingStorage !== false;
  var errors = [];
  var inserted = 0;
  var updated = 0;
  var now = new Date();

  var storages = read_('STORAGES');
  var storageMap = {};
  storages.forEach(function(s){ if(s.code) storageMap[norm_(s.code)] = true; });

  var templates = readExcept_('TEMPLATES', ['sketch']);
  var allParts = read_('TEMPLATE_PARTS');
  var partsByTemplate = {};
  allParts.forEach(function(p){
    var tid = String(p.templateId || '');
    if(!partsByTemplate[tid]) partsByTemplate[tid] = [];
    partsByTemplate[tid].push(p);
  });

  var keyMap = {};
  templates.forEach(function(t){
    var k = norm_(t.buyer) + '||' + norm_(t.stylekp) + '||' + partsKey_(partsByTemplate[String(t.id)] || []);
    if(!keyMap[k]) keyMap[k] = t;
  });

  var storageRows = [];
  var templateRows = [];
  var partRows = [];
  var movementRows = [];

  rows.forEach(function(r, idx){
    var buyer = norm_(r.buyer);
    var stylekp = norm_(r.stylekp);
    var parts = normalizeParts_(r.parts);
    var rowStorage = norm_(r.storage || r.currentStorage || r.to || '');
    var storage = (forceDefaultStorage && defaultStorage) ? defaultStorage : norm_(rowStorage || defaultStorage);
    var note = String(r.note || 'Update template existing/lapangan');

    if(!buyer || !stylekp || !parts.length){ errors.push('Baris '+(idx+1)+': Buyer/Style/Part wajib'); return; }
    if(!storage){ errors.push('Baris '+(idx+1)+': Storage wajib untuk update lapangan'); return; }

    if(storage && !storageMap[storage]){
      if(createMissingStorage){
        storageMap[storage] = true;
        storageRows.push({code:storage, name:storage, area:'Import Lapangan', createdAt:now, updatedAt:now});
      }else{
        errors.push('Baris '+(idx+1)+': Storage '+storage+' belum ada di master'); return;
      }
    }

    var key = buyer + '||' + stylekp + '||' + partsKey_(parts);
    var existing = keyMap[key];
    if(existing){
      var oldStorage = existing.currentStorage || '';
      update_('TEMPLATES', existing._row, {status:'DISTRIBUTED', currentStorage:storage, updatedAt:now, distributedAt:existing.distributedAt || now});
      (partsByTemplate[String(existing.id)] || []).forEach(function(pp){
        if(pp._row) update_('TEMPLATE_PARTS', pp._row, {status:'DISTRIBUTED', currentStorage:storage, distributedAt:pp.distributedAt || now, updatedAt:now});
      });
      existing.currentStorage = storage;
      existing.status = 'DISTRIBUTED';
      movementRows.push({id:id_('MOV'), templateId:existing.id, type:'UPDATE_EXISTING', from:oldStorage || 'LAPANGAN', to:storage, by:user, note:note, at:now});
      updated++;
      return;
    }

    var templateId = r.id || id_('TPL');
    var templateObj = {id:templateId,buyer:buyer,stylekp:stylekp,status:'DISTRIBUTED',currentStorage:storage,sketch:'',createdBy:user,createdAt:r.createdAt || now,updatedAt:now,distributedAt:now};
    templateRows.push(templateObj);
    var normalizedPartRows = parts.map(function(x){
      return {partId:x.partId || id_('PRT'), templateId:templateId, part:norm_(x.part), size:norm_(x.size), qty:Number(x.qty || 1), createdAt:now, status:'DISTRIBUTED', currentStorage:storage, distributedAt:now, updatedAt:now};
    });
    normalizedPartRows.forEach(function(x){ partRows.push(x); });
    movementRows.push({id:id_('MOV'), templateId:templateId, type:'IMPORT_EXISTING', from:'LAPANGAN', to:storage, by:user, note:note, at:now});
    keyMap[key] = templateObj;
    inserted++;
  });

  appendRows_('STORAGES', storageRows);
  appendRows_('TEMPLATES', templateRows);
  appendRows_('TEMPLATE_PARTS', partRows);
  appendRows_('MOVEMENTS', movementRows);

  return json_({ok:true, version:APP_VERSION, inserted:inserted, updated:updated, errors:errors, message:'Update import lapangan selesai'});
}

function distributeTemplate_(p){
  var id = String(p.id || p.templateId || '');
  var storage = norm_(p.storage || p.to);
  var user = String(p.by || p.user || 'system');
  if(!id || !storage) return json_({ok:false, message:'Template dan storage tujuan wajib'});
  var t = findRow_('TEMPLATES','id',id);
  if(!t) return json_({ok:false, message:'Template tidak ditemukan'});
  if(storage && !findRow_('STORAGES','code',storage)) return json_({ok:false, message:'Storage tujuan belum ada di master'});

  var now = new Date();
  var allPartsBefore = read_('TEMPLATE_PARTS').filter(function(pp){ return String(pp.templateId) === String(id); });
  var splitParts = normalizeSplitParts_(p.splitParts);
  // Jika caller lama tidak mengirim splitParts, distribusikan semua part yang masih waiting.
  if(!splitParts.length){
    splitParts = allPartsBefore.filter(isPartWaiting_).map(function(pp){ return {partId:pp.partId, part:pp.part, size:pp.size, qty:Number(pp.qty||1)}; });
  }
  if(allPartsBefore.length && !splitParts.length){
    return json_({ok:false, version:APP_VERSION, message:'Tidak ada part waiting yang dipilih untuk distribusi.'});
  }

  var changedParts = [];
  splitParts.forEach(function(sp){
    var partRow = findPartRowForSplit_(id, sp, allPartsBefore);
    if(!partRow || !partRow._row) return;
    if(!isPartWaiting_(partRow)) return;
    var maxQty = Math.max(1, Number(partRow.qty || 1));
    var qty = Math.max(1, Math.min(maxQty, Number(sp.qty || maxQty)));
    update_('TEMPLATE_PARTS', partRow._row, {qty:qty, status:'DISTRIBUTED', currentStorage:storage, distributedAt:now, updatedAt:now});
    changedParts.push({partId:partRow.partId, templateId:id, part:partRow.part, size:partRow.size, qty:qty, createdAt:partRow.createdAt, status:'DISTRIBUTED', currentStorage:storage, distributedAt:now, updatedAt:now});
    partRow.status = 'DISTRIBUTED'; partRow.currentStorage = storage; partRow.qty = qty;
    if(qty < maxQty){
      var remain = {partId:id_('PRT'), templateId:id, part:partRow.part, size:partRow.size, qty:maxQty-qty, createdAt:partRow.createdAt || now, status:'WAITING_DISTRIBUTION', currentStorage:'', distributedAt:'', updatedAt:now};
      append_('TEMPLATE_PARTS', remain);
      changedParts.push(remain);
      allPartsBefore.push(remain);
    }
  });

  if(allPartsBefore.length && !changedParts.length){
    return json_({ok:false, version:APP_VERSION, message:'Part yang dipilih tidak ditemukan / sudah terdistribusi. Sync data lalu coba lagi.'});
  }

  var allPartsAfter = read_('TEMPLATE_PARTS').filter(function(pp){ return String(pp.templateId) === String(id); });
  var remainingWaiting = allPartsAfter.some(isPartWaiting_);
  var newStatus = remainingWaiting ? 'WAITING_DISTRIBUTION' : 'DISTRIBUTED';
  var newStorage = remainingWaiting ? '' : storage;
  var newDistributedAt = remainingWaiting ? (t.distributedAt || '') : now;
  update_('TEMPLATES', t._row, {status:newStatus, currentStorage:newStorage, updatedAt:now, distributedAt:newDistributedAt});

  var note = p.note || 'Distribusi template jadi';
  if(splitParts.length){
    var splitText = splitParts.map(function(x){
      return norm_(x.part) + (x.size ? ' [' + norm_(x.size) + ']' : '') + ' x' + Math.max(1, Number(x.qty || 1));
    }).join(', ');
    if(splitText && String(note).indexOf('Split Part/Size/Qty:') < 0) note += ' | Split Part/Size/Qty: ' + splitText;
  }
  var movement = {id:id_('MOV'), templateId:id, type:'DISTRIBUTE', from:t.currentStorage || 'WORKSHOP', to:storage, by:user, note:note, at:now};
  append_('MOVEMENTS', movement);
  var template = {id:id, status:newStatus, currentStorage:newStorage, updatedAt:now, distributedAt:newDistributedAt};
  return json_({ok:true, version:APP_VERSION, template:template, parts:allPartsAfter, movement:movement, partial:remainingWaiting, message:remainingWaiting?'Distribusi split tersimpan. Part yang belum dipilih tetap waiting.':'Template berhasil didistribusikan'});
}

function isPartWaiting_(p){
  return String(p.status || '').toUpperCase() !== 'DISTRIBUTED' && !p.currentStorage;
}
function normalizeSplitParts_(rows){
  if(!Array.isArray(rows)) return [];
  return rows.map(function(x){ return {partId:String(x.partId || ''), part:norm_(x.part), size:norm_(x.size || ''), qty:Math.max(1, Number(x.qty || 1))}; }).filter(function(x){ return x.partId || x.part; });
}
function findPartRowForSplit_(templateId, sp, allParts){
  var rows = allParts || read_('TEMPLATE_PARTS').filter(function(pp){ return String(pp.templateId) === String(templateId); });
  if(sp.partId){
    var byId = rows.find(function(pp){ return String(pp.partId) === String(sp.partId); });
    if(byId) return byId;
  }
  return rows.find(function(pp){ return isPartWaiting_(pp) && norm_(pp.part) === norm_(sp.part) && norm_(pp.size || '') === norm_(sp.size || ''); });
}

function moveTemplate_(p){
  var id = String(p.id || p.templateId || '');
  var type = String(p.type || 'TRANSFER').toUpperCase();
  var user = String(p.by || p.user || 'system');
  var t = findRow_('TEMPLATES','id',id);
  if(!t) return json_({ok:false, message:'Template tidak ditemukan'});
  var from = p.from || t.currentStorage || '';
  var to = type === 'OUT' ? '' : norm_(p.to);
  if(type !== 'OUT' && to && !findRow_('STORAGES','code',to)) return json_({ok:false, message:'Storage tujuan belum ada di master'});

  if(type !== 'OUT' && norm_(from) === norm_(to)){
    return json_({ok:true, version:APP_VERSION, noChange:true, template:{id:id,status:'DISTRIBUTED',currentStorage:to,updatedAt:t.updatedAt}, message:'Anti duplicate aktif: Storage asal dan tujuan sama, movement tidak digandakan.'});
  }

  var now = new Date();
  update_('TEMPLATES', t._row, {status:type === 'OUT' ? 'OUT' : 'DISTRIBUTED', currentStorage:to, updatedAt:now});
  var movement = {id:id_('MOV'), templateId:id, type:type, from:from, to:to, by:user, note:p.note || '', at:now};
  append_('MOVEMENTS', movement);
  var template = {id:id, status:type === 'OUT' ? 'OUT' : 'DISTRIBUTED', currentStorage:to, updatedAt:now};
  return json_({ok:true, version:APP_VERSION, template:template, movement:movement, message:'Movement tersimpan'});
}

function addStorage_(p){
  var code = norm_(p.code);
  var name = String(p.name || '').trim();
  if(!code || !name) return json_({ok:false, message:'Kode dan nama storage wajib'});
  if(findRow_('STORAGES','code',code)) return json_({ok:false, message:'Kode storage sudah ada'});
  var storage = {code:code, name:name, area:p.area || '', createdAt:new Date(), updatedAt:new Date()};
  append_('STORAGES', storage);
  return json_({ok:true, version:APP_VERSION, storage:storage});
}

function addUser_(p){
  var username = String(p.username || '').trim().toLowerCase();
  if(!username || !p.password) return json_({ok:false, message:'Username/password wajib'});
  if(findRow_('USERS','username',username)) return json_({ok:false, message:'Username sudah ada'});
  validatePassword_(p.password);
  var user = {username:username, password:createPasswordHash_(p.password), role:p.role || 'operator', name:p.name || username, active:p.active || 'TRUE', createdAt:new Date(), updatedAt:new Date()};
  append_('USERS', user);
  delete user.password;
  return json_({ok:true, version:APP_VERSION, user:user});
}

function resetPassword_(p){
  var r = findRow_('USERS','username',String(p.username || '').trim().toLowerCase());
  if(!r) return json_({ok:false, message:'User tidak ditemukan'});
  validatePassword_(p.password);
  update_('USERS', r._row, {password:createPasswordHash_(p.password), updatedAt:new Date()});
  return json_({ok:true, version:APP_VERSION});
}

function findExistingTemplateByKey_(buyer, stylekp, parts){
  var key = partsKey_(parts);
  var templates = readExcept_('TEMPLATES', ['sketch']).filter(function(t){
    return norm_(t.buyer) === buyer && norm_(t.stylekp) === stylekp;
  });
  if(!templates.length) return null;
  var wanted = {};
  templates.forEach(function(t){ wanted[String(t.id)] = t; });
  var partsByTemplate = {};
  read_('TEMPLATE_PARTS').forEach(function(p){
    var tid = String(p.templateId || '');
    if(!wanted[tid]) return;
    if(!partsByTemplate[tid]) partsByTemplate[tid] = [];
    partsByTemplate[tid].push(p);
  });
  for(var i=0; i<templates.length; i++){
    if(partsKey_(partsByTemplate[String(templates[i].id)] || []) === key) return templates[i];
  }
  return null;
}

function partsKeyForTemplate_(templateId){
  return partsKey_(read_('TEMPLATE_PARTS').filter(function(p){return String(p.templateId) === String(templateId);}));
}

function partsKey_(parts){
  return normalizeParts_(parts).map(function(x){ return norm_(x.part)+'['+norm_(x.size)+']#'+Number(x.qty || 1); }).sort().join('|');
}

function normalizeParts_(parts){
  if(typeof parts === 'string') parts = parts.split(/[,/]+/).map(function(x){return {part:x, qty:1};});
  if(!Array.isArray(parts)) return [];
  return parts.map(function(x){
    if(typeof x === 'string') return {part:norm_(x), size:'', qty:1};
    return {part:norm_(x.part || x.name), size:norm_(x.size || x.ukuran || ''), qty:Math.max(1, Number(x.qty || 1)), partId:x.partId || ''};
  }).filter(function(x){return x.part;});
}

/* Simpan LIST sketch (array of dataURL) untuk satu template. Selalu replace-all: sketch lama dihapus dulu,
   lalu tiap gambar di-slice jadi chunk (SKETCH_CHUNK_SIZE) dan diberi index urutan (idx) supaya banyak
   gambar per template bisa dibedakan & direkonstruksi kembali sesuai urutan aslinya. */
function validateSketchList_(sketches){
  (sketches||[]).forEach(function(s){
    var m=String(s||'').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
    if(!m) throw new Error('Format sketch tidak valid. Gunakan JPG/PNG/WebP.');
    if(Utilities.base64Decode(m[2]).length>MAX_SKETCH_BYTES) throw new Error('Ukuran setiap sketch maksimal 1 MB.');
  });
}
function getSketchFolder_(){
  var props=PropertiesService.getScriptProperties(),id=props.getProperty('CNC_SKETCH_FOLDER_ID');
  if(id){try{return DriveApp.getFolderById(id);}catch(e){props.deleteProperty('CNC_SKETCH_FOLDER_ID');}}
  var folder=DriveApp.createFolder('CNC Template Tracker - Sketches');
  props.setProperty('CNC_SKETCH_FOLDER_ID',folder.getId());return folder;
}
function fileIdFromRef_(v){v=String(v||'');return v.indexOf(DRIVE_REF_PREFIX)===0?v.slice(DRIVE_REF_PREFIX.length):'';}
function dataUrlFromDrive_(fileId){
  var blob=DriveApp.getFileById(fileId).getBlob(),bytes=blob.getBytes();
  if(bytes.length>MAX_SKETCH_BYTES) throw new Error('Sketch di Drive melebihi batas 1 MB.');
  return 'data:'+(blob.getContentType()||'image/jpeg')+';base64,'+Utilities.base64Encode(bytes);
}
function hasDriveSketchRef_(templateId){
  return read_('SKETCHES').some(function(r){return String(r.templateId)===String(templateId)&&!!fileIdFromRef_(r.chunk);});
}
function saveSketchesForTemplate_(templateId, sketches){
  sketches=(sketches||[]).map(function(s){return String(s||'');}).filter(Boolean);validateSketchList_(sketches);
  var created=[];
  try{
    var folder=getSketchFolder_(),rows=[];
    sketches.forEach(function(s,idx){
      var m=s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/),bytes=Utilities.base64Decode(m[2]);
      var ext=m[1].split('/')[1].replace('jpeg','jpg');
      var file=folder.createFile(Utilities.newBlob(bytes,m[1],'sketch-'+templateId+'-'+(idx+1)+'.'+ext));created.push(file);
      rows.push({templateId:templateId,idx:idx,seq:0,chunk:DRIVE_REF_PREFIX+file.getId(),updatedAt:new Date()});
    });
    deleteSketchChunks_(templateId);
    if(rows.length) appendRows_('SKETCHES',rows);
    var t=findRow_('TEMPLATES','id',templateId);if(t)update_('TEMPLATES',t._row,{sketch:rows.length?'DRIVE':'',updatedAt:new Date()});
    return rows.length;
  }catch(err){created.forEach(function(f){try{f.setTrashed(true);}catch(e){}});throw err;}
}
function saveSketchChunks_(templateId,sketch){return sketch?saveSketchesForTemplate_(templateId,[sketch]):0;}
function readSketchesForTemplate_(templateId){
  var rows=read_('SKETCHES').filter(function(r){return String(r.templateId)===String(templateId);}),byIdx={};
  rows.forEach(function(r){var idx=Number(r.idx||0);if(!byIdx[idx])byIdx[idx]=[];byIdx[idx].push({seq:Number(r.seq||0),chunk:String(r.chunk||'')});});
  return Object.keys(byIdx).map(Number).sort(function(a,b){return a-b;}).map(function(idx){
    var chunks=byIdx[idx].sort(function(a,b){return a.seq-b.seq;});
    if(chunks.length===1&&fileIdFromRef_(chunks[0].chunk))return dataUrlFromDrive_(fileIdFromRef_(chunks[0].chunk));
    return chunks.map(function(c){return c.chunk;}).join('');
  });
}
function deleteSketchChunks_(templateId){
  var rows=read_('SKETCHES').filter(function(r){return String(r.templateId)===String(templateId);});
  rows.forEach(function(r){var fid=fileIdFromRef_(r.chunk);if(fid){try{DriveApp.getFileById(fid).setTrashed(true);}catch(e){}}});
  var sh=ensureSheet_('SKETCHES'),last=sh.getLastRow();if(last<=1)return;
  var ids=sh.getRange(2,1,last-1,1).getValues();
  for(var i=ids.length-1;i>=0;i--)if(String(ids[i][0])===String(templateId))sh.deleteRow(i+2);
}
function migrateLegacySketchChunksToDrive_(){
  var rows=read_('SKETCHES'),ids={};rows.forEach(function(r){if(r.templateId)ids[String(r.templateId)]=true;});
  var migrated=0;
  Object.keys(ids).forEach(function(id){if(hasDriveSketchRef_(id))return;var images=readSketchesForTemplate_(id);if(images.length){saveSketchesForTemplate_(id,images);var t=findRow_('TEMPLATES','id',id);if(t)update_('TEMPLATES',t._row,{sketch:'DRIVE',updatedAt:new Date()});migrated+=images.length;}});
  return migrated;
}

function getSketchIdSet_(){
  var sh = ensureSheet_('SKETCHES');
  var last = sh.getLastRow();
  var out = {};
  if(last <= 1) return out;
  var ids = sh.getRange(2,1,last-1,1).getValues();
  ids.forEach(function(r){ if(r[0]) out[String(r[0])] = true; });
  return out;
}

function readLegacySketch_(templateId){
  var row = findRowNumberByValue_('TEMPLATES','id',templateId);
  if(!row) return '';
  var col = colIndex_('TEMPLATES','sketch');
  if(!col) return '';
  var value=String(ensureSheet_('TEMPLATES').getRange(row,col).getValue()||'');
  return /^data:image\//i.test(value)?value:'';
}

function clearLegacySketch_(templateId){
  var row = findRowNumberByValue_('TEMPLATES','id',templateId);
  var col = colIndex_('TEMPLATES','sketch');
  if(row && col) ensureSheet_('TEMPLATES').getRange(row, col).setValue('DRIVE');
}

function migrateSketches_(){
  var sh = ensureSheet_('TEMPLATES');
  var last = sh.getLastRow();
  if(last <= 1) return 0;
  var idCol = colIndex_('TEMPLATES','id');
  var sketchCol = colIndex_('TEMPLATES','sketch');
  if(!idCol || !sketchCol) return 0;
  var ids = sh.getRange(2,idCol,last-1,1).getValues();
  var migrated = 0;
  for(var i=0; i<ids.length; i++){
    var templateId = ids[i][0];
    if(!templateId) continue;
    var sketch = String(sh.getRange(i+2, sketchCol).getValue() || '');
    if(/^data:image\//i.test(sketch)){
      saveSketchChunks_(templateId, sketch);
      sh.getRange(i+2, sketchCol).setValue('DRIVE');
      migrated++;
    }
  }
  return migrated;
}

function getSS_(){
  if(SPREADSHEET_ID){
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if(!ss){
    throw new Error('Spreadsheet tidak ditemukan. Isi SPREADSHEET_ID atau buka Apps Script dari Spreadsheet > Extensions > Apps Script.');
  }
  return ss;
}

function ensureSheet_(name){
  var ss = getSS_();
  var sh = ss.getSheetByName(name);
  var headers = SHEETS[name];
  if(!sh) sh = ss.insertSheet(name);
  var lastCol = Math.max(sh.getLastColumn(), headers.length);
  var old = sh.getLastRow() ? sh.getRange(1,1,1,lastCol).getValues()[0].slice(0, headers.length).map(String) : [];
  if(old.join('|') !== headers.join('|')){
    if(sh.getLastRow() <= 1){
      sh.clear();
      sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0f766e').setFontColor('#fff');
      sh.setFrozenRows(1);
    }else{
      sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold').setBackground('#0f766e').setFontColor('#fff');
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

function seedIfEmpty_(name, rows){
  var sh = ensureSheet_(name);
  if(sh.getLastRow() <= 1) sh.getRange(2,1,rows.length,SHEETS[name].length).setValues(rows);
}

function read_(name){
  var sh = ensureSheet_(name);
  var v = sh.getDataRange().getValues();
  if(v.length <= 1) return [];
  var h = v[0].map(String);
  return v.slice(1).filter(function(r){return r.join('') !== '';}).map(function(r,i){
    var o = {_row:i+2};
    h.forEach(function(x,j){ o[x] = r[j]; });
    return o;
  });
}

function readExcept_(name, excludeHeaders){
  var sh = ensureSheet_(name);
  var headers = SHEETS[name];
  var lastRow = sh.getLastRow();
  if(lastRow <= 1) return [];
  var rowCount = lastRow - 1;
  var ex = {};
  (excludeHeaders || []).forEach(function(x){ ex[x] = true; });
  var out = [];
  for(var r=0; r<rowCount; r++) out.push({_row:r+2});

  var start = -1;
  for(var i=0; i<=headers.length; i++){
    var include = i < headers.length && !ex[headers[i]];
    if(include && start < 0) start = i;
    if((!include || i === headers.length) && start >= 0){
      var end = i;
      var vals = sh.getRange(2, start+1, rowCount, end-start).getValues();
      vals.forEach(function(rowVals, rr){
        for(var c=0; c<rowVals.length; c++) out[rr][headers[start+c]] = rowVals[c];
      });
      start = -1;
    }
  }
  return out.filter(function(o){
    return headers.some(function(h){ return !ex[h] && String(o[h] || '') !== ''; });
  });
}

function append_(name,obj){
  appendRows_(name, [obj]);
}

function appendRows_(name, rows){
  if(!rows || !rows.length) return 0;
  var h = SHEETS[name];
  var sh = ensureSheet_(name);
  var values = rows.map(function(obj){ return h.map(function(x){return obj[x] == null ? '' : obj[x];}); });
  sh.getRange(sh.getLastRow()+1, 1, values.length, h.length).setValues(values);
  return values.length;
}

function update_(name,row,obj){
  var sh = ensureSheet_(name);
  var h = SHEETS[name];
  var old = sh.getRange(row,1,1,h.length).getValues()[0];
  sh.getRange(row,1,1,h.length).setValues([h.map(function(x,i){return obj[x] == null ? old[i] : obj[x];})]);
}

function findRow_(name,key,val){
  return read_(name).find(function(x){return String(x[key]).toUpperCase() === String(val).toUpperCase();});
}

function findRowNumberByValue_(name,key,val){
  var sh = ensureSheet_(name);
  var col = colIndex_(name,key);
  var last = sh.getLastRow();
  if(!col || last <= 1) return 0;
  var vals = sh.getRange(2,col,last-1,1).getValues();
  for(var i=0; i<vals.length; i++){
    if(String(vals[i][0]).toUpperCase() === String(val).toUpperCase()) return i+2;
  }
  return 0;
}

function colIndex_(name,key){
  return SHEETS[name].indexOf(key) + 1;
}

function norm_(v){ return String(v || '').trim().replace(/\s+/g,' ').toUpperCase(); }
function id_(p){ return p+'-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase(); }
function unique_(arr){ var seen={}; return arr.map(norm_).filter(function(x){ if(!x || seen[x]) return false; seen[x]=true; return true; }).sort(); }
function json_(obj){
  var json = JSON.stringify(obj);
  var cb = String(__JSONP_CALLBACK__ || '').trim();
  if(cb && /^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(cb)){
    return ContentService.createTextOutput(cb + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
function errorJson_(err, where){
  var msg = err && err.stack ? String(err.stack).split('\n').slice(0,3).join(' | ') : String(err);
  return json_({ok:false, version:APP_VERSION, where:where, message:msg});
}