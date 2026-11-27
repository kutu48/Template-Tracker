const APP_CONFIG = { build: (window.Android || window.Capacitor) ? "apk" : "pc", label: "Offline-First" };

const VERSION = "5.0.0-offline-first";
let db = emptyDB();
let currentUser = null;
let selectedQR = new Set();
let selectedTemplateQR = new Set();
let templateCTValues = Object.create(null);
let selectedTemplateId = "";
let distSelections = new Map();
let distSubmitting = false;
let selectedMoveTemplateId = "";
let scanner = null;
let lastSyncText = "Belum sync";
let dataLoaded = false;
let activePage = "home";
let selectedFieldStorage = "";
let syncUiState = { online: true, syncing: false, pendingCount: 0, errorCount: 0, lastSyncAt: "", lastError: "", authExpired: false };

/* ================= AUTO DETECT DEVICE + LAYAR =================
   Set 3 atribut di <body>:
   - data-device : mobile / tablet / desktop  (jenis perangkat)
   - data-screen : xs / sm / md / lg / xl     (kelas ukuran layar -> skala font/form/menu via CSS vars)
   - data-touch  : 1 / 0                      (layar sentuh -> kontrol lebih tinggi) */
function detectDevice(){
  const w = window.innerWidth;
  const coarse = window.matchMedia?.("(pointer:coarse)")?.matches;
  const dpr = window.devicePixelRatio || 1;

  let device = "desktop";
  if(w <= 700 || (coarse && w <= 820)) device = "mobile";
  else if(w <= 1100) device = "tablet";

  let screen = "md";
  if(w <= 380) screen = "xs";
  else if(w <= 700) screen = "sm";
  else if(w <= 1100) screen = "md";
  else if(w <= 1500) screen = "lg";
  else screen = "xl";
  if(device === "mobile" && dpr >= 2.5 && screen === "xs") screen = "sm";

  const b = document.body;
  b.dataset.device = device;
  b.dataset.screen = screen;
  b.dataset.touch = coarse ? "1" : "0";
  return device;
}
window.addEventListener("resize", debounceRaw(detectDevice, 200));
window.addEventListener("orientationchange", ()=>setTimeout(detectDevice, 120));
function debounceRaw(fn, wait){ let t; return (...a)=>{clearTimeout(t); t=setTimeout(()=>fn(...a),wait)}; }

function $(id){ return document.getElementById(id); }
function esc(v){return String(v ?? "").replace(/[&<>'"]/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[m]));}
function escAttr(v){return esc(v).replace(/`/g,"&#96;");}
function normalizeText(v){return String(v||"").trim().replace(/\s+/g," ").toUpperCase();}
function nowISO(){return new Date().toISOString();}
function dateTimeText(v){ if(!v) return "-"; const d=new Date(v); return isNaN(d) ? esc(v) : d.toLocaleString("id-ID"); }
function id(prefix){ return window.CNCDB ? CNCDB.uuid(prefix) : (prefix + "-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2,8).toUpperCase()); }
function userName(){ return currentUser?.username || "system"; }
function isAdmin(){ return currentUser && ["admin","super_admin"].includes(currentUser.role); }
function isSuperAdmin(){ return currentUser?.role === "super_admin"; }
function isAndroidNative(){ return !!(window.Android || window.Capacitor); }
function emptyDB(){ return {storages:[],templates:[],parts:[],movements:[],acrylics:[],acrylicLogs:[],users:[],masters:{buyers:[],parts:[]}}; }
function roundQty(v){
  const n = Number(v || 0);
  if(!isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
function formatAcrylicSpec(a){
  if(!a) return "";
  const u = a.unit || "cm";
  const color = a.color ? ` (${a.color})` : "";
  return `${roundQty(a.length)} × ${roundQty(a.width)} ${u} · ${roundQty(a.thicknessMm)} mm${color}`;
}
function statusLabel(s){
  const map={WAITING_DISTRIBUTION:"Menunggu Distribusi",DISTRIBUTED:"Sudah Distribusi",OUT:"Keluar",REPAIR:"Repair",ARCHIVED:"Arsip"};
  return map[s] || s || "-";
}
function statusBadge(s){
  const cls = s==="DISTRIBUTED" ? "good" : s==="WAITING_DISTRIBUTION" ? "warn" : s==="OUT" ? "bad" : "";
  return `<span class="badge ${cls}">${esc(statusLabel(s))}</span>`;
}
function toast(msg){
  let t=$("toast"); if(!t){t=document.createElement("div");t.id="toast";t.className="toast";document.body.appendChild(t)}
  t.textContent=msg; t.classList.remove("hidden"); clearTimeout(window.__toastTimer); window.__toastTimer=setTimeout(()=>t.classList.add("hidden"),2800);
}
function setBusy(on, title="Memproses data..."){
  const el=$("busy"); if(!el) return; el.classList.toggle("hidden", !on); $("busyTitle").textContent=title;
}
function debounce(fn, wait=180){ let t; return (...args)=>{clearTimeout(t); t=setTimeout(()=>fn(...args),wait)}; }

/* ================= CUSTOM BLUE NAVY DIALOG (PENGGANTI ALERT/CONFIRM/PROMPT) & BACK HANDLER ================= */
let __dialogResolver = null;
function resolveDialogModal(val){
  const m = $("dialogModal");
  if(m) m.style.display = "none";
  if(!anyModalOpen()) document.body.style.overflow = "";
  const r = __dialogResolver;
  __dialogResolver = null;
  if(r) r(val);
}
function openCustomDialog(opts={}){
  const m = $("dialogModal");
  if(!m){
    // Fallback aman bila elemen DOM belum tersedia (misal unit test ringan)
    if(opts.mode === "confirm") return Promise.resolve(true);
    if(opts.mode === "prompt") return Promise.resolve(opts.defaultValue || "");
    return Promise.resolve(true);
  }
  if(__dialogResolver){
    const prev = __dialogResolver;
    __dialogResolver = null;
    prev(opts.mode === "prompt" ? null : false);
  }
  if($("dialogTitle")) $("dialogTitle").textContent = opts.title || "Informasi";
  if($("dialogMessage")) $("dialogMessage").textContent = String(opts.message || "");
  const inpWrap = $("dialogInputWrap");
  const inp = $("dialogInput");
  if(inpWrap) inpWrap.classList.toggle("hidden", opts.mode !== "prompt");
  if(inp && opts.mode === "prompt"){
    inp.value = opts.defaultValue || "";
    inp.placeholder = opts.placeholder || "";
  }
  const btnCancel = $("dialogCancelBtn");
  const btnOk = $("dialogOkBtn");
  if(btnCancel){
    btnCancel.classList.toggle("hidden", opts.mode === "alert");
    btnCancel.textContent = opts.cancelText || "Batal";
  }
  if(btnOk){
    btnOk.textContent = opts.okText || "OK";
    btnOk.className = opts.danger ? "bad" : "good";
  }
  m.style.display = "flex";
  document.body.style.overflow = "hidden";
  setTimeout(()=>{
    if(opts.mode === "prompt" && inp) inp.focus();
    else if(btnOk) btnOk.focus();
  }, 40);
  return new Promise(resolve => {
    __dialogResolver = resolve;
  });
}
function uiAlert(message, title="Informasi"){
  return openCustomDialog({ mode: "alert", title, message, okText: "Mengerti" });
}
function uiConfirm(message, title="Konfirmasi", opts={}){
  return openCustomDialog({
    mode: "confirm",
    title,
    message,
    okText: opts.okText || "Ya, Lanjutkan",
    cancelText: opts.cancelText || "Batal",
    danger: !!opts.danger
  });
}
function uiPrompt(message, defaultValue="", title="Input Data", placeholder=""){
  return openCustomDialog({
    mode: "prompt",
    title,
    message,
    defaultValue,
    placeholder,
    okText: "Simpan / OK",
    cancelText: "Batal"
  });
}
function submitDialogPromptOrOk(){
  const inpWrap = $("dialogInputWrap");
  const isPrompt = inpWrap && !inpWrap.classList.contains("hidden");
  if(isPrompt){
    resolveDialogModal($("dialogInput") ? $("dialogInput").value : "");
  }else{
    resolveDialogModal(true);
  }
}
function anyModalOpen(){
  return ["dialogModal","loginModal","cropModal","modal"].some(id=>{
    const el = $(id);
    return el && el.style && el.style.display === "flex";
  });
}
function openMoreMenuModal(){
  if(!requireLogin("membuka daftar menu lengkap")) return;
  $("modalTitle").textContent = "☰ Semua Menu Aplikasi";
  $("modalContent").innerHTML = `
    <div class="menu-grid" style="margin-bottom:0">
      <div class="menu-card" onclick="closeModal();showPage('home')"><div class="icon">🏠</div><b>Dashboard Utama</b><span>Ringkasan lokasi &amp; analitik</span></div>
      <div class="menu-card" onclick="closeModal();showPage('templateInput')"><div class="icon">➕</div><b>Input Template</b><span>Multi part, akrilik, sketch</span></div>
      <div class="menu-card" onclick="closeModal();showPage('distribution')"><div class="icon">📦</div><b>Distribusi</b><span>Split part/size/qty</span></div>
      <div class="menu-card" onclick="closeModal();showPage('acrylic')"><div class="icon">🧱</div><b>Stok Akrilik</b><span>Input P×L×T &amp; riwayat</span></div>
      <div class="menu-card" onclick="closeModal();showPage('storage')"><div class="icon">📷</div><b>Scan / Storage</b><span>Cek isi meja via QR</span></div>
      <div class="menu-card" onclick="closeModal();showPage('movement')"><div class="icon">🔁</div><b>Movement</b><span>Pindah storage / repair</span></div>
      <div class="menu-card" onclick="closeModal();showPage('dashboardStorage')"><div class="icon">📊</div><b>Dashboard Storage</b><span>Isi lengkap tiap meja</span></div>
      <div class="menu-card" onclick="closeModal();showPage('templateList')"><div class="icon">📋</div><b>List Template</b><span>Cari semua template</span></div>
      <div class="menu-card" onclick="closeModal();showPage('movementHistory')"><div class="icon">🕘</div><b>History Movement</b><span>5 movement terakhir</span></div>
      <div class="menu-card" onclick="closeModal();showPage('templateQrPrint')"><div class="icon">🏷️</div><b>Print QR Template</b><span>A4 &amp; Thermal 58/80 mm</span></div>
      <div class="menu-card" onclick="closeModal();showPage('printqr')"><div class="icon">🖨️</div><b>Print QR Storage</b><span>Cetak label meja/storage</span></div>
      <div class="menu-card" onclick="closeModal();showPage('fieldUpdate')"><div class="icon">🧾</div><b>Update Lapangan</b><span>Tambah cepat per meja</span></div>
      <div class="menu-card" onclick="closeModal();showPage('importExisting')"><div class="icon">📥</div><b>Import Lapangan</b><span>Paste Excel / CSV</span></div>
      <div class="menu-card" onclick="closeModal();showPage('master')"><div class="icon">⚙️</div><b>Master &amp; Backup</b><span>Storage, server, JSON</span></div>
      ${isSuperAdmin() ? `<div class="menu-card" onclick="closeModal();showPage('userManagement')"><div class="icon">👥</div><b>User Management</b><span>Kelola akun &amp; role</span></div>` : ""}
    </div>`;
  openModal();
}

// Dipanggil oleh tombol Back fisik/gesture Android (MainActivity.kt OnBackPressedCallback)
window.handleHardwareBack = function(){
  if($("dialogModal")?.style?.display === "flex"){ resolveDialogModal(null); return true; }
  if($("cropModal")?.style?.display === "flex"){ closeCropModal(); return true; }
  if($("modal")?.style?.display === "flex"){ closeModal(); return true; }
  if($("loginModal")?.style?.display === "flex"){ closeLoginModal(); return true; }
  if(activePage && activePage !== "home"){
    showPage("home");
    return true;
  }
  return false;
};
window.addEventListener("keydown", (e)=>{
  if(e.key === "Escape"){
    if($("dialogModal")?.style?.display === "flex"){ e.preventDefault(); resolveDialogModal(null); }
    else if($("cropModal")?.style?.display === "flex"){ e.preventDefault(); closeCropModal(); }
    else if($("modal")?.style?.display === "flex"){ e.preventDefault(); closeModal(); }
    else if($("loginModal")?.style?.display === "flex"){ e.preventDefault(); closeLoginModal(); }
  }
});

function migrateDB(d){
  d = d || emptyDB();
  d.storages = (d.storages || []).filter(s=>s && s.code && !s.deleted);
  d.templates = (d.templates || []).filter(t=>t && t.id && !t.deleted);
  d.parts = (d.parts || []).filter(p=>p && (p.partId || p.templateId) && !p.deleted);
  d.movements = (d.movements || []).filter(m=>m && m.id);
  d.acrylics = (d.acrylics || []).filter(a=>a && a.id && !a.deleted).map(a=>({
    ...a,
    length: roundQty(a.length),
    width: roundQty(a.width),
    unit: String(a.unit || "cm").toLowerCase() === "mm" ? "mm" : "cm",
    thicknessMm: roundQty(a.thicknessMm),
    color: normalizeText(a.color || ""),
    qtyIn: roundQty(a.qtyIn),
    qtyUsed: roundQty(a.qtyUsed),
    qtyAvailable: roundQty(a.qtyAvailable != null ? a.qtyAvailable : Math.max(0, Number(a.qtyIn||0) - Number(a.qtyUsed||0)))
  }));
  d.acrylicLogs = (d.acrylicLogs || []).filter(l=>l && l.id);
  d.users = d.users || [];
  d.masters = d.masters || {buyers:[],parts:[]};

  const tMap=new Map();
  d.templates.forEach(t=>{
    if(t.storage && !t.currentStorage) t.currentStorage=t.storage;
    if(!t.status) t.status=t.currentStorage?"DISTRIBUTED":"WAITING_DISTRIBUTION";
    if(t.sketch){ t.hasSketch = true; delete t.sketch; }
    t.hasSketch = String(t.hasSketch).toUpperCase()==="TRUE" || t.hasSketch===true;
    t.acrylicSource = String(t.acrylicSource || "").toUpperCase();
    t.acrylicId = String(t.acrylicId || "");
    t.acrylicQty = roundQty(t.acrylicQty || 0);
    t.acrylicSourceTemplateId = String(t.acrylicSourceTemplateId || "");
    t.acrylicSpec = String(t.acrylicSpec || "");
    delete t.storage;
    tMap.set(String(t.id), t);
  });
  d.parts.forEach(p=>{
    p.qty = Math.max(1, Math.round(Number(p.qty||1)));
    const st = String(p.status||"").trim().toUpperCase();
    const cs = String(p.currentStorage||"").trim();
    if(!st && !cs){
      const parent = tMap.get(String(p.templateId));
      const pst = String(parent?.status||"").trim().toUpperCase();
      if(pst==="DISTRIBUTED"){
        p.status="DISTRIBUTED";
        p.currentStorage=parent.currentStorage||"";
        p.distributedAt=parent.distributedAt||"";
      }else if(pst==="OUT"){
        p.status="OUT";
        p.currentStorage="";
      }else{
        p.status="WAITING_DISTRIBUTION";
        p.currentStorage="";
      }
    }else if(!st && cs){
      p.status="DISTRIBUTED";
    }else{
      p.status=st;
    }
  });
  const buyers=new Set([...(d.masters.buyers||[]), ...d.templates.map(t=>t.buyer).filter(Boolean)]);
  const parts=new Set([...(d.masters.parts||[]), ...d.parts.map(p=>p.part).filter(Boolean)]);
  d.masters.buyers=[...buyers].sort(); d.masters.parts=[...parts].sort();
  return d;
}

async function reloadLocalState(){
  const snap = await CNCDB.loadAllData();
  db = migrateDB(snap);
  dataLoaded = true;
  await CNCSync.refreshOutboxCounters();
  renderCurrentPage();
  updateHeader();
  return db;
}

function updateSyncIndicator(st){
  syncUiState = st || syncUiState;
  const net = $("syncNetBadge");
  if(net){
    net.className = "sync-pill " + (syncUiState.online ? "online" : "offline");
    net.textContent = syncUiState.syncing ? "🔄 Menyinkronkan..." : (syncUiState.online ? "🟢 Online" : "🔴 Offline");
  }
  const qBadge = $("syncQueueBadge");
  if(qBadge){
    if(!currentUser){
      qBadge.classList.add("hidden");
    }else if(syncUiState.errorCount > 0){
      qBadge.className = "sync-pill error";
      qBadge.textContent = `⚠️ ${syncUiState.errorCount} gagal · ${syncUiState.pendingCount} antre`;
    }else if(syncUiState.pendingCount > 0){
      qBadge.className = "sync-pill pending";
      qBadge.textContent = `⏳ ${syncUiState.pendingCount} tertunda`;
    }else{
      qBadge.className = "sync-pill clean";
      qBadge.textContent = "✓ Tersinkron";
    }
  }
  const lastSyncStr = syncUiState.lastSyncAt ? dateTimeText(syncUiState.lastSyncAt) : "Belum sync";
  lastSyncText = lastSyncStr;
  const lastEl = $("headerLastSync");
  if(lastEl){
    lastEl.textContent = `Sync: ${lastSyncStr}`;
    lastEl.classList.toggle("hidden", !currentUser);
  }
  const btn = $("btnHeaderSync");
  if(btn) btn.disabled = !!syncUiState.syncing;
  const homeSum = $("homeSyncSummary");
  if(homeSum){
    homeSum.textContent = currentUser
      ? `${syncUiState.online ? "Online" : "Offline"} · Login: ${currentUser.name || currentUser.username} · Antrean: ${syncUiState.pendingCount}${syncUiState.errorCount ? ` (${syncUiState.errorCount} gagal)` : ""} · Sync: ${lastSyncStr}`
      : `Ringkasan sebaran template per lokasi / storage`;
  }
  if(syncUiState.authExpired && currentUser){
    toast("Token perangkat kedaluwarsa/dicabut. Silakan login ulang saat online.");
  }
}

async function syncNowManual(full=false){
  if(!requireLogin("melakukan sinkronisasi dengan Google Sheets")) return;
  if(!CNCSync.isOnline()){
    toast("Sedang offline — data lokal tetap aman, antrean akan dikirim saat online.");
    return;
  }
  setBusy(true, full ? "Full sync ulang dari Google Sheets..." : "Menyinkronkan antrean & delta...");
  try{
    const res = await CNCSync.syncNow({ force: true, full: !!full });
    await reloadLocalState();
    if(res.ok){
      const m = res.merged || {};
      const pulled = (m.templates||0) + (m.parts||0) + (m.movements||0) + (m.storages||0) + (m.acrylics||0) + (m.acrylicLogs||0);
      toast(`Sync selesai · upload ${res.pushed||0}, unduh ${pulled} perubahan`);
    }else if(res.authError){
      uiAlert("Sesi kedaluwarsa/dicabut di server. Silakan login ulang (data lokal & antrean tidak hilang).");
      openLoginModal("Sesi kedaluwarsa/dicabut. Silakan login ulang untuk melanjutkan sync.");
    }else if(res.error){
      uiAlert("Sync gagal: " + res.error);
    }else if(res.message){
      toast(res.message);
    }
  }catch(e){
    uiAlert("Sync gagal: " + e.message);
  }finally{
    setBusy(false);
  }
}
async function syncData(){ return syncNowManual(false); }

/* ================= PENGATURAN SERVER (config.js + override IndexedDB) ================= */
async function openServerSettingsModal(){
  const cfg = await CNCDB.getEffectiveConfig();
  $("modalTitle").textContent = "⚙️ Pengaturan Server Apps Script";
  $("modalContent").innerHTML = `
    <div class="card">
      <p class="muted">Konfigurasi dapat diisi di file <code>public/config.js</code> atau disimpan di perangkat ini. Semua sync menggunakan <b>POST text/plain</b> langsung ke Apps Script (tanpa OpenSheet).</p>
      <label>URL Web App Apps Script (wajib berakhiran /exec)</label>
      <input id="cfgApiUrl" value="${escAttr(cfg.apiUrl||"")}" placeholder="https://script.google.com/macros/s/.../exec"/>
      <label>Spreadsheet ID (opsional, catatan admin saja)</label>
      <input id="cfgSheetId" value="${escAttr(cfg.spreadsheetId||"")}" placeholder="Opsional"/>
      <div class="actions">
        <button class="good" type="button" onclick="saveServerSettingsUI()">💾 Simpan Pengaturan</button>
        <button type="button" onclick="testConnectionFromModal()">🔌 Tes Koneksi</button>
      </div>
      <div id="cfgTestStatus" class="scan-status" style="margin-top:10px">${cfg.apiUrl ? "Server terkonfigurasi." : "URL Apps Script belum diisi."}</div>
    </div>`;
  openModal();
}
async function saveServerSettingsUI(){
  const apiUrl = String($("cfgApiUrl")?.value || "").trim().replace(/\/+$/,"");
  const spreadsheetId = String($("cfgSheetId")?.value || "").trim();
  if(apiUrl){
    try{ CNCSync.validateApiUrl(apiUrl); }catch(e){ return uiAlert(e.message); }
  }
  await CNCDB.saveConfig({ apiUrl, spreadsheetId });
  toast("Pengaturan server tersimpan");
  await updateLoginConfigHint();
  closeModal();
}
async function testConnectionFromModal(){
  const st = $("cfgTestStatus");
  const apiUrl = String($("cfgApiUrl")?.value || "").trim().replace(/\/+$/,"");
  try{
    if(st) st.textContent = "Menguji POST ping ke Apps Script...";
    const res = await CNCSync.postApi("ping", {}, { skipAuth: true, apiUrl });
    if(st) st.textContent = `Koneksi OK (versi backend: ${res.version || "-"}, waktu server: ${dateTimeText(res.now)})`;
    toast("Koneksi Apps Script OK");
  }catch(e){
    if(st) st.textContent = "Gagal: " + e.message;
  }
}
async function testConnection(){
  const status=$("loginStatus");
  try{
    if(status) status.textContent="Menguji koneksi POST ke Apps Script...";
    const res = await CNCSync.postApi("ping", {}, { skipAuth: true });
    if(status) status.textContent=`Koneksi Apps Script berhasil (v${res.version||"-"})`;
    toast("Koneksi berhasil");
  }catch(e){
    if(status) status.textContent=e.message;
    uiAlert("Tes koneksi gagal: "+e.message);
  }
}
async function updateLoginConfigHint(){
  const status=$("loginStatus");
  if(!status) return;
  const cfg = await CNCDB.getEffectiveConfig();
  if(!cfg.apiUrl){
    status.textContent = "URL Apps Script belum diatur. Klik 'Pengaturan Server' atau edit public/config.js.";
  }else{
    status.textContent = CNCSync.isOnline()
      ? "Server siap. Login sekali untuk mengaktifkan sesi offline 30 hari."
      : "Perangkat sedang offline. Jika sudah pernah login sebelumnya, sesi 30 hari aktif otomatis.";
  }
}

/* ================= OUTBOX MODAL (ANTREAN TULIS) ================= */
async function openOutboxModal(){
  if(!requireLogin("melihat antrean sinkronisasi")) return;
  const ops = await CNCDB.getOutbox();
  $("modalTitle").textContent = `🧾 Antrean Sinkronisasi (${ops.length})`;
  const summary = `<div class="actions"><button class="good" type="button" onclick="retryOutboxFromModal()">🔄 Sync / Coba Ulang Semua</button><button class="small" type="button" onclick="openOutboxModal()">Refresh Daftar</button></div>`;
  const rowsHtml = ops.length ? ops.map(op=>`
    <div class="line-item">
      <b>${esc(op.type)} ${op.status==="error" ? `<span class="badge bad">Gagal</span>` : `<span class="badge warn">Menunggu</span>`}</b>
      <span>ID: ${esc(op.opId)} · dibuat ${dateTimeText(op.createdAt)} · percobaan: ${Number(op.retries||0)}</span>
      ${op.lastError ? `<small style="color:#fecaca">Error: ${esc(op.lastError)}</small>` : ""}
      <div class="actions" style="margin-top:6px">
        <button class="small bad" type="button" onclick="removeOutboxItemUI('${encKey(op.opId)}')">Hapus dari Antrean</button>
      </div>
    </div>`).join("") : `<div class="empty">Semua perubahan lokal sudah tersinkron ke Google Sheets.</div>`;
  $("modalContent").innerHTML = summary + rowsHtml;
  openModal();
}
async function retryOutboxFromModal(){
  closeModal();
  if(!CNCSync.isOnline()) return uiAlert("Perangkat masih offline.");
  setBusy(true, "Mencoba ulang antrean sync...");
  try{
    await CNCSync.retryAllFailedOutbox();
    await reloadLocalState();
    toast("Sinkronisasi antrean selesai");
  }catch(e){
    uiAlert("Gagal retry antrean: " + e.message);
  }finally{
    setBusy(false);
  }
}
async function removeOutboxItemUI(encOpId){
  const opId = decKey(encOpId);
  if(!(await uiConfirm("Hapus item ini dari antrean sync? Perubahan lokal tetap ada tetapi tidak akan dikirim ke server.", "Hapus Antrean", { okText: "Ya, Hapus", danger: true }))) return;
  await CNCDB.removeOutboxOp(opId);
  await CNCSync.refreshOutboxCounters();
  openOutboxModal();
}

/* ================= BACKUP & RESTORE LOKAL (JSON + AUTO-BACKUP FOLDER PC) ================= */
async function refreshAutoBackupUI(){
  const box = $("autoBackupBox");
  const actions = $("autoBackupActions");
  if(!box) return;
  const st = await CNCDB.getAutoBackupStatus();
  if(!st.supported){
    box.textContent = "Auto-backup folder langsung tersedia di Edge/Chrome PC. Di perangkat ini gunakan tombol Export / Import Backup JSON.";
    if(actions) actions.classList.add("hidden");
    return;
  }
  if(actions) actions.classList.remove("hidden");
  box.textContent = st.enabled
    ? `Auto-backup AKTIF ke folder "${st.folderName}" · backup terakhir: ${st.lastBackupAt ? dateTimeText(st.lastBackupAt) : "-"}`
    : "Auto-backup folder belum diaktifkan. Klik 'Pilih Folder Auto-Backup (PC)' untuk backup otomatis setiap ada perubahan.";
}
async function setupAutoBackupFolder(){
  try{
    const name = await CNCDB.pickAutoBackupFolder();
    toast(`Auto-backup aktif ke folder: ${name}`);
    await refreshAutoBackupUI();
  }catch(e){
    if(e && e.name !== "AbortError") uiAlert(e.message || "Gagal memilih folder backup.");
  }
}
async function runAutoBackupNow(){
  const ok = await CNCDB.runAutoBackup(true);
  await refreshAutoBackupUI();
  toast(ok ? "Backup ke folder berhasil" : "Belum ada folder auto-backup atau izin ditolak");
}
async function disableAutoBackupFolderUI(){
  await CNCDB.disableAutoBackupFolder();
  await refreshAutoBackupUI();
  toast("Auto-backup folder dimatikan");
}
async function exportBackupFile(){
  try{
    const backupObj = await CNCDB.exportBackupObject();
    const jsonText = JSON.stringify(backupObj, null, 2);
    const filename = "cnc_template_tracker_backup_" + nowISO().slice(0,10) + ".json";
    if(window.Android && typeof window.Android.saveBase64File === "function"){
      const b64 = btoa(unescape(encodeURIComponent(jsonText)));
      window.Android.saveBase64File(filename, b64, "application/json");
      return;
    }
    const blob = new Blob([jsonText], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1500);
    toast("Backup JSON berhasil diekspor");
  }catch(e){
    uiAlert("Export backup gagal: " + e.message);
  }
}
function exportJSON(){ return exportBackupFile(); }
async function onImportBackupSelected(input){
  const file = input.files?.[0];
  if(!file) return;
  try{
    const text = await file.text();
    const parsed = JSON.parse(text);
    const replaceMode = await uiConfirm("Impor dan gabungkan (MERGE) data backup JSON ke database lokal perangkat ini?", "Import Backup JSON", { okText: "Ya, Gabungkan Data" });
    if(!replaceMode){ input.value=""; return; }
    setBusy(true, "Mengimpor backup JSON...");
    const stats = await CNCDB.importBackupObject(parsed, "merge");
    await reloadLocalState();
    toast(`Import selesai: ${stats.templates} template, ${stats.parts} part, ${stats.storages} storage`);
  }catch(e){
    uiAlert("Import backup gagal: " + e.message);
  }finally{
    input.value = "";
    setBusy(false);
  }
}

/* ================= LOGIN POP-UP MODAL & AUTH (TOKEN 30 HARI OFFLINE) ================= */
function openLoginModal(reasonText=""){
  const m = $("loginModal");
  if(!m) return;
  const rb = $("loginReasonBox");
  if(rb){
    if(reasonText){
      rb.textContent = reasonText;
      rb.classList.remove("hidden");
    }else{
      rb.classList.add("hidden");
    }
  }
  m.style.display = "flex";
  document.body.style.overflow = "hidden";
  updateLoginConfigHint();
  setTimeout(()=>{ if($("loginUser")) $("loginUser").focus(); }, 60);
}
function closeLoginModal(){
  const m = $("loginModal");
  if(m) m.style.display = "none";
  if(!anyModalOpen()) document.body.style.overflow = "";
}
function requireLogin(actionLabel="menyimpan perubahan"){
  if(currentUser) return true;
  openLoginModal(`Silakan login terlebih dahulu untuk ${actionLabel}. Dashboard dan data lokal tetap dapat dilihat tanpa login.`);
  return false;
}

async function login(){
  const u=normalizeText($("loginUser").value).toLowerCase(); const p=$("loginPass").value;
  if(!u || !p) return uiAlert("Username dan password wajib diisi.");
  if(!CNCSync.isOnline()) return uiAlert("Login pertama kali membutuhkan koneksi internet untuk membuat token perangkat 30 hari.");
  setBusy(true,"Login & membuat token perangkat 30 hari...");
  try{
    const deviceId = await CNCDB.getDeviceId();
    const deviceName = isAndroidNative() ? "Android APK" : ("PC Browser (" + (navigator.platform || "Desktop") + ")");
    const res = await CNCSync.postApi("login", {username:u, password:p, deviceId, deviceName}, { skipAuth: true });
    currentUser = res.user;
    await CNCDB.saveSession(currentUser);
    $("loginPass").value="";
    closeLoginModal();
    renderAuth();
    toast(`Login berhasil · sesi aktif ${res.tokenDays||30} hari (bisa offline)`);
    CNCSync.startAutoSync();
    await reloadLocalState();
    setTimeout(()=>CNCSync.syncNow({ force: true, silent: true }).then(()=>reloadLocalState()), 100);
  }catch(e){ uiAlert("Login gagal: "+e.message); }
  finally{ setBusy(false); }
}

async function tryAutoLogin(){
  try{
    await CNCDB.openDB();
    const sess = await CNCDB.loadSession();
    await reloadLocalState();
    await updateLoginConfigHint();
    if(!sess) return false;
    currentUser = sess;
    renderAuth();
    CNCSync.startAutoSync();
    toast(`Selamat datang kembali, ${sess.name || sess.username}${CNCSync.isOnline() ? "" : " (Mode Offline)"}`);
    if(CNCSync.isOnline()){
      setTimeout(()=>CNCSync.syncNow({ silent: true }).then(()=>reloadLocalState()), 250);
    }
    return true;
  }catch(e){ return false; }
}

async function logout(){
  const outbox = await CNCDB.getOutbox();
  if(outbox.length && !(await uiConfirm(`Masih ada ${outbox.length} antrean sync yang belum terkirim ke server.\nData lokal & antrean tetap tersimpan di perangkat. Lanjutkan logout?`, "Konfirmasi Logout", { okText: "Ya, Logout", danger: true }))){
    return;
  }
  const token = currentUser?.token || currentUser?.sessionToken || "";
  if(token && CNCSync.isOnline()){
    try{ await CNCSync.postApi("logout", {}, { token }); }catch(e){}
  }
  CNCSync.stopAutoSync();
  currentUser=null; activePage="home"; homeSelectedStorage=""; selectedQR.clear(); selectedTemplateId=""; distSelections.clear(); distSubmitting=false; selectedMoveTemplateId=""; selectedFieldStorage="";
  closeModal();
  await CNCDB.clearSession();
  renderAuth();
  await updateLoginConfigHint();
  toast("Logout berhasil · kembali ke Dashboard Publik");
}

function renderAuth(){
  const loggedIn = !!currentUser;
  if($("app")) $("app").classList.remove("hidden");
  if($("appShell")) $("appShell").classList.toggle("with-sidebar", loggedIn);
  if($("sideNav")) $("sideNav").classList.toggle("hidden", !loggedIn);
  if($("sideNavUserManagement")) $("sideNavUserManagement").classList.toggle("hidden", !isSuperAdmin());
  if($("bottomNav")) $("bottomNav").classList.toggle("hidden", !loggedIn);
  if($("btnHeaderLogin")) $("btnHeaderLogin").classList.toggle("hidden", loggedIn);
  if($("btnHeaderLogout")) $("btnHeaderLogout").classList.toggle("hidden", !loggedIn);
  if($("btnHeaderSync")) $("btnHeaderSync").classList.toggle("hidden", !loggedIn);
  if($("headerLastSync")) $("headerLastSync").classList.toggle("hidden", !loggedIn);
  if($("syncQueueBadge") && !loggedIn) $("syncQueueBadge").classList.add("hidden");
  if($("menuUserManagement")) $("menuUserManagement").classList.toggle("hidden", !isSuperAdmin());

  // Toggle elemen Dashboard publik (belum login) vs penuh (sudah login)
  if($("heroQuickBtnsAuth")) $("heroQuickBtnsAuth").classList.toggle("hidden", !loggedIn);
  if($("homeGuestStorageSearch")) $("homeGuestStorageSearch").classList.toggle("hidden", loggedIn);
  if($("homeFilterCard")) $("homeFilterCard").classList.toggle("hidden", !loggedIn);
  if($("homeAcrylicCard")) $("homeAcrylicCard").classList.toggle("hidden", !loggedIn);
  if($("homeMenuGrid")) $("homeMenuGrid").classList.toggle("hidden", !loggedIn);
  if($("homeRecentMovementsCard")) $("homeRecentMovementsCard").classList.toggle("hidden", !loggedIn);
  if($("kpiAcrylicCard")) $("kpiAcrylicCard").classList.toggle("hidden", !loggedIn);
  if($("kpiLeftoverCard")) $("kpiLeftoverCard").classList.toggle("hidden", !loggedIn);
  if($("homeAnalyticsGrid")) $("homeAnalyticsGrid").classList.toggle("single-col", !loggedIn);
  if($("homeKpiBox")){
    $("homeKpiBox").style.gridTemplateColumns = loggedIn ? "" : "repeat(3,minmax(0,1fr))";
  }
  if($("homeStorageSubtitle")){
    $("homeStorageSubtitle").textContent = loggedIn
      ? "Klik kartu lokasi/storage untuk melihat rincian template di dalamnya"
      : "Sebaran template & total buyer per meja / storage";
  }

  if($("whoami")){
    $("whoami").classList.toggle("hidden", !loggedIn);
    $("whoami").textContent = loggedIn ? `${currentUser.name || currentUser.username} · ${currentUser.role}` : "";
  }

  homeStorageSlideIndex = 0;
  if(!loggedIn){
    activePage = "home";
    homeSelectedStorage = "";
    document.querySelectorAll(".page").forEach(s=>s.classList.add("hidden"));
    if($("page-home")) $("page-home").classList.remove("hidden");
  }
  document.querySelectorAll(".bottom-nav button[data-page], .side-nav button[data-page]").forEach(b=>{
    b.classList.toggle("active", b.dataset.page === (activePage || "home"));
  });
  renderCurrentPage(activePage || "home");
}

async function showPage(page){
  const target = page || "home";
  if(target !== "home" && !currentUser){
    openLoginModal("Silakan login untuk mengakses menu ini.");
    return;
  }
  if(target === "userManagement" && !isSuperAdmin()){
    uiAlert("User Management khusus super admin.", "Akses Ditolak");
    return showPage("home");
  }
  activePage = target;
  if(activePage !== "home") stopHomeStorageAutoSlideTimer();
  document.querySelectorAll(".page").forEach(s=>s.classList.add("hidden"));
  const el=$("page-"+activePage); if(el) el.classList.remove("hidden");
  document.querySelectorAll(".bottom-nav button[data-page], .side-nav button[data-page]").forEach(b=>b.classList.toggle("active", b.dataset.page===activePage));
  if(!dataLoaded){
    try{ await reloadLocalState(); }catch(e){}
  }
  renderCurrentPage(activePage);
  if(activePage==="userManagement") loadUsers();
  if(activePage==="master") refreshAutoBackupUI();
  window.scrollTo({top:0,behavior:"smooth"});
}
function renderCurrentPage(page=activePage){
  if(!currentUser && page !== "home") page = "home";
  updateHeader();
  if(page==="home") renderHome();
  if(!currentUser) return;
  if(page==="acrylic") renderAcrylicPage();
  if(page==="dashboardStorage") renderDashboardStorage();
  if(page==="templateInput"){ renderSuggestions(); renderTemplateAcrylicOptions(); }
  if(page==="templateList") renderTemplates();
  if(page==="distribution") renderDistribution();
  if(page==="movement") renderMovementStart();
  if(page==="movementHistory") renderMovementHistoryPage();
  if(page==="storage") renderStorage();
  if(page==="master") renderMaster();
  if(page==="userManagement") renderUserManagement();
  if(page==="fieldUpdate") renderFieldUpdate();
  if(page==="printqr") renderPrintQRSelection();
  if(page==="templateQrPrint") renderTemplateQrSelection();
  if(page==="importExisting") renderImportPreview();
}
function renderAll(){ renderCurrentPage(); }
function updateHeader(){
  const total=db.templates.length;
  const waiting=db.templates.filter(isTemplateWaiting).length;
  const locCount=db.storages.filter(s=>s.code!=="WORKSHOP").length;
  const acrAvail=roundQty(db.acrylics.reduce((s,a)=>s+Number(a.qtyAvailable||0),0));
  const mode=currentUser
    ? `${total} template · ${waiting} waiting · ${acrAvail} lbr akrilik`
    : `${locCount} lokasi · ${total} template`;
  const el=$("headerSyncStatus"); if(el) el.textContent = mode;
  updateSyncIndicator(syncUiState);
}
function partsOf(templateId){ return db.parts.filter(p=>String(p.templateId)===String(templateId)); }
function isPartWaiting(p){
  const st=String(p?.status||"").trim().toUpperCase();
  return st!=="DISTRIBUTED" && st!=="OUT" && !String(p?.currentStorage||"").trim();
}
function isPartDistributed(p){
  return String(p?.status||"").trim().toUpperCase()==="DISTRIBUTED" && !!String(p?.currentStorage||"").trim();
}
function waitingPartsOf(templateId){ return partsOf(templateId).filter(isPartWaiting); }
function distributedPartsOf(templateId){ return partsOf(templateId).filter(isPartDistributed); }
function distributedPartsInStorage(templateId, code){
  const target=normalizeText(code);
  return partsOf(templateId).filter(p=>isPartDistributed(p) && normalizeText(p.currentStorage)===target);
}
function isTemplateWaiting(t){
  if(!t) return false;
  const ps=partsOf(t.id);
  if(ps.length) return ps.some(isPartWaiting);
  return String(t.status||"").toUpperCase()==="WAITING_DISTRIBUTION";
}
function isTemplatePartial(t){
  if(!t) return false;
  const ps=partsOf(t.id);
  return ps.some(isPartWaiting) && ps.some(isPartDistributed);
}
function templateStorages(t){
  if(!t) return [];
  const ps=distributedPartsOf(t.id);
  if(ps.length) return [...new Set(ps.map(p=>normalizeText(p.currentStorage)).filter(Boolean))];
  return String(t.currentStorage||"").split(",").map(s=>normalizeText(s)).filter(Boolean);
}
function templatesInStorage(code){
  const target=normalizeText(code);
  if(!target) return [];
  return db.templates.filter(t=>{
    const ps=partsOf(t.id);
    if(ps.length) return ps.some(p=>isPartDistributed(p) && normalizeText(p.currentStorage)===target);
    return t.status==="DISTRIBUTED" && normalizeText(t.currentStorage)===target;
  });
}
function formatPartList(parts){
  return (parts||[]).map(p=>`${p.part}${p.size?` [${p.size}]`:""}${Number(p.qty||1)>1?` (${p.qty})`:""}`).join(", ");
}
function partText(templateId){ return formatPartList(partsOf(templateId)); }
function partTextInStorage(templateId, code){
  const inSt=distributedPartsInStorage(templateId, code);
  return formatPartList(inSt.length ? inSt : partsOf(templateId));
}
function templateSearchText(t){ return [t.id,t.buyer,t.stylekp,t.status,t.currentStorage,templateStorages(t).join(" "),t.createdBy,t.acrylicSource,t.acrylicSpec,t.acrylicSourceTemplateId,partText(t.id)].join(" ").toLowerCase(); }

function partsKeyLocal(parts){
  const agg=new Map();
  (parts||[]).forEach(p=>{
    const part=normalizeText(p.part||p.name);
    if(!part) return;
    const size=normalizeText(p.size||p.ukuran||"");
    const qty=Math.max(1, Math.round(Number(p.qty||1)));
    const k=`${part}[${size}]`;
    agg.set(k, (agg.get(k)||0)+qty);
  });
  return [...agg.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,q])=>`${k}#${q}`).join("|");
}
function templatePartsKeyLocal(templateId){ return partsKeyLocal(partsOf(templateId)); }
function findDuplicateTemplateLocal(buyer, stylekp, parts){
  const key=partsKeyLocal(parts);
  return db.templates.find(t=>normalizeText(t.buyer)===buyer && normalizeText(t.stylekp)===stylekp && templatePartsKeyLocal(t.id)===key);
}

/* ================= INTERACTIVE DASHBOARD & AUTO-SLIDE STORAGE GRID ================= */
const HOME_STORAGE_SLIDE_MS = 4800;
let homeSelectedStorage = "";
let homeStorageSlideIndex = 0;
let homeStorageSlideCount = 1;
let homeStorageAutoPlay = true;
let homeStorageHoverPaused = false;
let homeStorageTimer = null;
let homeStorageTouchStartX = null;
let lastHomePerSlide = 0;

function getHomeStoragePerSlide(loggedIn){
  const w = Number(window.innerWidth || 1280);
  if(!loggedIn) return w >= 1101 ? 8 : 6;
  return 6;
}
function chunkStorageSlides(items, perSlide){
  const size = Math.max(1, perSlide || 6);
  const out = [];
  for(let i = 0; i < items.length; i += size){
    out.push(items.slice(i, i + size));
  }
  return out;
}
function stopHomeStorageAutoSlideTimer(){
  if(homeStorageTimer){
    clearTimeout(homeStorageTimer);
    homeStorageTimer = null;
  }
}
function applyHomeStorageSlidePosition(){
  const track = $("homeStorageSliderTrack");
  if(track){
    track.style.transform = `translateX(-${homeStorageSlideIndex * 100}%)`;
  }
  const info = $("homeStorageSlideInfo");
  if(info){
    info.textContent = `${homeStorageSlideIndex + 1} / ${homeStorageSlideCount}`;
  }
  document.querySelectorAll("#homeStorageSliderControls .slider-dot").forEach((dot, idx)=>{
    dot.classList.toggle("active", idx === homeStorageSlideIndex);
  });
}
function syncHomeStorageAutoSlideTimer(){
  stopHomeStorageAutoSlideTimer();
  if(!homeStorageAutoPlay || homeStorageSlideCount <= 1) return;
  if(activePage !== "home" || homeStorageHoverPaused) return;
  if(currentUser && homeSelectedStorage) return;
  if(document.hidden || anyModalOpen()) return;
  let armed = false;
  homeStorageTimer = setTimeout(()=>{
    if(!armed) return;
    homeStorageTimer = null;
    if(!homeStorageAutoPlay || homeStorageSlideCount <= 1 || activePage !== "home" || homeStorageHoverPaused || anyModalOpen()) return;
    if(currentUser && homeSelectedStorage) return;
    homeStorageSlideIndex = (homeStorageSlideIndex + 1) % homeStorageSlideCount;
    applyHomeStorageSlidePosition();
    syncHomeStorageAutoSlideTimer();
  }, HOME_STORAGE_SLIDE_MS);
  armed = true;
}
function stepHomeStorageSlide(delta){
  if(homeStorageSlideCount <= 1) return;
  homeStorageSlideIndex = (homeStorageSlideIndex + delta + homeStorageSlideCount) % homeStorageSlideCount;
  applyHomeStorageSlidePosition();
  syncHomeStorageAutoSlideTimer();
}
function goHomeStorageSlide(idx){
  if(homeStorageSlideCount <= 1) return;
  homeStorageSlideIndex = Math.max(0, Math.min(homeStorageSlideCount - 1, Number(idx) || 0));
  applyHomeStorageSlidePosition();
  syncHomeStorageAutoSlideTimer();
}
function toggleHomeStorageAutoSlide(){
  homeStorageAutoPlay = !homeStorageAutoPlay;
  const btn = $("homeSliderAutoBtn");
  if(btn){
    btn.classList.toggle("on", homeStorageAutoPlay);
    btn.textContent = homeStorageAutoPlay ? "⏸ Auto Slide" : "▶ Auto Slide";
  }
  syncHomeStorageAutoSlideTimer();
}
function setHomeSliderHover(paused){
  homeStorageHoverPaused = !!paused;
  syncHomeStorageAutoSlideTimer();
}
function onHomeSliderTouchStart(ev){
  const t = ev?.touches?.[0];
  homeStorageTouchStartX = t ? t.clientX : null;
  setHomeSliderHover(true);
}
function onHomeSliderTouchEnd(ev){
  const t = ev?.changedTouches?.[0];
  if(homeStorageTouchStartX != null && t){
    const dx = t.clientX - homeStorageTouchStartX;
    if(Math.abs(dx) > 42){
      stepHomeStorageSlide(dx < 0 ? 1 : -1);
    }
  }
  homeStorageTouchStartX = null;
  setHomeSliderHover(false);
}
function onHomeGuestSearchInput(){
  homeStorageSlideIndex = 0;
  renderHomeAnalyticsDebounced();
}
window.addEventListener("resize", debounceRaw(()=>{
  if(activePage === "home"){
    const nextPer = getHomeStoragePerSlide(!!currentUser);
    if(nextPer !== lastHomePerSlide) renderHomeAnalytics();
  }
}, 220));
document.addEventListener("visibilitychange", ()=>{
  if(document.hidden) stopHomeStorageAutoSlideTimer();
  else if(activePage === "home") syncHomeStorageAutoSlideTimer();
});

function openFilteredTemplates(statusVal){
  if(!requireLogin("melihat daftar detail template")) return;
  showPage("templateList").then(()=>{
    if($("templateStatusFilter")) $("templateStatusFilter").value = statusVal || "";
    renderTemplates();
  });
}
function resetHomeFilter(){
  ["homeBuyerFilter","homeStyleFilter","homeStorageFilter","homeQuickSearch","homeGuestStorageSearch"].forEach(id=>{ if($(id)) $(id).value=""; });
  homeSelectedStorage = "";
  homeStorageSlideIndex = 0;
  renderHomeAnalytics();
}
function selectHomeStorage(code){
  if(!currentUser){
    openLoginModal(`Silakan login untuk melihat detail template pada lokasi ${code}.`);
    return;
  }
  homeSelectedStorage = homeSelectedStorage === code ? "" : code;
  renderHomeAnalytics();
}
function renderHome(){
  if(!$("sumTemplates")) return;
  const loggedIn = !!currentUser;
  if($("menuUserManagement")) $("menuUserManagement").classList.toggle("hidden", !isSuperAdmin());
  const totalAvailAcr = roundQty(db.acrylics.reduce((s,a)=>s+Number(a.qtyAvailable||0),0));
  const leftoverCount = db.templates.filter(t=>String(t.acrylicSource||"").toUpperCase()==="LEFTOVER").length;
  $("sumTemplates").textContent = db.templates.length;
  $("sumWaiting").textContent = db.templates.filter(isTemplateWaiting).length;
  $("sumDistributed").textContent = db.templates.filter(t=>!isTemplateWaiting(t) && t.status==="DISTRIBUTED").length;
  if($("sumAcrylicAvail")) $("sumAcrylicAvail").textContent = totalAvailAcr;
  if($("sumAcrylicSub")) $("sumAcrylicSub").textContent = `${db.acrylics.length} jenis ukuran`;
  if($("sumLeftoverTpl")) $("sumLeftoverTpl").textContent = leftoverCount;

  if(loggedIn){
    selectOptions("homeBuyerFilter", [...new Set(db.templates.map(t=>t.buyer).filter(Boolean))].sort(), "Semua Buyer");
    selectOptions("homeStyleFilter", [...new Set(db.templates.map(t=>t.stylekp).filter(Boolean))].sort(), "Semua Style / KP");
    selectOptions("homeStorageFilter", db.storages.filter(s=>s.code!=="WORKSHOP").map(s=>s.code), "Semua Storage");
  }

  renderHomeAnalytics();

  if(loggedIn && $("recentMovements")){
    const recent=[...db.movements].sort(movementSortNewest).slice(0,5);
    $("recentMovements").innerHTML = recent.length ? recent.map(m=>{
      const t=db.templates.find(x=>x.id===m.templateId) || {};
      return `<div class="line-item mh-item"><div class="mh-icon">${movementIcon(m.type)}</div><div><b>${esc(m.type)}</b><span>${esc(t.buyer||"")} ${esc(t.stylekp||"")} · ${esc(m.from||"-")} → ${esc(m.to||"-")} · ${dateTimeText(m.at)}</span></div></div>`;
    }).join("") : `<div class="empty">Belum ada movement terbaru.</div>`;
  }else if($("recentMovements")){
    $("recentMovements").innerHTML = "";
  }
}

function renderHomeStorageCardHtml(item, maxCount, loggedIn){
  const pct = item.tplCount ? Math.max(8, Math.round((item.tplCount / maxCount) * 100)) : 0;
  const isActive = loggedIn && homeSelectedStorage === item.storage.code;
  const subLabel = [item.storage.name, item.storage.area].filter(Boolean).join(" · ") || "Lokasi Storage";
  return `<article class="home-storage-card ${isActive ? "active" : ""}" onclick="selectHomeStorage('${escAttr(item.storage.code)}')">
    <div class="hsc-top">
      <div class="hsc-title">
        <b class="hsc-code">${esc(item.storage.code)}</b>
        <span class="hsc-name">${esc(subLabel)}</span>
      </div>
      <span class="hsc-count ${item.tplCount === 0 ? "is-empty" : ""}">${item.tplCount}</span>
    </div>
    <div class="hsc-track"><div class="hsc-fill" style="width:${pct}%"></div></div>
    <div class="hsc-foot">
      <span class="hsc-meta"><b>${item.buyerCount}</b> Buyer</span>
      <span class="hsc-meta"><b>${item.tplCount}</b> Template${loggedIn && item.partQty ? ` · ${item.partQty} pcs` : ""}</span>
    </div>
  </article>`;
}

function renderHomeStorageSliderHtml(storages, loggedIn){
  const perSlide = getHomeStoragePerSlide(loggedIn);
  lastHomePerSlide = perSlide;
  if(!storages.length){
    homeStorageSlideCount = 1;
    homeStorageSlideIndex = 0;
    stopHomeStorageAutoSlideTimer();
    return loggedIn
      ? `<div class="empty">Belum ada data storage sesuai filter.</div>`
      : `<div class="empty">Belum ada data lokasi/storage di perangkat ini.</div>`;
  }

  const maxCount = Math.max(1, ...storages.map(x=>x.tplCount));
  const slides = chunkStorageSlides(storages, perSlide);
  homeStorageSlideCount = slides.length;

  if(loggedIn && homeSelectedStorage){
    const foundSlide = slides.findIndex(page => page.some(x => x.storage.code === homeSelectedStorage));
    if(foundSlide >= 0) homeStorageSlideIndex = foundSlide;
  }
  if(homeStorageSlideIndex >= homeStorageSlideCount) homeStorageSlideIndex = 0;

  const gridVariant = loggedIn ? "auth-grid" : "guest-grid";
  const pagesHtml = slides.map(page => `
    <div class="storage-slide-page">
      <div class="home-storage-grid ${gridVariant}">
        ${page.map(item => renderHomeStorageCardHtml(item, maxCount, loggedIn)).join("")}
      </div>
    </div>`).join("");

  const controlsHtml = homeStorageSlideCount > 1 ? `
    <div class="storage-slider-controls" id="homeStorageSliderControls">
      <button type="button" class="slider-auto-btn ${homeStorageAutoPlay ? "on" : ""}" id="homeSliderAutoBtn" onclick="toggleHomeStorageAutoSlide()">${homeStorageAutoPlay ? "⏸ Auto Slide" : "▶ Auto Slide"}</button>
      <div class="slider-dots">
        ${slides.map((_, idx) => `<button type="button" class="slider-dot ${idx === homeStorageSlideIndex ? "active" : ""}" onclick="goHomeStorageSlide(${idx})" aria-label="Halaman ${idx + 1}"></button>`).join("")}
      </div>
      <div class="slider-nav-group">
        <button type="button" class="slider-nav-btn" onclick="stepHomeStorageSlide(-1)" aria-label="Sebelumnya">‹</button>
        <span class="slider-page-info" id="homeStorageSlideInfo">${homeStorageSlideIndex + 1} / ${homeStorageSlideCount}</span>
        <button type="button" class="slider-nav-btn" onclick="stepHomeStorageSlide(1)" aria-label="Berikutnya">›</button>
      </div>
    </div>` : "";

  return `<div class="storage-slider" id="homeStorageSlider" onmouseenter="setHomeSliderHover(true)" onmouseleave="setHomeSliderHover(false)" ontouchstart="onHomeSliderTouchStart(event)" ontouchend="onHomeSliderTouchEnd(event)">
    <div class="storage-slider-viewport">
      <div class="storage-slider-track" id="homeStorageSliderTrack" style="transform:translateX(-${homeStorageSlideIndex * 100}%)">
        ${pagesHtml}
      </div>
    </div>
    ${controlsHtml}
  </div>`;
}

function renderHomeAnalytics(){
  const loggedIn = !!currentUser;
  const chartBox = $("homeStorageChart");
  const drillBox = $("homeStorageDrilldown");

  // MODE BELUM LOGIN: Grid Card per storage + auto-slide + total buyer/template (tanpa bocorkan nama buyer/style)
  if(!loggedIn){
    const guestQ = ($("homeGuestStorageSearch")?.value || "").trim().toLowerCase();
    const storages = db.storages
      .filter(s=>s.code!=="WORKSHOP" && (!guestQ || [s.code, s.name, s.area].join(" ").toLowerCase().includes(guestQ)))
      .map(s=>{
        const tpls = templatesInStorage(s.code);
        const buyerCount = new Set(tpls.map(t=>normalizeText(t.buyer)).filter(Boolean)).size;
        return { storage: s, tplCount: tpls.length, buyerCount, partQty: 0 };
      })
      .sort((a,b)=>b.tplCount - a.tplCount || a.storage.code.localeCompare(b.storage.code));

    if($("homeStorageCounter")) $("homeStorageCounter").textContent = `${storages.length} lokasi`;
    if(drillBox){ drillBox.classList.add("hidden"); drillBox.innerHTML = ""; }
    if(chartBox){
      chartBox.innerHTML = renderHomeStorageSliderHtml(storages, false);
    }
    if($("homeAcrylicSummary")) $("homeAcrylicSummary").innerHTML = "";
    syncHomeStorageAutoSlideTimer();
    return;
  }

  // MODE SUDAH LOGIN: Grid Card + Auto-Slide + Drilldown detail template per lokasi/storage + Ringkasan Akrilik
  const buyer = $("homeBuyerFilter")?.value || "";
  const style = $("homeStyleFilter")?.value || "";
  const stFilter = $("homeStorageFilter")?.value || "";
  const q = ($("homeQuickSearch")?.value || "").trim().toLowerCase();

  const matchTpl = (t) => {
    if(buyer && t.buyer !== buyer) return false;
    if(style && t.stylekp !== style) return false;
    if(q && !templateSearchText(t).includes(q)) return false;
    return true;
  };

  const storages = db.storages
    .filter(s=>s.code!=="WORKSHOP" && (!stFilter || s.code===stFilter))
    .map(s=>{
      const tpls = templatesInStorage(s.code).filter(matchTpl);
      const buyerCount = new Set(tpls.map(t=>normalizeText(t.buyer)).filter(Boolean)).size;
      const partQty = tpls.reduce((acc,t)=>acc + distributedPartsInStorage(t.id, s.code).reduce((a,p)=>a+Number(p.qty||1),0), 0);
      return { storage: s, tpls, tplCount: tpls.length, buyerCount, partQty };
    })
    .sort((a,b)=>b.tplCount - a.tplCount || a.storage.code.localeCompare(b.storage.code));

  if($("homeStorageCounter")) $("homeStorageCounter").textContent = `${storages.length} storage`;
  if(chartBox){
    chartBox.innerHTML = renderHomeStorageSliderHtml(storages, true);

    if(drillBox){
      const picked = storages.find(x=>x.storage.code === homeSelectedStorage);
      if(picked){
        drillBox.classList.remove("hidden");
        drillBox.innerHTML = `
          <div class="topline" style="margin-bottom:6px">
            <div><b>🗄️ ${esc(picked.storage.code)} · ${esc(picked.storage.name||"")}</b><div class="muted">${picked.buyerCount} buyer · ${picked.tplCount} template (${picked.partQty} pcs part)</div></div>
            <div class="actions" style="margin:0">
              <button class="small primary" type="button" onclick="openStorage('${escAttr(picked.storage.code)}')">Detail Penuh</button>
              <button class="small" type="button" onclick="goFieldUpdateStorage('${escAttr(picked.storage.code)}')">+ Update Lapangan</button>
            </div>
          </div>
          ${picked.tpls.length ? picked.tpls.slice(0,8).map(t=>`
            <div class="line-item" style="cursor:pointer;background:#fff" onclick="openTemplateDetail('${escAttr(t.id)}')">
              <b>${esc(t.buyer)} · ${esc(t.stylekp)}</b>
              <span>${esc(partTextInStorage(t.id, picked.storage.code))}</span>
            </div>`).join("") + (picked.tpls.length > 8 ? `<div class="muted">+ ${picked.tpls.length - 8} template lainnya — klik Detail Penuh.</div>` : "")
          : `<div class="muted">Storage ini masih kosong untuk filter saat ini.</div>`}`;
      }else{
        drillBox.classList.add("hidden");
      }
    }
  }
  syncHomeStorageAutoSlideTimer();

  // Ringkasan Akrilik di Dashboard
  const acrBox = $("homeAcrylicSummary");
  if(acrBox){
    const newSheetCount = db.templates.filter(t=>String(t.acrylicSource||"").toUpperCase()==="NEW_SHEET").length;
    const leftoverCount = db.templates.filter(t=>String(t.acrylicSource||"").toUpperCase()==="LEFTOVER").length;
    const stocks = [...db.acrylics].filter(a=>!q || formatAcrylicSpec(a).toLowerCase().includes(q) || String(a.note||"").toLowerCase().includes(q))
      .sort((a,b)=>Number(a.qtyAvailable||0) - Number(b.qtyAvailable||0));
    const headChips = `<div class="chip-row" style="margin-top:0">
      <span class="badge acrylic">🧱 Stok Baru: ${newSheetCount} template</span>
      <span class="badge leftover">♻️ Sisa Template: ${leftoverCount} template</span>
    </div>`;
    if(!stocks.length){
      acrBox.innerHTML = headChips + `<div class="empty">Belum ada stok akrilik tercatat.<br><button class="small primary" style="margin-top:8px" onclick="showPage('acrylic')">+ Input Stok Akrilik</button></div>`;
    }else{
      acrBox.innerHTML = headChips + stocks.slice(0, 6).map(a=>{
        const pct = a.qtyIn > 0 ? Math.max(0, Math.min(100, Math.round((a.qtyAvailable / a.qtyIn) * 100))) : 0;
        const barCls = a.qtyAvailable <= 0 ? "bad" : (a.qtyAvailable <= 2 ? "warn" : "good");
        const stBadge = a.qtyAvailable <= 0 ? `<span class="badge bad">Habis</span>` : (a.qtyAvailable <= 2 ? `<span class="badge warn">Menipis</span>` : `<span class="badge good">Aman</span>`);
        return `<div class="chart-row" onclick="showPage('acrylic')">
          <div class="chart-row-head">
            <b>${esc(formatAcrylicSpec(a))}</b>
            <span>${stBadge} <b>${roundQty(a.qtyAvailable)}</b>/${roundQty(a.qtyIn)} lbr</span>
          </div>
          <div class="chart-track"><div class="chart-fill ${barCls}" style="width:${pct}%"></div></div>
        </div>`;
      }).join("");
    }
  }
}
const renderHomeAnalyticsDebounced = debounce(renderHomeAnalytics, 160);

function movementSortNewest(a,b){const da=Date.parse(a?.at||"");const db=Date.parse(b?.at||"");return Number.isFinite(da)&&Number.isFinite(db)?db-da:String(b?.at||"").localeCompare(String(a?.at||""));}
function movementIcon(type){
  const map={DISTRIBUTE:"📦",TRANSFER:"🔁",REPAIR:"🛠️",RETURN:"↩️",OUT:"🚚",IMPORT_EXISTING:"📥",UPDATE_EXISTING:"📝"};
  return map[String(type||"").toUpperCase()] || "📄";
}

/* ================= FLOW AKRILIK (BAHAN BAKU & TRACEABILITY SISA) ================= */
let acrylicStockFilter = "all";
let acrylicLogFilter = "ALL";
let tplAcrylicMode = "NEW_SHEET";

function setAcrThickness(mm){
  if($("acrThickness")) $("acrThickness").value = mm;
}
function setAcrylicStockFilter(f, el){
  acrylicStockFilter = f || "all";
  document.querySelectorAll("#acrFilterChips .chip").forEach(c=>c.classList.toggle("active", c===el));
  renderAcrylicPage();
}
function setAcrylicLogFilter(f, el){
  acrylicLogFilter = f || "ALL";
  document.querySelectorAll("#acrLogFilterChips .chip").forEach(c=>c.classList.toggle("active", c===el));
  renderAcrylicPage();
}
function prefillAcrylicStock(aid){
  const a = db.acrylics.find(x=>String(x.id)===String(aid));
  if(!a) return;
  $("acrLength").value = a.length;
  $("acrWidth").value = a.width;
  $("acrUnit").value = a.unit || "cm";
  $("acrThickness").value = a.thicknessMm;
  $("acrColor").value = a.color || "";
  $("acrQty").value = 1;
  $("acrNote").value = a.note || "";
  toast(`Form diisi spec ${formatAcrylicSpec(a)} — masukkan qty tambah lalu Simpan`);
  window.scrollTo({top:0,behavior:"smooth"});
}
function clearAcrylicForm(){
  ["acrLength","acrWidth","acrThickness","acrColor","acrNote"].forEach(id=>{ if($(id)) $(id).value=""; });
  if($("acrUnit")) $("acrUnit").value = "cm";
  if($("acrQty")) $("acrQty").value = "1";
}
function acrylicSpecKey(length, width, unit, thicknessMm, color){
  return [roundQty(length), roundQty(width), String(unit||"cm").toLowerCase(), roundQty(thicknessMm), normalizeText(color||"")].join("|");
}
async function saveAcrylicStockIn(){
  if(!requireLogin("menyimpan stok akrilik masuk")) return;
  const length = roundQty($("acrLength")?.value);
  const width = roundQty($("acrWidth")?.value);
  const unit = ($("acrUnit")?.value || "cm").toLowerCase() === "mm" ? "mm" : "cm";
  const thicknessMm = roundQty($("acrThickness")?.value);
  const color = normalizeText($("acrColor")?.value || "");
  const qty = roundQty($("acrQty")?.value);
  const note = String($("acrNote")?.value || "").trim();

  if(length <= 0 || width <= 0) return uiAlert("Panjang dan Lebar akrilik harus lebih dari 0.");
  if(thicknessMm <= 0) return uiAlert("Tebal akrilik (mm) harus lebih dari 0.");
  if(qty <= 0) return uiAlert("Qty lembar masuk harus lebih dari 0.");

  setBusy(true, "Menyimpan stok akrilik ke database lokal...");
  try{
    const now = nowISO();
    const specKey = acrylicSpecKey(length, width, unit, thicknessMm, color);
    const existing = db.acrylics.find(a=>acrylicSpecKey(a.length, a.width, a.unit, a.thicknessMm, a.color) === specKey);
    const aid = existing ? existing.id : id("ACR");
    const logId = id("ACRLOG");
    const nextIn = roundQty((existing ? existing.qtyIn : 0) + qty);
    const nextUsed = roundQty(existing ? existing.qtyUsed : 0);
    const nextAvail = roundQty(Math.max(0, nextIn - nextUsed));

    const acrylicObj = {
      id: aid,
      length,
      width,
      unit,
      thicknessMm,
      color,
      qtyIn: nextIn,
      qtyUsed: nextUsed,
      qtyAvailable: nextAvail,
      note: note || (existing ? existing.note : ""),
      createdBy: existing ? (existing.createdBy || userName()) : userName(),
      createdAt: existing ? (existing.createdAt || now) : now,
      updatedAt: now,
      deleted: false
    };
    const logObj = {
      id: logId,
      acrylicId: aid,
      templateId: "",
      sourceType: "IN",
      sourceTemplateId: "",
      qty,
      sizeLabel: formatAcrylicSpec(acrylicObj),
      by: userName(),
      note: note || (existing ? "Tambah stok masuk" : "Stok masuk awal"),
      at: now
    };

    await CNCDB.putOne("acrylics", acrylicObj);
    await CNCDB.putOne("acrylicLogs", logObj);
    await CNCSync.enqueueAndSync("stockInAcrylic", {
      id: aid,
      logId,
      length,
      width,
      unit,
      thicknessMm,
      color,
      qty,
      note,
      createdBy: userName(),
      createdAt: now,
      updatedAt: now
    });
    await reloadLocalState();
    clearAcrylicForm();
    toast(`Stok akrilik ${formatAcrylicSpec(acrylicObj)} (+${qty} lbr) tersimpan`);
  }catch(e){
    uiAlert("Gagal simpan stok akrilik: " + e.message);
  }finally{
    setBusy(false);
  }
}

async function softDeleteAcrylic(aid){
  if(!requireLogin("menghapus stok akrilik")) return;
  if(!isAdmin()) return uiAlert("Hapus stok akrilik khusus admin dan super_admin.");
  const a = db.acrylics.find(x=>String(x.id)===String(aid));
  if(!a) return;
  if(!(await uiConfirm(`Hapus stok akrilik ${formatAcrylicSpec(a)}?\nData ditandai soft-delete dan akan disinkronkan ke perangkat lain.`, "Hapus Stok Akrilik", { okText: "Ya, Hapus", danger: true }))) return;
  const now = nowISO();
  await CNCDB.putOne("acrylics", { ...a, deleted: true, updatedAt: now });
  await CNCSync.enqueueAndSync("softDeleteAcrylic", { id: a.id, updatedAt: now });
  await reloadLocalState();
  toast("Stok akrilik dihapus (soft delete)");
}

function renderAcrylicPage(){
  if(!$("acrylicStockList")) return;
  const totalIn = roundQty(db.acrylics.reduce((s,a)=>s+Number(a.qtyIn||0),0));
  const totalUsed = roundQty(db.acrylics.reduce((s,a)=>s+Number(a.qtyUsed||0),0));
  const totalAvail = roundQty(db.acrylics.reduce((s,a)=>s+Number(a.qtyAvailable||0),0));
  if($("acrStatTypes")) $("acrStatTypes").textContent = db.acrylics.length;
  if($("acrStatIn")) $("acrStatIn").textContent = totalIn;
  if($("acrStatUsed")) $("acrStatUsed").textContent = totalUsed;
  if($("acrStatAvail")) $("acrStatAvail").textContent = totalAvail;

  const q = ($("acrSearch")?.value || "").trim().toLowerCase();
  const list = db.acrylics.filter(a=>{
    if(acrylicStockFilter === "available" && a.qtyAvailable <= 0) return false;
    if(acrylicStockFilter === "low" && !(a.qtyAvailable > 0 && a.qtyAvailable <= 2)) return false;
    if(acrylicStockFilter === "empty" && a.qtyAvailable > 0) return false;
    if(q && ![a.id, formatAcrylicSpec(a), a.color, a.note].join(" ").toLowerCase().includes(q)) return false;
    return true;
  }).sort((a,b)=>b.qtyAvailable - a.qtyAvailable || a.thicknessMm - b.thicknessMm);

  $("acrylicStockList").innerHTML = list.length ? list.map(a=>{
    const pct = a.qtyIn > 0 ? Math.max(0, Math.min(100, Math.round((a.qtyAvailable / a.qtyIn) * 100))) : 0;
    const barCls = a.qtyAvailable <= 0 ? "bad" : (a.qtyAvailable <= 2 ? "warn" : "good");
    const statusTag = a.qtyAvailable <= 0 ? `<span class="badge bad">Habis</span>` : (a.qtyAvailable <= 2 ? `<span class="badge warn">Menipis</span>` : `<span class="badge good">Tersedia</span>`);
    return `<div class="line-item" style="background:#fff">
      <div class="topline" style="margin-bottom:4px">
        <div>
          <b>🧱 ${esc(formatAcrylicSpec(a))} ${statusTag}</b>
          <span>Masuk: <b>${roundQty(a.qtyIn)}</b> lbr · Terpakai: <b>${roundQty(a.qtyUsed)}</b> lbr · Sisa: <b style="color:var(--navy-800)">${roundQty(a.qtyAvailable)}</b> lbr</span>
          ${a.note ? `<small>Catatan: ${esc(a.note)} · ID: ${esc(a.id)}</small>` : `<small>ID: ${esc(a.id)} · update ${dateTimeText(a.updatedAt)}</small>`}
        </div>
        <div class="actions" style="margin:0">
          <button class="small primary" type="button" onclick="prefillAcrylicStock('${escAttr(a.id)}')">+ Tambah Stok</button>
          ${isAdmin() ? `<button class="small bad" type="button" onclick="softDeleteAcrylic('${escAttr(a.id)}')">Hapus</button>` : ""}
        </div>
      </div>
      <div class="chart-track"><div class="chart-fill ${barCls}" style="width:${pct}%"></div></div>
    </div>`;
  }).join("") : `<div class="empty">Belum ada data stok akrilik sesuai filter.</div>`;

  const logs = [...db.acrylicLogs]
    .filter(l=>acrylicLogFilter === "ALL" || String(l.sourceType||"").toUpperCase() === acrylicLogFilter)
    .sort((a,b)=>movementSortNewest(a,b))
    .slice(0, 40);

  $("acrylicLogList").innerHTML = logs.length ? logs.map(l=>{
    const st = String(l.sourceType||"").toUpperCase();
    const t = l.templateId ? db.templates.find(x=>x.id===l.templateId) : null;
    const srcT = l.sourceTemplateId ? db.templates.find(x=>x.id===l.sourceTemplateId) : null;
    const badge = st === "IN" ? `<span class="badge good">+ STOK MASUK (+${roundQty(l.qty)} lbr)</span>`
      : st === "NEW_SHEET" ? `<span class="badge acrylic">- PAKAI BARU (-${roundQty(l.qty)} lbr)</span>`
      : `<span class="badge leftover">♻️ SISA TEMPLATE (0 lbr baru)</span>`;
    return `<div class="line-item">
      <b>${badge} ${esc(l.sizeLabel || "-")}</b>
      <span>${t ? `Template: <b>${esc(t.buyer)} · ${esc(t.stylekp)}</b> (${esc(t.id)})` : (l.templateId ? `Template: ${esc(l.templateId)}` : "Penambahan stok gudang")}${srcT ? ` · Asal sisa: <b>${esc(srcT.buyer)} · ${esc(srcT.stylekp)}</b>` : (l.sourceTemplateId ? ` · Asal sisa: ${esc(l.sourceTemplateId)}` : "")}</span>
      <small>${esc(l.by || "-")} · ${dateTimeText(l.at)}${l.note ? ` · ${esc(l.note)}` : ""}</small>
    </div>`;
  }).join("") : `<div class="empty">Belum ada riwayat transaksi akrilik.</div>`;
}

function setTemplateAcrylicMode(mode){
  tplAcrylicMode = mode || "NEW_SHEET";
  document.querySelectorAll("#tplAcrylicModeGrid .acrylic-mode-card").forEach(el=>{
    el.classList.toggle("active", el.dataset.mode === tplAcrylicMode);
  });
  if($("tplAcrylicNewBox")) $("tplAcrylicNewBox").classList.toggle("hidden", tplAcrylicMode !== "NEW_SHEET");
  if($("tplAcrylicLeftoverBox")) $("tplAcrylicLeftoverBox").classList.toggle("hidden", tplAcrylicMode !== "LEFTOVER");
  updateTplAcrylicPreview();
}
function setTplAcrylicQty(val){
  if($("tplAcrylicQty")) $("tplAcrylicQty").value = val;
  updateTplAcrylicPreview();
}
function renderTemplateAcrylicOptions(){
  const sel = $("tplAcrylicId");
  if(sel){
    const cur = sel.value;
    const avail = db.acrylics.filter(a=>a.qtyAvailable > 0).sort((a,b)=>a.thicknessMm - b.thicknessMm || b.qtyAvailable - a.qtyAvailable);
    sel.innerHTML = `<option value="">-- Pilih Stok Akrilik Tersedia --</option>` + avail.map(a=>`<option value="${escAttr(a.id)}">${esc(formatAcrylicSpec(a))} — Sisa: ${roundQty(a.qtyAvailable)} lbr</option>`).join("");
    if(avail.some(a=>a.id === cur)) sel.value = cur;
    else if(avail.length === 1) sel.value = avail[0].id;
  }
  const srcSel = $("tplLeftoverSourceId");
  if(srcSel){
    const curSrc = srcSel.value;
    const q = ($("tplLeftoverSearch")?.value || "").trim().toLowerCase();
    const tpls = db.templates.filter(t=>!q || `${t.buyer} ${t.stylekp} ${t.id} ${t.acrylicSpec}`.toLowerCase().includes(q)).slice(0, 120);
    srcSel.innerHTML = `<option value="">-- Pilih Template Asal Sisa Akrilik --</option>` + tpls.map(t=>`<option value="${escAttr(t.id)}">${esc(t.buyer)} · ${esc(t.stylekp)} (${esc(t.id)})${t.acrylicSpec ? " — " + esc(t.acrylicSpec) : ""}</option>`).join("");
    if(tpls.some(t=>t.id === curSrc)) srcSel.value = curSrc;
  }
  updateTplAcrylicPreview();
}
function updateTplAcrylicPreview(){
  const box = $("tplAcrylicPreview");
  if(!box || tplAcrylicMode !== "NEW_SHEET") return;
  const aid = $("tplAcrylicId")?.value || "";
  const qty = roundQty($("tplAcrylicQty")?.value);
  if(!db.acrylics.some(a=>a.qtyAvailable > 0)){
    box.className = "dist-alert warn";
    box.innerHTML = `Belum ada stok akrilik tersedia. Klik <b>+ Input Stok Akrilik</b>, atau pilih <b>♻️ Sisa Akrilik Template Lain</b> / <b>Tanpa Catat Akrilik</b>.`;
    return;
  }
  if(!aid){
    box.className = "dist-alert info";
    box.textContent = "Pilih ukuran akrilik yang dipakai. Stok akan otomatis berkurang saat template disimpan.";
    return;
  }
  const a = db.acrylics.find(x=>x.id===aid);
  if(!a) return;
  if(qty <= 0){
    box.className = "dist-alert bad";
    box.textContent = "Qty lembar dipakai harus lebih dari 0 (bisa desimal, misal 0.5 atau 1).";
    return;
  }
  if(qty > a.qtyAvailable + 1e-9){
    box.className = "dist-alert bad";
    box.innerHTML = `Stok tidak mencukupi! Tersedia <b>${roundQty(a.qtyAvailable)} lbr</b>, diminta <b>${qty} lbr</b>.`;
    return;
  }
  const after = roundQty(a.qtyAvailable - qty);
  box.className = "dist-alert good";
  box.innerHTML = `🧱 <b>${esc(formatAcrylicSpec(a))}</b> · Stok akan berkurang: <b>${roundQty(a.qtyAvailable)} → ${after} lembar</b>.`;
}
function acrylicBadgeHtml(t){
  const src = String(t?.acrylicSource || "").toUpperCase();
  if(src === "NEW_SHEET"){
    return `<span class="badge acrylic">🧱 ${esc(t.acrylicSpec || "Akrilik Baru")}${t.acrylicQty ? ` (-${roundQty(t.acrylicQty)} lbr)` : ""}</span>`;
  }
  if(src === "LEFTOVER"){
    const srcT = t.acrylicSourceTemplateId ? db.templates.find(x=>x.id===t.acrylicSourceTemplateId) : null;
    const lbl = srcT ? `${srcT.buyer} · ${srcT.stylekp}` : (t.acrylicSourceTemplateId || "Template lain");
    return `<span class="badge leftover">♻️ Sisa: ${esc(lbl)}</span>`;
  }
  return "";
}

/* ================= MOVEMENT HISTORY (menu + filter + lazy load) ================= */
let mhDays = -1;               // -1 = semua periode; hasil tampilan selalu maksimal lima
let mhServerRows = null;       // tetap null: history dibaca dari database lokal (IndexedDB)
let mhShownCount = 30;         // lazy loading: tampilkan bertahap
const MH_PAGE_SIZE = 30;

function renderMovementHistoryPage(){
  selectOptions("mhStorage", db.storages.map(s=>s.code), "Semua Storage");
  renderMovementHistory();
}
function setMhPeriod(days, el){
  mhDays = Number(days);
  document.querySelectorAll("#mhPeriodChips .chip").forEach(c=>c.classList.toggle("active", c===el));
  $("mhCustomDateRow").classList.toggle("hidden", mhDays !== 0);
  mhServerRows = null; mhShownCount = MH_PAGE_SIZE;
  renderMovementHistory();
}
function currentMhFilters(){
  return {
    type: $("mhType")?.value || "",
    storage: $("mhStorage")?.value || "",
    q: ($("mhSearch")?.value || "").trim()
  };
}
async function applyMovementHistoryFilter(){
  mhServerRows=null;
  mhShownCount=5;
  renderMovementHistory();
  const info=$("mhInfo"); if(info){info.classList.remove("hidden");info.textContent="Filter diterapkan dari database lokal; ditampilkan maksimal 5 movement terbaru.";}
}

function resetMovementHistoryFilter(){
  ["mhType","mhStorage","mhSearch","mhFrom","mhTo"].forEach(id=>{ if($(id)) $(id).value=""; });
  mhDays = -1; mhServerRows = null; mhShownCount = 5;
  document.querySelectorAll("#mhPeriodChips .chip").forEach(c=>c.classList.toggle("active", c.dataset.days==="-1"));
  $("mhCustomDateRow").classList.add("hidden");
  $("mhInfo").classList.add("hidden");
  renderMovementHistory();
}
function getMhRows(){
  const f = currentMhFilters();
  let rows;
  if(mhServerRows){
    rows = mhServerRows.map(m=>({...m}));
  }else{
    rows = db.movements.map(m=>{
      const t = db.templates.find(x=>x.id===m.templateId) || {};
      return {...m, buyer:t.buyer||"", stylekp:t.stylekp||""};
    });
  }
  const q = f.q.toUpperCase();
  const cutoff=mhDays>0?Date.now()-mhDays*864e5:null;
  const fromDate=mhDays===0?$("mhFrom")?.value:"";
  const toDate=mhDays===0?$("mhTo")?.value:"";
  rows = rows.filter(m=>{
    const time=Date.parse(m.at||"");
    if(cutoff && Number.isFinite(time) && time<cutoff) return false;
    if(fromDate && String(m.at||"").slice(0,10)<fromDate) return false;
    if(toDate && String(m.at||"").slice(0,10)>toDate) return false;
    if(f.type && String(m.type).toUpperCase() !== f.type.toUpperCase()) return false;
    if(f.storage && m.from !== f.storage && m.to !== f.storage) return false;
    if(q && ![m.type,m.from,m.to,m.by,m.note,m.templateId,m.buyer,m.stylekp].join(" ").toUpperCase().includes(q)) return false;
    return true;
  });
  rows.sort(movementSortNewest);
  return rows;
}
function renderMovementHistory(){
  const box=$("mhList"); if(!box) return;
  const rows = getMhRows();
  const shown = rows.slice(0, 5);
  const src = mhServerRows ? "hasil filter" : "database lokal";
  box.innerHTML = `<div class="muted" style="margin:8px 0">Cocok: <b>${rows.length}</b> · ditampilkan maksimal 5 terbaru · sumber: ${src}</div>` +
    (shown.length ? shown.map(m=>`<div class="line-item mh-item"><div class="mh-icon">${movementIcon(m.type)}</div><div style="flex:1"><b>${esc(m.type)} ${m.buyer?`· ${esc(m.buyer)} ${esc(m.stylekp)}`:""}</b><span>${esc(m.from||"-")} → ${esc(m.to||"-")} · oleh ${esc(m.by||"-")} · ${dateTimeText(m.at)}</span>${m.note?`<small>📝 ${esc(m.note)}</small>`:""}<small class="muted">${esc(m.templateId||"")}</small></div><button class="small" onclick="openTemplateDetail('${escAttr(m.templateId)}')">Detail</button></div>`).join("") : `<div class="empty">Tidak ada movement yang cocok filter.</div>`);
}
const renderMovementHistoryDebounced = debounce(()=>{ mhShownCount=MH_PAGE_SIZE; renderMovementHistory(); }, 200);

function selectOptions(id, arr, label){
  const el=$(id); if(!el) return;
  const old=el.value;
  const unique=[...new Set((arr||[]).filter(Boolean).map(String))].sort();
  el.innerHTML = `<option value="">${esc(label)}</option>` + unique.map(v=>`<option value="${escAttr(v)}">${esc(v)}</option>`).join("");
  if(unique.includes(old)) el.value=old;
}
function renderDashboardStorageFilters(){
  selectOptions("dashStorageFilter", db.storages.map(s=>s.code), "Semua Storage");
  selectOptions("dashBuyerFilter", masterBuyers(), "Semua Buyer");
  selectOptions("dashStyleFilter", masterStyles(), "Semua Style / KP");
  selectOptions("dashPartFilter", masterParts(), "Semua Part");
}
function dashboardTemplateMatch(t, storageCode){
  const buyer=$("dashBuyerFilter")?.value || "";
  const style=$("dashStyleFilter")?.value || "";
  const part=$("dashPartFilter")?.value || "";
  if(buyer && t.buyer !== buyer) return false;
  if(style && t.stylekp !== style) return false;
  if(part){
    const ps = storageCode ? distributedPartsInStorage(t.id, storageCode) : partsOf(t.id);
    const list = ps.length ? ps : partsOf(t.id);
    if(!list.some(p=>String(p.part)===part)) return false;
  }
  return true;
}
function renderDashboardStorage(){
  const box=$("dashboardStorageBox"); if(!box) return;
  renderDashboardStorageFilters();
  const storageFilter=$("dashStorageFilter")?.value || "";
  const storages=db.storages.filter(s=>!storageFilter || s.code===storageFilter);
  const groups=[];
  storages.forEach(s=>{
    const rows=templatesInStorage(s.code).filter(t=>dashboardTemplateMatch(t, s.code));
    groups.push({storage:s,rows});
  });
  const total=groups.reduce((a,g)=>a+g.rows.length,0);
  box.innerHTML=`<div class="summary-box"><div class="mini"><b>${storages.length}</b><span>Lokasi tampil</span></div><div class="mini"><b>${total}</b><span>Total template</span></div><div class="mini"><b>${db.templates.filter(isTemplateWaiting).length}</b><span>Menunggu distribusi</span></div></div>`+
  (groups.length?groups.map(g=>{
    const byKey=new Map();
    g.rows.forEach(t=>{const key=`${t.buyer||"(Tanpa buyer)"}|||${t.stylekp||"(Tanpa style/KP)"}`;byKey.set(key,(byKey.get(key)||0)+1);});
    const breakdown=[...byKey.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([key,count])=>{const [buyer,style]=key.split("|||");return `<tr><td>${esc(buyer)}</td><td>${esc(style)}</td><td class="num"><b>${count}</b></td></tr>`;}).join("");
    return `<div class="card storage-dashboard-card"><div class="topline"><div><h3>${esc(g.storage.code)} · ${esc(g.storage.name||"")}</h3><div class="muted">${esc(g.storage.area||"")} · <b>${g.rows.length} template</b></div></div><button class="small" onclick="openStorage('${escAttr(g.storage.code)}')">Buka</button><button class="small good" onclick="goFieldUpdateStorage('${escAttr(g.storage.code)}')">+ Template</button></div>${g.rows.length?`<h4>Ringkasan Buyer / Style-KP per lokasi</h4><div class="table-wrap"><table><thead><tr><th>Buyer</th><th>Style / KP</th><th>Jumlah</th></tr></thead><tbody>${breakdown}</tbody></table></div><details><summary>Daftar template (${g.rows.length})</summary><table><thead><tr><th>Buyer / Style</th><th>Proses</th><th>ID</th><th>Action</th></tr></thead><tbody>${g.rows.map(t=>`<tr><td><b>${esc(t.buyer)}</b><br>${esc(t.stylekp)}</td><td>${esc(partTextInStorage(t.id, g.storage.code))}</td><td><span class="muted">${esc(t.id)}</span></td><td><button class="small" onclick="openTemplateDetail('${escAttr(t.id)}')">Detail</button></td></tr>`).join("")}</tbody></table></details>`:`<div class="empty">Lokasi kosong / tidak cocok filter.</div>`}</div>`;
  }).join(""):`<div class="empty">Tidak ada lokasi/template yang cocok filter.</div>`);
}
function resetDashboardStorageFilter(){
  ["dashStorageFilter","dashBuyerFilter","dashStyleFilter","dashPartFilter"].forEach(id=>{ if($(id)) $(id).value=""; });
  renderDashboardStorage();
}

function masterBuyers(){ const s=new Set([...(db.masters?.buyers||[]), ...db.templates.map(t=>t.buyer).filter(Boolean)]); return [...s].sort(); }
function masterParts(){ const s=new Set([...(db.masters?.parts||[]), ...db.parts.map(p=>p.part).filter(Boolean)]); return [...s].sort(); }
function masterStyles(){ const s=new Set(db.templates.map(t=>t.stylekp).filter(Boolean)); return [...s].sort(); }
function datalist(id, arr){ const el=$(id); if(el) el.innerHTML=arr.map(v=>`<option value="${escAttr(v)}"></option>`).join(""); }
function renderSuggestions(){ datalist("buyerSuggest", masterBuyers()); datalist("styleSuggest", masterStyles()); datalist("partSuggest", masterParts()); datalist("storageSuggest", db.storages.map(s=>s.code).filter(Boolean)); }
function normalizeInputLive(el){ el.value = normalizeText(el.value); }
function addPartRow(value="", size="", qty=1){
  const box=$("partRows"); if(!box) return; const row=document.createElement("div"); row.className="part-row";
  row.innerHTML=`<input class="part-name" list="partSuggest" placeholder="Nama Template / Part" value="${escAttr(value)}" onblur="normalizeInputLive(this)"><input class="part-size" placeholder="Size (S/M/L, cm)" value="${escAttr(size)}" onblur="normalizeInputLive(this)"><input class="part-qty" type="number" inputmode="numeric" pattern="[0-9]*" step="1" min="1" value="${Number(qty||1)}"><button class="bad small" type="button" onclick="this.closest('.part-row').remove();ensureOnePartRow()">✕</button>`;
  box.appendChild(row); renderSuggestions();
}
function ensureOnePartRow(){ if($("partRows") && !$("partRows").children.length) addPartRow(); }
function getPartRows(){
  return [...document.querySelectorAll("#partRows .part-row")].map(r=>({part:normalizeText(r.querySelector(".part-name").value), size:normalizeText(r.querySelector(".part-size")?.value||""), qty:Math.max(1, Number(r.querySelector(".part-qty").value||1))})).filter(p=>p.part);
}

/* ================= SKETCH PREVIEW + CROP ================= */
let sketchDataUrl = "";     // hasil final (sudah crop kalau ada)
let sketchOriginalUrl = ""; // asli untuk re-crop
const cropState={scale:1,minScale:1,x:0,y:0,dragging:false,px:0,py:0,sx:0,sy:0,pointers:new Map(),lastDist:0,startScale:1,natW:0,natH:0};

async function onSketchSelected(input){
  const file=input.files?.[0];
  if(!file){ clearSketch(); return; }
  await loadSketchFromFile(file, "file");
}
/* Loader terpusat: dipakai file input, CTRL+V paste, dan drag&drop */
async function loadSketchFromFile(file, source){
  if(!file) return;
  if(!file.type?.startsWith("image/")) return uiAlert("File harus gambar (JPG/PNG/screenshot).");
  try{
    setBusy(true, source==="paste" ? "Membaca screenshot dari clipboard..." : "Membaca gambar...");
    sketchOriginalUrl = await compressImage(file, 0.95); // kualitas lebih tinggi untuk crop
    sketchDataUrl = sketchOriginalUrl;
    showSketchPreview();
    setBusy(false);
    if(source==="paste"){ flashPasteZone(); toast("Screenshot ditempel dari clipboard 📋"); }
    else if(source==="drop"){ flashPasteZone(); toast("Gambar diterima 📥"); }
    openSketchCrop(); // langsung tawarkan crop sebelum simpan
  }catch(e){
    setBusy(false);
    uiAlert("Gagal baca gambar: "+e.message);
    if(source==="file" && $("sketch")) $("sketch").value="";
  }
}
function flashPasteZone(){
  const z=$("sketchPasteZone"); if(!z) return;
  z.classList.remove("flash"); void z.offsetWidth; z.classList.add("flash");
}
function extractImageFromClipboard(e){
  const items = e.clipboardData?.items || [];
  for(const it of items){
    if(it.kind === "file" && it.type.startsWith("image/")) return it.getAsFile();
  }
  const files = e.clipboardData?.files || [];
  for(const f of files){ if(f.type.startsWith("image/")) return f; }
  return null;
}
/* CTRL+V global: aktif saat halaman Input Template terbuka.
   Screenshot (PrtScn / Snipping Tool / ShareX) langsung masuk preview + crop. */
document.addEventListener("paste", (e)=>{
  if(!currentUser) return;
  if(activePage !== "templateInput") return;
  const tag=(document.activeElement?.tagName||"").toUpperCase();
  const isTyping = (tag==="INPUT" && document.activeElement.type!=="file" && document.activeElement.id!=="sketchPasteZone") || tag==="TEXTAREA";
  const img = extractImageFromClipboard(e);
  if(!img) return;               // paste teks biasa: biarkan normal
  if(isTyping && !e.clipboardData?.files?.length && String(e.clipboardData?.getData("text")||"").trim()) return; // user paste teks ke input
  e.preventDefault();
  loadSketchFromFile(img, "paste");
});
function setupSketchDropZone(){
  const z=$("sketchPasteZone"); if(!z) return;
  ["dragenter","dragover"].forEach(ev=>z.addEventListener(ev,(e)=>{ e.preventDefault(); e.stopPropagation(); z.classList.add("dragover"); }));
  ["dragleave","dragend"].forEach(ev=>z.addEventListener(ev,()=>z.classList.remove("dragover")));
  z.addEventListener("drop",(e)=>{
    e.preventDefault(); e.stopPropagation(); z.classList.remove("dragover");
    const f=[...(e.dataTransfer?.files||[])].find(x=>x.type.startsWith("image/"));
    if(f) loadSketchFromFile(f, "drop");
    else toast("Bukan file gambar");
  });
  // Tekan CTRL+V saat fokus di zone → event paste global di atas yang tangani
  z.addEventListener("keydown",(e)=>{ if(e.key==="Enter" || e.key===" "){ e.preventDefault(); $("sketch")?.click(); } });
}
function showSketchPreview(){
  const box=$("sketchPreviewBox"); if(!box) return;
  if(!sketchDataUrl){ box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  $("sketchPreviewImg").src = sketchDataUrl;
  $("sketchPreviewInfo").textContent = `Ukuran data: ${(sketchDataUrl.length/1024).toFixed(0)} KB · siap disimpan`;
}
function clearSketch(){
  sketchDataUrl=""; sketchOriginalUrl="";
  if($("sketch")) $("sketch").value="";
  if($("sketchPreviewBox")) $("sketchPreviewBox").classList.add("hidden");
}
function openSketchCrop(){
  if(!sketchOriginalUrl) return uiAlert("Pilih gambar sketch dulu.");
  const img=$("cropImage");
  $("cropModal").style.display="flex"; document.body.style.overflow="hidden";
  img.onload=()=>{ initCrop(); };
  if(img.src === sketchOriginalUrl && img.complete){ initCrop(); }
  else { img.src=sketchOriginalUrl; }
  setupCropEvents();
}
function closeCropModal(){ if($("cropModal")) $("cropModal").style.display="none"; if(!anyModalOpen()) document.body.style.overflow=""; cropState.pointers.clear(); }
function initCrop(){
  const vp=$("cropViewport"), img=$("cropImage");
  cropState.natW=img.naturalWidth; cropState.natH=img.naturalHeight;
  const vw=vp.clientWidth, vh=vp.clientHeight;
  cropState.minScale=Math.max(vw/cropState.natW, vh/cropState.natH); // cover
  cropState.scale=cropState.minScale;
  cropState.x=(vw-cropState.natW*cropState.scale)/2;
  cropState.y=(vh-cropState.natH*cropState.scale)/2;
  const zoomEl=$("cropZoom"); zoomEl.value=100;
  applyCropTransform();
}
function resetCrop(){ initCrop(); }
function setCropZoom(v){
  const vp=$("cropViewport");
  const factor=Number(v)/100;
  const newScale=cropState.minScale*factor;
  const cx=vp.clientWidth/2, cy=vp.clientHeight/2;
  // zoom ke tengah viewport
  cropState.x = cx - (cx-cropState.x)*(newScale/cropState.scale);
  cropState.y = cy - (cy-cropState.y)*(newScale/cropState.scale);
  cropState.scale=newScale;
  clampCropPan(); applyCropTransform();
}
function clampCropPan(){
  const vp=$("cropViewport");
  const w=cropState.natW*cropState.scale, h=cropState.natH*cropState.scale;
  cropState.x=Math.min(0, Math.max(vp.clientWidth-w, cropState.x));
  cropState.y=Math.min(0, Math.max(vp.clientHeight-h, cropState.y));
}
function applyCropTransform(){
  const img=$("cropImage");
  img.style.transform=`translate(${cropState.x}px,${cropState.y}px) scale(${cropState.scale})`;
}
function setupCropEvents(){
  const vp=$("cropViewport"), img=$("cropImage");
  vp.onwheel=(e)=>{ e.preventDefault(); const z=$("cropZoom"); z.value=Math.max(100,Math.min(400,Number(z.value)+(e.deltaY<0?18:-18))); setCropZoom(z.value); };
  vp.onpointerdown=(e)=>{ e.preventDefault(); vp.setPointerCapture?.(e.pointerId); cropState.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(cropState.pointers.size===1){ cropState.dragging=true; cropState.px=e.clientX; cropState.py=e.clientY; cropState.sx=cropState.x; cropState.sy=cropState.y; img.style.cursor="grabbing"; }
    if(cropState.pointers.size===2){ const p=[...cropState.pointers.values()]; cropState.lastDist=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y); cropState.startScale=cropState.scale; cropState.dragging=false; } };
  vp.onpointermove=(e)=>{ if(!cropState.pointers.has(e.pointerId)) return; e.preventDefault(); cropState.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(cropState.pointers.size>=2){ const p=[...cropState.pointers.values()]; const dist=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);
      if(cropState.lastDist>0){ let ns=cropState.startScale*(dist/cropState.lastDist); ns=Math.max(cropState.minScale,Math.min(cropState.minScale*4,ns));
        const z=$("cropZoom"); z.value=Math.round(ns/cropState.minScale*100); cropState.scale=ns; clampCropPan(); applyCropTransform(); } return; }
    if(cropState.dragging){ cropState.x=cropState.sx+(e.clientX-cropState.px); cropState.y=cropState.sy+(e.clientY-cropState.py); clampCropPan(); applyCropTransform(); } };
  const end=(e)=>{ cropState.pointers.delete(e.pointerId); img.style.cursor="grab"; if(cropState.pointers.size<2) cropState.lastDist=0; if(!cropState.pointers.size) cropState.dragging=false; };
  vp.onpointerup=end; vp.onpointercancel=end;
}
function applyCrop(){
  const vp=$("cropViewport");
  const vw=vp.clientWidth, vh=vp.clientHeight;
  // Area viewport dalam koordinat gambar asli
  const sx=(-cropState.x)/cropState.scale, sy=(-cropState.y)/cropState.scale;
  const sw=vw/cropState.scale, sh=vh/cropState.scale;
  const canvas=document.createElement("canvas");
  const outW=Math.min(1000, Math.round(sw));
  canvas.width=outW; canvas.height=Math.round(outW*(sh/sw));
  const img=$("cropImage");
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  let q=0.72, out=canvas.toDataURL("image/jpeg",q);
  const maxLen=Math.floor(0.95*1024*1024*1.34);
  while(out.length>maxLen && q>0.3){ q-=0.08; out=canvas.toDataURL("image/jpeg",q); }
  sketchDataUrl=out;
  showSketchPreview();
  closeCropModal();
  toast("Crop diterapkan ✂️");
}
async function compressImage(file, maxMB=0.95){
  if(!file) return "";
  if(!file.type.startsWith("image/")) throw new Error("File sketch harus gambar.");
  const dataUrl = await new Promise((res,rej)=>{const rd=new FileReader(); rd.onload=()=>res(rd.result); rd.onerror=rej; rd.readAsDataURL(file);});
  const maxLen=Math.max(70000, Math.floor(maxMB*1024*1024*1.34));
  if(dataUrl.length <= maxLen) return dataUrl;
  const img = await new Promise((res,rej)=>{const im=new Image(); im.onload=()=>res(im); im.onerror=rej; im.src=dataUrl;});
  const canvas=document.createElement("canvas");
  let w=img.width, h=img.height;
  let maxSide=900;
  let q=.70;
  let out="";
  for(let attempt=0; attempt<8; attempt++){
    let tw=w, th=h;
    if(Math.max(tw,th)>maxSide){ const scale=maxSide/Math.max(tw,th); tw=Math.round(tw*scale); th=Math.round(th*scale); }
    canvas.width=tw; canvas.height=th;
    canvas.getContext("2d").drawImage(img,0,0,tw,th);
    q=.70;
    out=canvas.toDataURL("image/jpeg",q);
    while(out.length>maxLen && q>.32){ q-=.08; out=canvas.toDataURL("image/jpeg",q); }
    if(out.length<=maxLen) return out;
    maxSide=Math.round(maxSide*.78);
  }
  return out;
}
async function saveTemplate(){
  if(!requireLogin("menyimpan template baru")) return;
  const buyer=normalizeText($("buyer").value), stylekp=normalizeText($("stylekp").value), parts=getPartRows();
  if(!buyer || !stylekp || !parts.length){ uiAlert("Buyer, Style/KP, dan minimal 1 Part wajib diisi."); return; }
  const dup=findDuplicateTemplateLocal(buyer, stylekp, parts);
  if(dup){ uiAlert(`Anti duplicate aktif: Template sudah ada.\nBuyer: ${dup.buyer}\nStyle/KP: ${dup.stylekp}\nStatus: ${statusLabel(dup.status)}\nLokasi: ${dup.currentStorage || "Belum distribusi"}`); return; }

  // Validasi bahan baku akrilik
  let acrylicSource = String(tplAcrylicMode || "NONE").toUpperCase();
  let acrylicId = "";
  let acrylicQty = 0;
  let acrylicSourceTemplateId = "";
  let acrylicSpec = "";
  let acrylicNote = "";
  let selectedAcrylic = null;

  if(acrylicSource === "NEW_SHEET"){
    acrylicId = String($("tplAcrylicId")?.value || "").trim();
    acrylicQty = roundQty($("tplAcrylicQty")?.value);
    if(!acrylicId){
      uiAlert("Pilih stok akrilik yang digunakan, atau ubah mode ke 'Sisa Akrilik Template Lain' / 'Tanpa Catat Akrilik'.");
      return;
    }
    selectedAcrylic = db.acrylics.find(a=>String(a.id) === acrylicId);
    if(!selectedAcrylic){
      uiAlert("Stok akrilik terpilih tidak ditemukan.");
      return;
    }
    if(acrylicQty <= 0){
      uiAlert("Qty lembar akrilik yang dipakai harus lebih dari 0.");
      return;
    }
    if(acrylicQty > selectedAcrylic.qtyAvailable + 1e-9){
      uiAlert(`Stok akrilik tidak mencukupi!\nSpec: ${formatAcrylicSpec(selectedAcrylic)}\nTersedia: ${roundQty(selectedAcrylic.qtyAvailable)} lbr\nDiminta: ${acrylicQty} lbr`);
      return;
    }
    acrylicSpec = formatAcrylicSpec(selectedAcrylic);
  }else if(acrylicSource === "LEFTOVER"){
    acrylicSourceTemplateId = String($("tplLeftoverSourceId")?.value || "").trim();
    acrylicNote = String($("tplLeftoverNote")?.value || "").trim();
    if(!acrylicSourceTemplateId && !acrylicNote){
      uiAlert("Pilih Template Asal Sisa Akrilik atau isi Keterangan Sisa Akrilik.");
      return;
    }
    const srcTpl = db.templates.find(t=>String(t.id) === acrylicSourceTemplateId);
    const srcLabel = srcTpl ? `Sisa ${srcTpl.buyer} ${srcTpl.stylekp}${srcTpl.acrylicSpec ? " (" + srcTpl.acrylicSpec + ")" : ""}` : "Sisa Akrilik Template Lain";
    acrylicSpec = acrylicNote ? `${srcLabel} · ${acrylicNote}` : srcLabel;
  }else{
    acrylicSource = "";
  }

  setBusy(true,"Menyimpan template ke database lokal...");
  try{
    const sketch = sketchDataUrl || await compressImage($("sketch").files[0], 0.95);
    const now = nowISO();
    const tid = id("TPL");
    const acrylicLogId = (acrylicSource === "NEW_SHEET" || acrylicSource === "LEFTOVER") ? id("ACRLOG") : "";
    const partRows = parts.map(x=>({
      partId: id("PRT"),
      templateId: tid,
      part: normalizeText(x.part),
      size: normalizeText(x.size || ""),
      qty: Math.max(1, Math.round(Number(x.qty || 1))),
      createdAt: now,
      status: "WAITING_DISTRIBUTION",
      currentStorage: "",
      distributedAt: "",
      updatedAt: now,
      deleted: false
    }));
    const templateObj = {
      id: tid,
      buyer,
      stylekp,
      status: "WAITING_DISTRIBUTION",
      currentStorage: "",
      hasSketch: !!sketch,
      sketchCount: sketch ? 1 : 0,
      createdBy: userName(),
      createdAt: now,
      updatedAt: now,
      distributedAt: "",
      deleted: false,
      acrylicSource,
      acrylicId,
      acrylicQty,
      acrylicSourceTemplateId,
      acrylicSpec
    };

    await CNCDB.putOne("templates", templateObj);
    await CNCDB.putMany("parts", partRows);

    // Update stok akrilik lokal & catat riwayat akrilik
    if(acrylicSource === "NEW_SHEET" && selectedAcrylic){
      const nextUsed = roundQty(Number(selectedAcrylic.qtyUsed || 0) + acrylicQty);
      const nextAvail = roundQty(Math.max(0, Number(selectedAcrylic.qtyIn || 0) - nextUsed));
      await CNCDB.putOne("acrylics", {
        ...selectedAcrylic,
        qtyUsed: nextUsed,
        qtyAvailable: nextAvail,
        updatedAt: now
      });
      await CNCDB.putOne("acrylicLogs", {
        id: acrylicLogId,
        acrylicId: selectedAcrylic.id,
        templateId: tid,
        sourceType: "NEW_SHEET",
        sourceTemplateId: "",
        qty: acrylicQty,
        sizeLabel: acrylicSpec,
        by: userName(),
        note: `Pemakaian template ${buyer} ${stylekp}`,
        at: now
      });
    }else if(acrylicSource === "LEFTOVER"){
      await CNCDB.putOne("acrylicLogs", {
        id: acrylicLogId,
        acrylicId: "",
        templateId: tid,
        sourceType: "LEFTOVER",
        sourceTemplateId: acrylicSourceTemplateId,
        qty: 0,
        sizeLabel: acrylicSpec,
        by: userName(),
        note: acrylicNote || `Memakai sisa akrilik template ${acrylicSourceTemplateId || "lain"}`,
        at: now
      });
    }

    if(sketch){
      await CNCDB.saveSketchLocal(tid, [sketch], { synced: false, updatedAt: now });
    }

    await CNCSync.enqueueAndSync("upsertTemplate", {
      id: tid,
      buyer,
      stylekp,
      status: "WAITING_DISTRIBUTION",
      currentStorage: "",
      parts: partRows,
      createdBy: userName(),
      createdAt: now,
      updatedAt: now,
      acrylicSource,
      acrylicId,
      acrylicQty,
      acrylicSourceTemplateId,
      acrylicSpec,
      acrylicLogId,
      acrylicNote
    });
    if(sketch){
      await CNCSync.enqueueAndSync("uploadSketch", { templateId: tid });
    }

    await reloadLocalState();
    clearTemplateForm();
    const acrMsg = acrylicSource === "NEW_SHEET" ? ` · stok akrilik -${acrylicQty} lbr`
      : acrylicSource === "LEFTOVER" ? " · tercatat dari sisa template lain" : "";
    toast((CNCSync.isOnline() ? "Template tersimpan & masuk sync" : "Template tersimpan offline") + acrMsg);
    showPage("templateList");
  }catch(e){ uiAlert("Gagal simpan: "+e.message); }
  finally{ setBusy(false); }
}
function clearTemplateForm(){
  if(!$("buyer")) return;
  $("buyer").value="";
  $("stylekp").value="";
  $("partRows").innerHTML="";
  addPartRow();
  clearSketch();
  if($("tplAcrylicQty")) $("tplAcrylicQty").value = "1";
  if($("tplLeftoverSearch")) $("tplLeftoverSearch").value = "";
  if($("tplLeftoverNote")) $("tplLeftoverNote").value = "";
  setTemplateAcrylicMode(db.acrylics.some(a=>a.qtyAvailable > 0) ? "NEW_SHEET" : "LEFTOVER");
  renderTemplateAcrylicOptions();
}
/* Lazy loading list template: render bertahap 40 baris + tombol muat lagi */
let tplShownCount = 40;
const TPL_PAGE_SIZE = 40;
function loadMoreTemplates(){ tplShownCount += TPL_PAGE_SIZE; renderTemplates(true); }
function renderTemplates(keepCount){
  const box=$("templateListBox"); if(!box) return;
  if(!dataLoaded){ box.innerHTML='<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'; return; }
  if(!keepCount) tplShownCount = TPL_PAGE_SIZE;
  const q=($("templateSearch")?.value||"").toLowerCase(); const status=$("templateStatusFilter")?.value||"";
  const rows=db.templates.filter(t=>{
    if(q && !templateSearchText(t).includes(q)) return false;
    if(!status) return true;
    if(status==="WAITING_DISTRIBUTION") return isTemplateWaiting(t);
    if(status==="LEFTOVER" || status==="NEW_SHEET") return String(t.acrylicSource||"").toUpperCase()===status;
    return t.status===status;
  });
  const shown = rows.slice(0, tplShownCount);
  box.innerHTML = `<div class="muted">Ditemukan: ${rows.length} template · ditampilkan ${shown.length}</div>` + (shown.length? `<table><thead><tr><th>Template</th><th>Part</th><th>Status &amp; Akrilik</th><th>Lokasi</th><th>Action</th></tr></thead><tbody>${shown.map(t=>{
    const partial=isTemplatePartial(t);
    const locs=templateStorages(t);
    const locLabel=locs.length ? (partial ? `${locs.join(", ")} (+waiting)` : locs.join(", ")) : "Belum distribusi";
    return `<tr><td><b>${esc(t.buyer)}</b><br>${esc(t.stylekp)}<br><span class="muted">${esc(t.id)} · ${dateTimeText(t.createdAt)}</span></td><td>${esc(partText(t.id))}</td><td>${statusBadge(t.status)}${partial?` <span class="badge partial">Split Parsial</span>`:""}${acrylicBadgeHtml(t)?`<br>${acrylicBadgeHtml(t)}`:""}</td><td>${esc(locLabel)}</td><td><button class="small" onclick="openTemplateDetail('${escAttr(t.id)}')">Detail</button>${t.hasSketch?` <button class="small" onclick="viewSketch('${escAttr(t.id)}')">Sketch</button>`:""}</td></tr>`;
  }).join("")}</tbody></table>` : `<div class="empty">Belum ada data.</div>`) + (rows.length > tplShownCount ? `<button class="load-more-btn" onclick="loadMoreTemplates()">⬇ Muat ${Math.min(TPL_PAGE_SIZE, rows.length-tplShownCount)} template lagi (${rows.length-tplShownCount} tersisa)</button>` : "");
}
const renderTemplatesDebounced = debounce(renderTemplates, 160);
function openTemplateDetail(tid){
  if(!requireLogin("melihat detail template")) return;
  const t=db.templates.find(x=>x.id===tid); if(!t) return;
  const mov=db.movements.filter(m=>m.templateId===tid).sort(movementSortNewest).slice(0,5);
  const ps=partsOf(t.id);
  const partial=isTemplatePartial(t);
  const locs=templateStorages(t);
  const partTable=ps.length ? `<table><thead><tr><th>Part</th><th>Size</th><th>Qty</th><th>Status</th><th>Storage</th></tr></thead><tbody>${ps.map(p=>`<tr><td><b>${esc(p.part)}</b></td><td>${esc(p.size||"-")}</td><td>${Number(p.qty||1)}</td><td>${statusBadge(p.status||"WAITING_DISTRIBUTION")}</td><td>${esc(p.currentStorage||"-")}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">Belum ada rincian part.</p>`;
  const srcTpl = t.acrylicSourceTemplateId ? db.templates.find(x=>x.id===t.acrylicSourceTemplateId) : null;
  const acrInfo = t.acrylicSource === "NEW_SHEET"
    ? `<div class="dist-alert info" style="margin:8px 0">🧱 <b>Bahan Akrilik Baru:</b> ${esc(t.acrylicSpec || "-")} · Dipakai <b>${roundQty(t.acrylicQty || 0)} lembar</b> (stok dikurangi otomatis)</div>`
    : t.acrylicSource === "LEFTOVER"
    ? `<div class="dist-alert good" style="margin:8px 0">♻️ <b>Bahan Sisa Akrilik Template Lain:</b> ${srcTpl ? `${esc(srcTpl.buyer)} · ${esc(srcTpl.stylekp)} (${esc(srcTpl.id)})` : esc(t.acrylicSourceTemplateId || "-")} ${t.acrylicSpec ? `· ${esc(t.acrylicSpec)}` : ""} (tidak mengurangi stok baru)</div>`
    : "";
  $("modalTitle").textContent="Detail Template";
  $("modalContent").innerHTML=`<div class="card"><h3>${esc(t.buyer)} · ${esc(t.stylekp)}</h3><p>${statusBadge(t.status)}${partial?` <span class="badge partial">Split Parsial</span>`:""} <span class="badge">${esc(locs.length?locs.join(", "):"Belum distribusi")}</span></p>${acrInfo}<p><b>Rincian Part:</b></p>${partTable}<p class="muted">Dibuat oleh: ${esc(t.createdBy)} · ${dateTimeText(t.createdAt)}</p><div class="actions">${t.hasSketch?`<button onclick="viewSketch('${escAttr(t.id)}')">Lihat Sketch</button>`:""}${isTemplateWaiting(t)?`<button class="good" onclick="closeModal();goDistributeTemplate('${escAttr(t.id)}')">📦 Distribusikan</button>`:""}${isAdmin()?`<button class="bad" onclick="softDeleteTemplate('${escAttr(t.id)}')">🗑️ Hapus Template</button>`:""}</div></div><h3>History</h3>${mov.length?mov.map(m=>`<div class="line-item"><b>${esc(m.type)}</b><span>${esc(m.from||"-")} → ${esc(m.to||"-")} · ${esc(m.by||"")} · ${dateTimeText(m.at)}<br>${esc(m.note||"")}</span></div>`).join(""):`<div class="muted">Belum ada movement.</div>`}`;
  openModal();
}
async function softDeleteTemplate(tid){
  if(!requireLogin("menghapus template")) return;
  if(!isAdmin()) return uiAlert("Hapus template khusus admin dan super_admin.");
  const t=db.templates.find(x=>String(x.id)===String(tid));
  if(!t) return;
  if(!(await uiConfirm(`Hapus template ${t.buyer} · ${t.stylekp} (${t.id})?\nAkan ditandai soft-delete dan disinkronkan ke perangkat lain.`, "Hapus Template", { okText: "Ya, Hapus", danger: true }))) return;
  const now=nowISO();
  const updatedTpl={...t, deleted:true, updatedAt:now};
  const updatedParts=partsOf(t.id).map(p=>({...p, deleted:true, updatedAt:now}));
  await CNCDB.putOne("templates", updatedTpl);
  if(updatedParts.length) await CNCDB.putMany("parts", updatedParts);
  await CNCSync.enqueueAndSync("softDeleteTemplate", { id: t.id, updatedAt: now });
  closeModal();
  await reloadLocalState();
  toast("Template dihapus (soft delete) & masuk antrean sync");
}
const zoomState={scale:1,x:0,y:0,startX:0,startY:0,pointerX:0,pointerY:0,dragging:false,startScale:1,lastDist:0,pointers:new Map()};
async function viewSketch(tid){
  if(!requireLogin("melihat sketch template")) return;
  const t=db.templates.find(x=>x.id===tid);
  if(!t) return;
  try{
    setBusy(true,"Membuka sketch (cache lokal / Drive)...");
    const list = await CNCSync.fetchSketch(tid);
    const img = list && list[0] ? list[0] : "";
    if(!img) return uiAlert("Sketch belum ada untuk template ini.");
    openImageViewer(img, `Sketch Template · ${t.buyer} ${t.stylekp}`);
  }catch(e){ uiAlert("Gagal buka sketch: "+e.message); }
  finally{ setBusy(false); }
}
function openImageViewer(src,title="Preview Gambar"){
  $("modal").classList.add("image-mode");
  $("modalTitle").textContent=title;
  $("modalContent").innerHTML=`<div class="image-zoom-toolbar"><button class="small" onclick="zoomImage(-0.25)">−</button><button class="small" onclick="resetImageZoom()">Reset</button><button class="small" onclick="zoomImage(0.25)">+</button><span id="zoomText" class="zoom-percent">100%</span><button class="small" onclick="fitImageZoom()">Fit</button></div><div id="imageZoomWrap" class="image-zoom-wrap"><img id="zoomImage" class="photo-view" src="${escAttr(src)}" alt="Preview sketch" onload="fitImageZoom()"></div><div class="zoom-hint">HP: cubit/pinch untuk zoom, geser gambar saat zoom. PC: scroll mouse untuk zoom, drag untuk geser, double click untuk zoom cepat.</div>`;
  openModal(); setupImageZoomEvents();
}
function clampZoom(v){return Math.max(1,Math.min(6,v));}
function applyImageZoom(){ const img=$("zoomImage"), txt=$("zoomText"); if(!img) return; zoomState.scale=clampZoom(zoomState.scale); if(zoomState.scale<=1){ zoomState.x=0; zoomState.y=0; } img.style.transform=`translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`; if(txt) txt.textContent=Math.round(zoomState.scale*100)+"%"; }
function zoomImage(delta){ zoomState.scale=clampZoom(zoomState.scale+delta); applyImageZoom(); }
function resetImageZoom(){ zoomState.scale=1; zoomState.x=0; zoomState.y=0; applyImageZoom(); }
function fitImageZoom(){ resetImageZoom(); }
function pointDistance(a,b){ return Math.hypot(a.x-b.x,a.y-b.y); }
function setupImageZoomEvents(){
  const wrap=$("imageZoomWrap"), img=$("zoomImage"); if(!wrap||!img) return;
  zoomState.pointers.clear();
  wrap.onwheel=(e)=>{ e.preventDefault(); zoomImage(e.deltaY<0?0.18:-0.18); };
  wrap.ondblclick=(e)=>{ e.preventDefault(); if(zoomState.scale>1) resetImageZoom(); else { zoomState.scale=2.4; applyImageZoom(); } };
  wrap.onpointerdown=(e)=>{ e.preventDefault(); wrap.setPointerCapture?.(e.pointerId); zoomState.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}); if(zoomState.pointers.size===1){ zoomState.dragging=true; zoomState.pointerX=e.clientX; zoomState.pointerY=e.clientY; zoomState.startX=zoomState.x; zoomState.startY=zoomState.y; img.classList.add("dragging"); } if(zoomState.pointers.size===2){ const p=[...zoomState.pointers.values()]; zoomState.lastDist=pointDistance(p[0],p[1]); zoomState.startScale=zoomState.scale; zoomState.dragging=false; } };
  wrap.onpointermove=(e)=>{ if(!zoomState.pointers.has(e.pointerId)) return; e.preventDefault(); zoomState.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}); if(zoomState.pointers.size>=2){ const p=[...zoomState.pointers.values()]; const dist=pointDistance(p[0],p[1]); if(zoomState.lastDist>0){ zoomState.scale=clampZoom(zoomState.startScale*(dist/zoomState.lastDist)); applyImageZoom(); } return; } if(zoomState.dragging && zoomState.scale>1){ zoomState.x=zoomState.startX+(e.clientX-zoomState.pointerX); zoomState.y=zoomState.startY+(e.clientY-zoomState.pointerY); applyImageZoom(); } };
  function endPointer(e){ zoomState.pointers.delete(e.pointerId); img.classList.remove("dragging"); if(zoomState.pointers.size===1){ const p=[...zoomState.pointers.values()][0]; zoomState.dragging=true; zoomState.pointerX=p.x; zoomState.pointerY=p.y; zoomState.startX=zoomState.x; zoomState.startY=zoomState.y; } else { zoomState.dragging=false; zoomState.lastDist=0; } }
  wrap.onpointerup=endPointer; wrap.onpointercancel=endPointer; wrap.onpointerleave=(e)=>{ if(e.pointerType==="mouse") endPointer(e); };
}
function openModal(){ if($("modal")) $("modal").style.display="flex"; document.body.style.overflow="hidden"; }
function closeModal(){ if($("modal")){ $("modal").style.display="none"; $("modal").classList.remove("image-mode"); } if(!anyModalOpen()) document.body.style.overflow=""; zoomState.pointers?.clear?.(); }

function encKey(v){ return encodeURIComponent(String(v??"")).replace(/'/g,"%27"); }
function decKey(v){ try{ return decodeURIComponent(String(v??"")); }catch(e){ return String(v??""); } }
function distPartKey(p){ return String(p?.partId||"").trim() || `${normalizeText(p?.part)}||${normalizeText(p?.size||"")}`; }

function ensureDistPartSelection(tid){
  const idStr=String(tid);
  const wParts=waitingPartsOf(idStr);
  let partMap=distSelections.get(idStr);
  if(!partMap){
    partMap=new Map();
    distSelections.set(idStr, partMap);
  }
  const validKeys=new Set();
  wParts.forEach(p=>{
    const key=distPartKey(p);
    const maxQty=Math.max(1, Math.round(Number(p.qty||1)));
    validKeys.add(key);
    const prev=partMap.get(key);
    if(!prev){
      partMap.set(key, {checked:true, qty:maxQty});
    }else{
      prev.qty=Math.max(1, Math.min(maxQty, Math.round(Number(prev.qty||maxQty))));
    }
  });
  [...partMap.keys()].forEach(k=>{ if(!validKeys.has(k)) partMap.delete(k); });
  return partMap;
}
function goDistributeTemplate(tid){
  const t=db.templates.find(x=>String(x.id)===String(tid));
  if(!t || !isTemplateWaiting(t)) return toast("Template sudah tidak berstatus waiting.");
  distSelections.clear();
  ensureDistPartSelection(t.id);
  selectedTemplateId=String(t.id);
  showPage("distribution");
}
function getFilteredWaitingTemplates(){
  const allWaiting=db.templates.filter(isTemplateWaiting);
  const buyer=$("distBuyerFilter")?.value || "";
  const style=$("distStyleFilter")?.value || "";
  const q=($("distSearch")?.value || "").trim().toLowerCase();
  return allWaiting.filter(t=>{
    if(buyer && t.buyer !== buyer) return false;
    if(style && t.stylekp !== style) return false;
    if(q){
      const hay=[t.id, t.buyer, t.stylekp, formatPartList(waitingPartsOf(t.id)), templateStorages(t).join(" ")].join(" ").toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
}
function onDistBuyerFilterChange(){
  const buyer=$("distBuyerFilter")?.value || "";
  const styleEl=$("distStyleFilter");
  if(styleEl && buyer){
    const validStyles=new Set(db.templates.filter(t=>isTemplateWaiting(t) && t.buyer===buyer).map(t=>t.stylekp).filter(Boolean));
    if(styleEl.value && !validStyles.has(styleEl.value)) styleEl.value="";
  }
  renderDistribution();
}
function resetDistributionFilter(){
  ["distBuyerFilter","distStyleFilter","distSearch"].forEach(k=>{ if($(k)) $(k).value=""; });
  renderDistribution();
}
function renderDistribution(){
  if(!$("distTemplateList")) return;
  const allWaiting=db.templates.filter(isTemplateWaiting);
  const waitingIds=new Set(allWaiting.map(t=>String(t.id)));
  [...distSelections.keys()].forEach(tid=>{ if(!waitingIds.has(tid)) distSelections.delete(tid); });
  if(selectedTemplateId && !waitingIds.has(String(selectedTemplateId))) selectedTemplateId="";

  $("distCount").textContent = allWaiting.length;
  selectOptions("distBuyerFilter", allWaiting.map(t=>t.buyer), "Semua Buyer");
  const activeBuyer=$("distBuyerFilter")?.value || "";
  selectOptions("distStyleFilter", allWaiting.filter(t=>!activeBuyer || t.buyer===activeBuyer).map(t=>t.stylekp), "Semua Style / KP");

  const stEl=$("distStorage");
  if(stEl){
    const prevStorage=stEl.value;
    const validStorages=db.storages.filter(s=>normalizeText(s.code)!=="WORKSHOP");
    stEl.innerHTML = validStorages.length
      ? validStorages.map(s=>`<option value="${escAttr(s.code)}">${esc(s.code)} · ${esc(s.name)}</option>`).join("")
      : `<option value="">Belum ada master storage</option>`;
    if(prevStorage && validStorages.some(s=>s.code===prevStorage)) stEl.value=prevStorage;
  }

  const filtered=getFilteredWaitingTemplates();
  const listBox=$("distTemplateList");
  if(!filtered.length){
    listBox.innerHTML = allWaiting.length
      ? `<div class="empty">Tidak ada template waiting yang cocok dengan filter Buyer / Style / pencarian.</div>`
      : `<div class="empty">Tidak ada template menunggu distribusi.</div>`;
  }else{
    const groups=new Map();
    filtered.forEach(t=>{
      const gKey=`${t.buyer||"(Tanpa Buyer)"}|||${t.stylekp||"(Tanpa Style/KP)"}`;
      if(!groups.has(gKey)) groups.set(gKey, []);
      groups.get(gKey).push(t);
    });
    const sortedKeys=[...groups.keys()].sort((a,b)=>a.localeCompare(b));
    listBox.innerHTML = sortedKeys.map(gKey=>{
      const [buyer, style]=gKey.split("|||");
      const rows=groups.get(gKey);
      return `<div class="dist-group-title">${esc(buyer)} · ${esc(style)} (${rows.length})</div>` + rows.map(t=>{
        const tid=String(t.id);
        const isSel=distSelections.has(tid);
        const wParts=waitingPartsOf(tid);
        const dParts=distributedPartsOf(tid);
        const partial=wParts.length>0 && dParts.length>0;
        const wQty=wParts.reduce((a,p)=>a+Math.max(1,Number(p.qty||1)),0);
        const distInfo=dParts.length
          ? `<small style="color:#7dd3fc">Sudah terdistribusi: ${esc(dParts.map(p=>`${p.part}${p.size?` [${p.size}]`:""} x${Number(p.qty||1)} @${p.currentStorage}`).join(", "))}</small>`
          : "";
        return `<div class="template-pick-card ${isSel?'selected':''}" onclick="toggleDistributionTemplate('${encKey(tid)}')"><div class="dist-pick-row"><input type="checkbox" ${isSel?"checked":""} onclick="event.stopPropagation();toggleDistributionTemplate('${encKey(tid)}')" aria-label="Pilih template ${escAttr(tid)}"/><div class="dist-pick-body"><b>${esc(t.buyer)} · ${esc(t.stylekp)} ${partial?`<span class="badge partial">Split Parsial</span>`:`<span class="badge warn">Waiting</span>`}</b><span>Waiting (${wParts.length} part · ${wQty} pcs): ${esc(formatPartList(wParts)||partText(tid)||"—")}</span>${distInfo}<small>${esc(tid)} · ${dateTimeText(t.createdAt)}</small></div></div></div>`;
      }).join("");
    }).join("");
  }
  renderDistributionSplitPanel();
}
const renderDistributionDebounced = debounce(renderDistribution, 160);

function selectDistributionTemplate(tid){ toggleDistributionTemplate(encKey(tid)); }
function toggleDistributionTemplate(encTid){
  const tid=decKey(encTid);
  if(distSelections.has(tid)){
    distSelections.delete(tid);
    if(selectedTemplateId===tid) selectedTemplateId=[...distSelections.keys()][0]||"";
  }else{
    ensureDistPartSelection(tid);
    selectedTemplateId=tid;
  }
  renderDistribution();
}
function selectAllFilteredDistribution(on){
  if(!on){
    distSelections.clear();
    selectedTemplateId="";
  }else{
    const filtered=getFilteredWaitingTemplates();
    filtered.forEach(t=>ensureDistPartSelection(t.id));
    selectedTemplateId=filtered[0] ? String(filtered[0].id) : "";
  }
  renderDistribution();
}
function toggleDistPart(encTid, encPKey, checked){
  const tid=decKey(encTid), pKey=decKey(encPKey);
  const partMap=ensureDistPartSelection(tid);
  const entry=partMap.get(pKey);
  if(entry) entry.checked=!!checked;
  renderDistributionSplitPanel();
}
function setDistPartQty(encTid, encPKey, rawVal){
  const tid=decKey(encTid), pKey=decKey(encPKey);
  const partMap=ensureDistPartSelection(tid);
  const wPart=waitingPartsOf(tid).find(p=>distPartKey(p)===pKey);
  if(!wPart) return;
  const maxQty=Math.max(1, Math.round(Number(wPart.qty||1)));
  let v=Math.round(Number(rawVal));
  if(!Number.isFinite(v) || v<1) v=1;
  if(v>maxQty) v=maxQty;
  const entry=partMap.get(pKey) || {checked:true, qty:maxQty};
  entry.qty=v;
  entry.checked=true;
  partMap.set(pKey, entry);
  renderDistributionSplitPanel();
}
function stepDistPartQty(encTid, encPKey, delta){
  const tid=decKey(encTid), pKey=decKey(encPKey);
  const partMap=ensureDistPartSelection(tid);
  const wPart=waitingPartsOf(tid).find(p=>distPartKey(p)===pKey);
  if(!wPart) return;
  const maxQty=Math.max(1, Math.round(Number(wPart.qty||1)));
  const entry=partMap.get(pKey) || {checked:true, qty:maxQty};
  const next=Math.max(1, Math.min(maxQty, Number(entry.qty||1) + Number(delta||0)));
  entry.qty=next;
  entry.checked=true;
  partMap.set(pKey, entry);
  renderDistributionSplitPanel();
}
function setAllDistParts(encTid, on){
  const tid=decKey(encTid);
  const partMap=ensureDistPartSelection(tid);
  const wParts=waitingPartsOf(tid);
  wParts.forEach(p=>{
    const k=distPartKey(p);
    const maxQty=Math.max(1, Math.round(Number(p.qty||1)));
    const entry=partMap.get(k) || {checked:on, qty:maxQty};
    entry.checked=!!on;
    if(on && (!entry.qty || entry.qty<1)) entry.qty=maxQty;
    partMap.set(k, entry);
  });
  renderDistributionSplitPanel();
}
function collectDistributionPlan(){
  const items=[];
  const errors=[];
  let totalParts=0, totalQty=0, remainingQty=0, hasSplit=false;

  [...distSelections.keys()].forEach(tid=>{
    const t=db.templates.find(x=>String(x.id)===tid);
    if(!t || !isTemplateWaiting(t)) return;
    const wParts=waitingPartsOf(tid);
    if(!wParts.length){
      items.push({template:t, templateId:tid, splitParts:[]});
      return;
    }
    const partMap=ensureDistPartSelection(tid);
    const splitParts=[];
    let tTotalWaitQty=0;
    let tPickedQty=0;
    wParts.forEach(p=>{
      const maxQty=Math.max(1, Math.round(Number(p.qty||1)));
      tTotalWaitQty += maxQty;
      const k=distPartKey(p);
      const sel=partMap.get(k);
      if(sel && sel.checked){
        const qty=Math.round(Number(sel.qty||0));
        if(!Number.isFinite(qty) || qty<1 || qty>maxQty){
          errors.push(`Qty part ${p.part}${p.size?` [${p.size}]`:""} pada ${t.buyer} · ${t.stylekp} tidak valid (1-${maxQty}).`);
          return;
        }
        splitParts.push({partId:p.partId||"", part:normalizeText(p.part), size:normalizeText(p.size||""), qty});
        tPickedQty += qty;
        totalParts++;
        totalQty += qty;
        if(qty < maxQty) hasSplit=true;
      }else{
        hasSplit=true;
      }
    });
    remainingQty += Math.max(0, tTotalWaitQty - tPickedQty);
    if(splitParts.length){
      items.push({template:t, templateId:tid, splitParts});
    }
  });

  return {items, totalTemplates:items.length, totalParts, totalQty, remainingQty, hasSplit, errors};
}
function findLocalDistributionConflict(plan, storage){
  const st=normalizeText(storage);
  const duplicates=[];
  const autoMerges=[];
  if(!st || !plan?.items?.length) return {duplicates, autoMerges};

  const batchKeys=new Map();
  plan.items.forEach(item=>{
    const t=item.template;
    const buyerNorm=normalizeText(t.buyer);
    const styleNorm=normalizeText(t.stylekp);
    const plannedKey=partsKeyLocal(item.splitParts);
    if(!plannedKey) return;

    // 1. Cek duplikat terhadap template lain di storage tujuan
    const otherDup=db.templates.find(other=>{
      if(String(other.id)===String(t.id)) return false;
      if(normalizeText(other.buyer)!==buyerNorm || normalizeText(other.stylekp)!==styleNorm) return false;
      const otherInSt=distributedPartsInStorage(other.id, st);
      if(!otherInSt.length) return false;
      return partsKeyLocal(otherInSt)===plannedKey;
    });
    if(otherDup){
      duplicates.push(`Duplikat di ${st}: ${buyerNorm} · ${styleNorm} dengan part/size/qty identik sudah ada (ID: ${otherDup.id}).`);
    }

    // 2. Cek duplikat antar item di batch yang sama
    const batchSig=`${buyerNorm}||${styleNorm}||${plannedKey}`;
    if(batchKeys.has(batchSig)){
      duplicates.push(`Duplikat dalam pilihan: ${buyerNorm} · ${styleNorm} (${t.id} & ${batchKeys.get(batchSig)}) memiliki part/size/qty identik ke ${st}.`);
    }else{
      batchKeys.set(batchSig, t.id);
    }

    // 3. Cek auto-merge part yang sama dari template yang sama di storage tujuan
    const sameInSt=distributedPartsInStorage(t.id, st);
    if(sameInSt.length){
      const mergedNames=[];
      item.splitParts.forEach(sp=>{
        const hit=sameInSt.find(p=>normalizeText(p.part)===normalizeText(sp.part) && normalizeText(p.size||"")===normalizeText(sp.size||""));
        if(hit) mergedNames.push(`${sp.part}${sp.size?` [${sp.size}]`:""} (+${sp.qty} → ${Number(hit.qty||0)+sp.qty})`);
      });
      if(mergedNames.length){
        autoMerges.push(`${buyerNorm} · ${styleNorm}: ${mergedNames.join(", ")} sudah ada di ${st} dan akan digabung qty-nya otomatis (anti-duplikat).`);
      }
    }
  });
  return {duplicates, autoMerges};
}
function renderDistributionSplitPanel(){
  const panel=$("distSplitPanel");
  const body=$("distSplitBody");
  if(!panel || !body) return;
  const selIds=[...distSelections.keys()].filter(tid=>{
    const t=db.templates.find(x=>String(x.id)===tid);
    return t && isTemplateWaiting(t);
  });
  if($("distSelectedCount")) $("distSelectedCount").textContent = selIds.length;
  panel.classList.toggle("hidden", !selIds.length);
  if(!selIds.length){ body.innerHTML=""; renderDistributionSummary(); return; }

  body.innerHTML = selIds.map(tid=>{
    const t=db.templates.find(x=>String(x.id)===tid);
    const wParts=waitingPartsOf(tid);
    const partMap=ensureDistPartSelection(tid);
    const partRowsHtml = wParts.length ? wParts.map(p=>{
      const pKey=distPartKey(p);
      const maxQty=Math.max(1, Math.round(Number(p.qty||1)));
      const sel=partMap.get(pKey) || {checked:true, qty:maxQty};
      const isSplitQty=sel.checked && sel.qty < maxQty;
      return `<div class="dist-part-row ${sel.checked?"":"unchecked"}"><input type="checkbox" ${sel.checked?"checked":""} onchange="toggleDistPart('${encKey(tid)}','${encKey(pKey)}',this.checked)" aria-label="Pilih part ${escAttr(p.part)}"/><div class="dist-part-info"><b>${esc(p.part)}${p.size?` <span class="badge">${esc(p.size)}</span>`:""}</b><small>Tersedia waiting: <b>${maxQty}</b>${isSplitQty?` · <span style="color:#fde68a">Split: kirim ${sel.qty}, sisa ${maxQty-sel.qty} tetap waiting</span>`:(sel.checked?` · kirim penuh (${sel.qty})`:` · tidak dikirim (tetap waiting)`)}</small></div><div class="dist-qty-ctrl"><button class="small" type="button" ${!sel.checked||sel.qty<=1?"disabled":""} onclick="stepDistPartQty('${encKey(tid)}','${encKey(pKey)}',-1)">−</button><input type="number" inputmode="numeric" min="1" max="${maxQty}" value="${sel.qty}" ${!sel.checked?"disabled":""} onchange="setDistPartQty('${encKey(tid)}','${encKey(pKey)}',this.value)"/><button class="small" type="button" ${!sel.checked||sel.qty>=maxQty?"disabled":""} onclick="stepDistPartQty('${encKey(tid)}','${encKey(pKey)}',1)">+</button></div></div>`;
    }).join("") : `<div class="muted">Template ini tidak memiliki daftar part terpisah; akan didistribusikan utuh.</div>`;
    return `<div class="dist-split-card"><div class="dist-split-head"><div><b>${esc(t.buyer)} · ${esc(t.stylekp)}</b><div class="muted">${esc(tid)}</div></div><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="small" type="button" onclick="setAllDistParts('${encKey(tid)}',true)">Semua Part</button><button class="small" type="button" onclick="setAllDistParts('${encKey(tid)}',false)">Kosongkan</button><button class="small bad" type="button" onclick="toggleDistributionTemplate('${encKey(tid)}')">✕</button></div></div>${partRowsHtml}</div>`;
  }).join("");
  renderDistributionSummary();
}
function renderDistributionSummary(){
  const box=$("distSummary");
  if(!box) return;
  const st=$("distStorage")?.value || "";
  const plan=collectDistributionPlan();
  const conflict=findLocalDistributionConflict(plan, st);
  const btn=$("btnDistributeSubmit");
  if(btn) btn.disabled = distSubmitting || !plan.totalTemplates || !!plan.errors.length || !!conflict.duplicates.length || !st;

  const blocks=[];
  if(plan.totalTemplates){
    blocks.push(`<div class="dist-alert good"><b>Ringkasan Distribusi → ${esc(st||"(pilih storage)")}:</b> ${plan.totalTemplates} template · ${plan.totalParts} baris part · total <b>${plan.totalQty} pcs</b>${plan.remainingQty?` · sisa <b>${plan.remainingQty} pcs</b> tetap WAITING_DISTRIBUTION`:` · distribusi penuh`}</div>`);
  }else if(distSelections.size){
    blocks.push(`<div class="dist-alert warn">Centang minimal 1 part untuk didistribusikan.</div>`);
  }
  if(plan.errors.length){
    blocks.push(`<div class="dist-alert bad">${plan.errors.map(esc).join("<br>")}</div>`);
  }
  if(conflict.duplicates.length){
    blocks.push(`<div class="dist-alert bad"><b>Anti-Duplikat Aktif:</b><br>${conflict.duplicates.map(esc).join("<br>")}</div>`);
  }
  if(conflict.autoMerges.length){
    blocks.push(`<div class="dist-alert info"><b>Auto-Merge Anti-Duplikat:</b><br>${conflict.autoMerges.map(esc).join("<br>")}</div>`);
  }
  box.innerHTML=blocks.join("");
}
function setDistStorageScanned(){
  const code=normalizeText($("distScanCode")?.value || "");
  if(!code) return;
  const sel=$("distStorage");
  if(sel && [...sel.options].some(o=>normalizeText(o.value)===code)){
    sel.value=[...sel.options].find(o=>normalizeText(o.value)===code).value;
    renderDistributionSummary();
    toast("Storage tujuan dipilih: " + sel.value);
  }else{
    uiAlert("Kode storage \"" + code + "\" tidak ada di master atau tidak valid untuk distribusi.");
  }
}
async function distributeTemplate(){
  if(!requireLogin("mendistribusikan template")) return;
  if(distSubmitting) return;
  const st=normalizeText($("distStorage")?.value || "");
  if(!st || st==="WORKSHOP") return uiAlert("Pilih storage tujuan yang valid.");
  const plan=collectDistributionPlan();
  if(!plan.totalTemplates) return uiAlert("Pilih minimal satu template dan satu part waiting untuk didistribusikan.");
  if(plan.errors.length) return uiAlert(plan.errors.join("\n"));
  const conflict=findLocalDistributionConflict(plan, st);
  if(conflict.duplicates.length) return uiAlert("Anti-duplikat aktif:\n" + conflict.duplicates.join("\n"));

  distSubmitting=true;
  renderDistributionSummary();
  setBusy(true, plan.totalTemplates>1 ? `Simpan distribusi ${plan.totalTemplates} template...` : "Simpan distribusi...");
  try{
    const now=nowISO();
    const baseNote=normalizeText($("distNote")?.value || "") || "Distribusi template jadi";
    const requestId=id("REQ");
    const updatedTemplates=[];
    const updatedParts=[];
    const createdMovements=[];
    const payloadItems=[];
    let anyPartial=false;

    plan.items.forEach(item=>{
      const t=item.template;
      const tid=String(t.id);
      const movId=id("MOV");
      const currentParts=partsOf(tid).map(p=>({...p}));
      const splitPayload=[];
      const splitSummary=[];

      const existingDistByKey=new Map();
      currentParts.forEach(pp=>{
        if(isPartDistributed(pp) && normalizeText(pp.currentStorage)===st){
          const k=`${normalizeText(pp.part)}||${normalizeText(pp.size||"")}`;
          if(!existingDistByKey.has(k)) existingDistByKey.set(k, pp);
        }
      });

      item.splitParts.forEach(sp=>{
        const partRow=currentParts.find(pp=>isPartWaiting(pp) && ((sp.partId && String(pp.partId)===String(sp.partId)) || (normalizeText(pp.part)===normalizeText(sp.part) && normalizeText(pp.size||"")===normalizeText(sp.size||""))));
        if(!partRow) return;
        const maxQty=Math.max(1, Math.round(Number(partRow.qty||1)));
        const qty=Math.max(1, Math.min(maxQty, Math.round(Number(sp.qty||maxQty))));
        const k=`${normalizeText(partRow.part)}||${normalizeText(partRow.size||"")}`;
        const existingDist=existingDistByKey.get(k);
        let newPartId="";

        if(existingDist){
          existingDist.qty = Math.max(1, Number(existingDist.qty||0)) + qty;
          existingDist.distributedAt = now;
          existingDist.updatedAt = now;
          updatedParts.push(existingDist);
          if(qty >= maxQty){
            partRow.deleted = true;
            partRow.updatedAt = now;
            updatedParts.push(partRow);
          }else{
            partRow.qty = maxQty - qty;
            partRow.updatedAt = now;
            updatedParts.push(partRow);
          }
        }else if(qty >= maxQty){
          partRow.qty = qty;
          partRow.status = "DISTRIBUTED";
          partRow.currentStorage = st;
          partRow.distributedAt = now;
          partRow.updatedAt = now;
          updatedParts.push(partRow);
          existingDistByKey.set(k, partRow);
        }else{
          partRow.qty = maxQty - qty;
          partRow.updatedAt = now;
          updatedParts.push(partRow);
          newPartId = id("PRT");
          const distRow = {
            partId: newPartId,
            templateId: tid,
            part: normalizeText(partRow.part),
            size: normalizeText(partRow.size||""),
            qty,
            createdAt: partRow.createdAt || now,
            status: "DISTRIBUTED",
            currentStorage: st,
            distributedAt: now,
            updatedAt: now,
            deleted: false
          };
          currentParts.push(distRow);
          updatedParts.push(distRow);
          existingDistByKey.set(k, distRow);
        }

        splitPayload.push({ partId: sp.partId || partRow.partId, part: normalizeText(partRow.part), size: normalizeText(partRow.size||""), qty, newPartId });
        splitSummary.push(`${normalizeText(partRow.part)}${partRow.size?` [${normalizeText(partRow.size)}]`:""} x${qty}`);
      });

      const activeParts=currentParts.filter(pp=>!pp.deleted);
      const remainingWaiting=activeParts.some(isPartWaiting);
      const distStorages=[...new Set(activeParts.filter(isPartDistributed).map(pp=>normalizeText(pp.currentStorage)).filter(Boolean))].sort();
      if(remainingWaiting) anyPartial=true;

      const newStatus = activeParts.length ? (remainingWaiting ? "WAITING_DISTRIBUTION" : (distStorages.length ? "DISTRIBUTED" : "OUT")) : "DISTRIBUTED";
      const newStorage = activeParts.length ? distStorages.join(", ") : st;
      updatedTemplates.push({ ...t, status: newStatus, currentStorage: newStorage, distributedAt: t.distributedAt || now, updatedAt: now });

      const movNote = splitSummary.length ? `${baseNote} | Split Part/Size/Qty: ${splitSummary.join(", ")}` : baseNote;
      createdMovements.push({ id: movId, templateId: tid, type: "DISTRIBUTE", from: "WORKSHOP", to: st, by: userName(), note: movNote, at: now });
      payloadItems.push({ templateId: tid, splitParts: splitPayload, movementId: movId });
    });

    await CNCDB.putMany("parts", updatedParts);
    await CNCDB.putMany("templates", updatedTemplates);
    await CNCDB.putMany("movements", createdMovements);

    const payload = payloadItems.length===1
      ? { templateId: payloadItems[0].templateId, splitParts: payloadItems[0].splitParts, movementId: payloadItems[0].movementId, storage: st, by: userName(), note: baseNote, requestId, updatedAt: now }
      : { items: payloadItems, storage: st, by: userName(), note: baseNote, requestId, updatedAt: now };
    await CNCSync.enqueueAndSync("distributeTemplate", payload);

    distSelections.clear();
    selectedTemplateId="";
    if($("distNote")) $("distNote").value="";
    await reloadLocalState();
    toast(anyPartial
      ? `Distribusi split ke ${st} tersimpan lokal (sisa tetap waiting)`
      : `Distribusi ${updatedTemplates.length} template ke ${st} tersimpan lokal`);
  }
  catch(e){ uiAlert("Gagal distribusi: "+e.message); }
  finally{ distSubmitting=false; setBusy(false); renderDistributionSummary(); }
}
function renderMovementStart(){
  if(!$("moveStorageFrom")) return;
  const prevFrom=$("moveStorageFrom").value;
  const prevTo=$("moveStorageTo").value;
  $("moveStorageFrom").innerHTML = db.storages.map(s=>`<option value="${escAttr(s.code)}">${esc(s.code)} · ${esc(s.name)}</option>`).join("");
  $("moveStorageTo").innerHTML = db.storages.filter(s=>s.code!=="WORKSHOP").map(s=>`<option value="${escAttr(s.code)}">${esc(s.code)} · ${esc(s.name)}</option>`).join("");
  if(prevFrom && db.storages.some(s=>s.code===prevFrom)) $("moveStorageFrom").value=prevFrom;
  if(prevTo && db.storages.some(s=>s.code===prevTo && s.code!=="WORKSHOP")) $("moveStorageTo").value=prevTo;
  renderMoveTemplates();
}
function renderMoveTemplates(){
  if(!$("moveTemplateList")) return;
  const from=$("moveStorageFrom")?.value || "";
  const rows=templatesInStorage(from);
  $("moveTemplateList").innerHTML = rows.length ? rows.map(t=>`<div class="template-pick-card ${selectedMoveTemplateId===t.id?'selected':''}" onclick="selectedMoveTemplateId='${escAttr(t.id)}';renderMoveTemplates()"><b>${esc(t.buyer)} · ${esc(t.stylekp)}</b><span>${esc(partTextInStorage(t.id, from))}</span><small>${esc(t.id)}</small></div>`).join("") : `<div class="empty">Tidak ada template di storage ini.</div>`;
}
async function saveMovement(){
  if(!requireLogin("menyimpan movement template")) return;
  const t=db.templates.find(x=>x.id===selectedMoveTemplateId); if(!t) return uiAlert("Pilih template dulu.");
  const from=normalizeText($("moveStorageFrom")?.value || t.currentStorage);
  const type=normalizeText($("moveType").value || "TRANSFER");
  const to=type==="OUT" ? "" : normalizeText($("moveStorageTo").value);
  if(type!=="OUT" && !to) return uiAlert("Storage tujuan wajib dipilih.");
  if(type!=="OUT" && from && from===to) return uiAlert("Anti duplicate aktif: Storage asal dan tujuan sama.");

  setBusy(true,"Menyimpan movement ke database lokal...");
  try{
    const now=nowISO();
    const movId=id("MOV");
    const note=$("moveNote").value.trim();
    const currentParts=partsOf(t.id).map(p=>({...p}));
    const updatedParts=[];

    if(currentParts.length){
      let matching=from ? currentParts.filter(pp=>isPartDistributed(pp) && normalizeText(pp.currentStorage)===from) : currentParts.filter(isPartDistributed);
      if(!matching.length) matching=currentParts.filter(isPartDistributed);

      const destByKey=new Map();
      if(type!=="OUT"){
        currentParts.forEach(pp=>{
          if(isPartDistributed(pp) && normalizeText(pp.currentStorage)===to){
            const k=`${normalizeText(pp.part)}||${normalizeText(pp.size||"")}`;
            if(!destByKey.has(k)) destByKey.set(k, pp);
          }
        });
      }

      matching.forEach(pp=>{
        if(type==="OUT"){
          pp.status="OUT"; pp.currentStorage=""; pp.updatedAt=now;
          updatedParts.push(pp);
        }else{
          const k=`${normalizeText(pp.part)}||${normalizeText(pp.size||"")}`;
          const dest=destByKey.get(k);
          if(dest && dest.partId!==pp.partId){
            dest.qty = Math.max(1, Number(dest.qty||0)) + Math.max(1, Number(pp.qty||1));
            dest.updatedAt=now;
            updatedParts.push(dest);
            pp.deleted=true; pp.updatedAt=now;
            updatedParts.push(pp);
          }else{
            pp.status="DISTRIBUTED"; pp.currentStorage=to; pp.updatedAt=now;
            updatedParts.push(pp);
            destByKey.set(k, pp);
          }
        }
      });
    }

    const activeParts=currentParts.filter(pp=>!pp.deleted);
    let newStatus=type==="OUT" ? "OUT" : "DISTRIBUTED";
    let newStorage=type==="OUT" ? "" : to;
    if(activeParts.length){
      const remainingWaiting=activeParts.some(isPartWaiting);
      const distStorages=[...new Set(activeParts.filter(isPartDistributed).map(pp=>normalizeText(pp.currentStorage)).filter(Boolean))].sort();
      newStatus = remainingWaiting ? "WAITING_DISTRIBUTION" : (distStorages.length ? "DISTRIBUTED" : "OUT");
      newStorage = distStorages.join(", ");
    }

    await CNCDB.putMany("parts", updatedParts);
    await CNCDB.putOne("templates", { ...t, status: newStatus, currentStorage: newStorage, updatedAt: now });
    await CNCDB.putOne("movements", { id: movId, templateId: t.id, type, from, to, by: userName(), note, at: now });
    await CNCSync.enqueueAndSync("moveTemplate", { templateId: t.id, type, from, to, by: userName(), note, movementId: movId, updatedAt: now });

    selectedMoveTemplateId=""; $("moveNote").value="";
    await reloadLocalState();
    toast("Movement tersimpan lokal & masuk antrean sync");
  }
  catch(e){ uiAlert("Gagal simpan movement: "+e.message); }
  finally{ setBusy(false); }
}
function renderStorage(){
  if(!$("storageGrid")) return;
  const q=($("storageSearch")?.value||"").toLowerCase();
  const rows=db.storages.filter(s=>!q || [s.code,s.name,s.area].join(" ").toLowerCase().includes(q));
  $("storageGrid").innerHTML = rows.map(s=>{ const total=templatesInStorage(s.code).length; return `<div class="card storage-card" onclick="openStorage('${escAttr(s.code)}')"><b>${esc(s.code)}</b><p>${esc(s.name)}</p><span class="badge">${total} template</span><div class="muted">${esc(s.area||"")}</div></div>`; }).join("");
}
function openStorage(code){
  if(!requireLogin(`melihat detail isi storage ${code}`)) return;
  const s=db.storages.find(x=>x.code===code); const rows=templatesInStorage(code);
  $("modalTitle").textContent = s ? `${s.code} · ${s.name}` : code;
  const addBtn = `<div class="actions"><button class="good" onclick="goFieldUpdateStorage('${escAttr(code)}')">+ Tambah Template di Storage Ini</button></div>`;
  $("modalContent").innerHTML = addBtn + (rows.length ? rows.map(t=>`<div class="line-item"><b>${esc(t.buyer)} · ${esc(t.stylekp)}</b><span>${esc(partTextInStorage(t.id, code))}<br><button class="small" onclick="openTemplateDetail('${escAttr(t.id)}')">Detail</button></span></div>`).join("") : `<div class="empty">Storage kosong.</div>`);
  openModal();
}
function scanBarcode(targetId, callbackName){
  window.__scanTargetId = targetId;
  window.__scanCallbackName = callbackName || "";

  if (window.WebViewInterface && typeof window.WebViewInterface.setWebViewString === "function") {
    window.WebViewInterface.setWebViewString("SCAN_REQUEST:" + targetId);
    return;
  }

  if(window.Android){
    if(typeof window.Android.scanQr==="function"){ window.Android.scanQr(); return; }
    if(typeof window.Android.scanBarcode==="function"){ window.Android.scanBarcode("onNativeBarcodeResult"); return; }
    if(typeof window.Android.startScan==="function"){ window.Android.startScan("onNativeBarcodeResult"); return; }
    if(typeof window.Android.openScanner==="function"){ window.Android.openScanner("onNativeBarcodeResult"); return; }
  }

  if(window.Html5Qrcode && !isAndroidNative()){
    const readerId = targetId==="scanStorageCode" ? "reader" : (targetId==="importMainStorage" ? "importReader" : (targetId==="distScanCode" ? "distReader" : "moveReader"));
    const box=$(readerId); if(!box) return fallbackPrompt(targetId,callbackName); box.classList.remove("hidden");
    if(scanner){ try{scanner.stop()}catch(e){} }
    scanner = new Html5Qrcode(readerId);
    scanner.start({ facingMode:"environment" }, { fps:10, qrbox:220 }, txt=>{
      setScanValue(targetId, txt);
      try{scanner.stop()}catch(e){};
      box.classList.add("hidden");
      runScanCallback(callbackName);
    }, err=>{}).catch(()=>fallbackPrompt(targetId,callbackName));
    return;
  }

  fallbackPrompt(targetId, callbackName);
}
async function fallbackPrompt(targetId, callbackName){ const v = await uiPrompt("Masukkan kode QR / storage secara manual:", "", "Input Kode QR", "Contoh: CNC-MEJA-01"); if(v && String(v).trim()){ setScanValue(targetId, String(v).trim()); runScanCallback(callbackName); } }
function setScanValue(targetId, value){ const el=$(targetId); if(el) el.value=value||""; }
function runScanCallback(callbackName){ if(callbackName && window[callbackName]) window[callbackName](); }
function onNativeBarcodeResult(value){ const target=window.__scanTargetId; setScanValue(target, value); runScanCallback(window.__scanCallbackName); }
function onNativeQrScanned(value){ onNativeBarcodeResult(value); }
function onBarcodeScanned(value){ onNativeBarcodeResult(value); }
function onScanResult(value){ onNativeBarcodeResult(value); }
function setBarcodeValue(value){ onNativeBarcodeResult(value); }

if (typeof window.WebViewInterface === "object") {
  window.WebViewInterface.setScanResult = function(message) {
    const text = String(message || "");
    let field = window.__scanTargetId;
    let value = text;
    if (text.includes("=")) {
      const parts = text.split("=");
      field = parts.shift() || field;
      value = parts.join("=");
    }
    setScanValue(field, value);
    runScanCallback(window.__scanCallbackName);
  };
}
function openScannedStorage(){ const code=$("scanStorageCode").value.trim(); if(!code) return uiAlert("Scan / isi kode storage dulu."); openStorage(code); }
function setMoveFromScanned(){ const code=$("moveScanCode").value.trim(); if(!code) return; const sel=$("moveStorageFrom"); if([...sel.options].some(o=>o.value===code)){ sel.value=code; selectedMoveTemplateId=""; renderMoveTemplates(); toast("Storage asal dipilih"); } else uiAlert("Kode storage tidak ada di master."); }

function renderMaster(){
  if(!$('storageList')) return;
  renderSuggestions();
  $('storageList').innerHTML = db.storages.length ? db.storages.map(s=>`<div class="line-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div><b>${esc(s.code)}</b><span>${esc(s.name)} · ${esc(s.area||"")}</span></div>${(isAdmin() && s.code!=="WORKSHOP")?`<button class="small bad" type="button" onclick="softDeleteStorage('${escAttr(s.code)}')">Hapus</button>`:""}</div>`).join("") : `<div class="empty">Belum ada master storage.</div>`;
}
async function loadUsers(){
  if(!isSuperAdmin()) return;
  if(!CNCSync.isOnline()){ toast("Mode offline: daftar user hanya bisa dimuat saat online."); return; }
  try{
    const res = await CNCSync.postApi("listUsers", {});
    db.users = res.users || [];
    await CNCDB.putMany("users", db.users);
    renderUserManagement();
  }catch(e){ toast("Gagal memuat daftar user: "+e.message); }
}
function renderUserManagement(){
  if(!$('userList')) return;
  if(!isSuperAdmin()){
    $('userList').innerHTML = `<div class="empty">Menu User Management khusus super admin.</div>`;
    return;
  }
  $('userList').innerHTML = db.users.length ? db.users.map(u=>`<div class="line-item"><b>${esc(u.username)}</b><span>${esc(u.name)} · ${esc(u.role)} · ${String(u.active).toUpperCase()!=="FALSE"?"aktif":"nonaktif"}</span></div>`).join("") : `<div class="empty">Belum ada data user. Klik Refresh User saat online.</div>`;
}

async function addStorage(){
  if(!requireLogin("menambahkan master storage")) return;
  const code=normalizeText($("storageCode").value), name=$("storageName").value.trim(), area=$("storageArea").value.trim();
  if(!code || !name) return uiAlert("Kode dan nama storage wajib diisi.");
  if(db.storages.some(s=>String(s.code).toUpperCase()===code)) return uiAlert("Anti duplicate aktif: Kode storage sudah ada di master.");
  setBusy(true,"Simpan storage ke database lokal...");
  try{
    const now=nowISO();
    const stObj={ code, name, area, createdAt: now, updatedAt: now, deleted: false };
    await CNCDB.putOne("storages", stObj);
    await CNCSync.enqueueAndSync("upsertStorage", { code, name, area, createdAt: now, updatedAt: now });
    $("storageCode").value=""; $("storageName").value=""; $("storageArea").value="";
    await reloadLocalState();
    toast("Storage ditambahkan & masuk antrean sync");
  }
  catch(e){ uiAlert("Gagal tambah storage: "+e.message); }
  finally{ setBusy(false); }
}
async function softDeleteStorage(code){
  if(!requireLogin("menghapus master storage")) return;
  if(!isAdmin()) return uiAlert("Hapus storage khusus admin dan super_admin.");
  const normCode=normalizeText(code);
  if(normCode==="WORKSHOP") return uiAlert("WORKSHOP tidak dapat dihapus.");
  const s=db.storages.find(x=>normalizeText(x.code)===normCode);
  if(!s) return;
  if(!(await uiConfirm(`Hapus storage ${s.code} (${s.name})?\nDitandai soft-delete dan disinkronkan ke perangkat lain.`, "Hapus Storage", { okText: "Ya, Hapus", danger: true }))) return;
  const now=nowISO();
  await CNCDB.putOne("storages", { ...s, deleted: true, updatedAt: now });
  await CNCSync.enqueueAndSync("softDeleteStorage", { code: s.code, updatedAt: now });
  await reloadLocalState();
  toast("Storage dihapus (soft delete)");
}
async function addUser(){
  if(!requireLogin("menambahkan user")) return;
  if(!isSuperAdmin()) return uiAlert("Khusus super admin.");
  if(!CNCSync.isOnline()) return uiAlert("Tambah user memerlukan koneksi online.");
  const username=$("newUsername").value.trim().toLowerCase(), password=$("newPassword").value, name=$("newName").value.trim(), role=$("newRole").value;
  if(!username || !password) return uiAlert("Username dan password wajib.");
  if(password.length < 10) return uiAlert("Password minimal 10 karakter.");
  if(db.users.some(u=>String(u.username).toLowerCase()===username)) return uiAlert("Anti duplicate aktif: Username sudah ada.");
  setBusy(true,"Tambah user...");
  try{
    await CNCSync.postApi("addUser", {username,password,role,name:name||username,active:"TRUE",by:userName()});
    $("newUsername").value=""; $("newPassword").value=""; $("newName").value="";
    await loadUsers();
    toast("User ditambahkan");
  }
  catch(e){ uiAlert("Gagal tambah user: "+e.message); }
  finally{ setBusy(false); }
}

/* ================= APK-PROOF QR PRINTING (PNG IMG + Android.printHtml) ================= */
function materializeQrImages(container){
  if(!container || typeof container.querySelectorAll !== "function") return;
  const canvases = container.querySelectorAll("canvas");
  canvases.forEach(cv=>{
    try{
      if(typeof cv.toDataURL !== "function") return;
      const dataUrl = cv.toDataURL("image/png");
      if(!dataUrl || dataUrl === "data:,") return;
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "QR Code";
      img.style.display = "block";
      if(cv.parentNode) cv.parentNode.replaceChild(img, cv);
    }catch(e){}
  });
}
function buildStandalonePrintHtml(title, cssRules, bodyHtml){
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"/><title>${esc(title)}</title><style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif}${cssRules}</style></head><body>${bodyHtml}</body></html>`;
}
function triggerBrowserPrint(targetKey){
  document.body.dataset.printTarget = targetKey;
  const cleanup = () => { delete document.body.dataset.printTarget; };
  window.addEventListener("afterprint", cleanup, { once: true });
  setTimeout(()=>{ window.print(); }, 250);
  setTimeout(cleanup, 4000);
}

function renderTemplateQrSelection(){
  const box=$("templateQrSelection"); if(!box) return;
  const q=($("templateQrSearch")?.value||"").trim().toLowerCase();
  const list=db.templates.filter(t=>!q||`${t.buyer} ${t.stylekp} ${partText(t.id)} ${t.id}`.toLowerCase().includes(q));
  $("templateQrSelectedCount").textContent=selectedTemplateQR.size;
  if(!list.length){box.innerHTML='<div class="empty">Template tidak ditemukan.</div>';return;}
  box.innerHTML=list.map(t=>`<div class="qr-check-card template-qr-select-card"><label><input type="checkbox" class="template-qr-check" data-id="${escAttr(t.id)}" ${selectedTemplateQR.has(String(t.id))?"checked":""}><div><b>${esc(t.buyer)} · ${esc(t.stylekp)}</b><span>Proses: ${esc(partText(t.id)||"—")} · ${esc(t.id)}</span></div></label><div class="ct-entry"><label for="ct-${escAttr(t.id)}">CT / Cycle Time</label><input id="ct-${escAttr(t.id)}" class="template-qr-ct-input" data-id="${escAttr(t.id)}" value="${escAttr(templateCTValues[t.id]||"")}" maxlength="30" placeholder="contoh: 45 detik / 00:45"></div></div>`).join("");
  box.querySelectorAll(".template-qr-check").forEach(el=>el.onchange=()=>{if(el.checked)selectedTemplateQR.add(el.dataset.id);else selectedTemplateQR.delete(el.dataset.id);$("templateQrSelectedCount").textContent=selectedTemplateQR.size;});
  box.querySelectorAll(".template-qr-ct-input").forEach(el=>el.oninput=()=>{templateCTValues[el.dataset.id]=el.value;});
}
function selectAllTemplateQR(on){
  const q=($("templateQrSearch")?.value||"").trim().toLowerCase();
  db.templates.filter(t=>!q||`${t.buyer} ${t.stylekp} ${partText(t.id)} ${t.id}`.toLowerCase().includes(q)).forEach(t=>{if(on)selectedTemplateQR.add(String(t.id));else selectedTemplateQR.delete(String(t.id));});
  renderTemplateQrSelection();
}
function setTemplateQrPaper(){
  const area=$("templateQrPrintArea"), paper=$("templateQrPaper")?.value||"A4";
  if(!area)return;
  area.classList.toggle("template-qr-roll",paper!=="A4");
  area.dataset.width=paper==="A4"?"":paper;
}
function buildTemplateQrPrint(){
  const list=db.templates.filter(t=>selectedTemplateQR.has(String(t.id)));
  if(!list.length){uiAlert("Pilih minimal satu template untuk dicetak.");return false;}
  const missing=list.filter(t=>!String(templateCTValues[t.id]||"").trim());
  if(missing.length){uiAlert("Isi CT untuk semua label terpilih. CT tidak disimpan ke database.");return false;}
  const area=$("templateQrPrintArea");
  setTemplateQrPaper();
  area.innerHTML=list.map((t,i)=>`<article class="template-qr-label"><div class="template-qr-holder" id="template-qr-${i}"></div><div class="template-qr-style">${esc(t.stylekp||"—")}</div><div class="template-qr-process">PROSES: ${esc(partText(t.id)||"—")}</div><div class="template-qr-ct">CT: ${esc(templateCTValues[t.id])}</div><div class="template-qr-id">${esc(t.id)}</div></article>`).join("");
  list.forEach((t,i)=>{const el=$("template-qr-"+i);if(window.QRCode&&el){try{window.QRCode(el,{text:String(t.id),width:220,height:220,margin:4});}catch(e){el.textContent="QR error";}}else if(el)el.textContent="QR tidak tersedia";});
  materializeQrImages(area);
  return true;
}
function buildTemplateQrStandaloneHtml(paper){
  const area = $("templateQrPrintArea");
  const isRoll = paper === "58" || paper === "80";
  const labelW = paper === "58" ? "54mm" : "76mm";
  const qrSize = paper === "58" ? "28mm" : (paper === "80" ? "36mm" : "32mm");
  const css = isRoll
    ? `@page{size:${paper}mm auto;margin:1mm}.print-grid{display:block;width:${paper}mm;margin:0 auto}.template-qr-label{width:${labelW};margin:0 auto 2mm;padding:3mm;border:1px solid #111;border-radius:2mm;text-align:center;page-break-after:always;break-after:page;page-break-inside:avoid;break-inside:avoid;display:flex;flex-direction:column;align-items:center;gap:1.2mm}.template-qr-label:last-child{page-break-after:auto;break-after:auto}.template-qr-label img{width:${qrSize};height:${qrSize};display:block}.template-qr-style{font-size:11pt;font-weight:800;line-height:1.2}.template-qr-process{font-size:8.5pt;line-height:1.25;overflow-wrap:anywhere}.template-qr-ct{font-size:10.5pt;font-weight:800}.template-qr-id{font-size:7pt;color:#333}`
    : `@page{size:A4 portrait;margin:8mm}.print-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4mm;width:100%}.template-qr-label{border:1px solid #111;border-radius:3mm;padding:4mm;text-align:center;page-break-inside:avoid;break-inside:avoid;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.4mm;min-height:68mm}.template-qr-label img{width:${qrSize};height:${qrSize};display:block}.template-qr-style{font-size:12pt;font-weight:800;line-height:1.2}.template-qr-process{font-size:9pt;line-height:1.25;overflow-wrap:anywhere}.template-qr-ct{font-size:11pt;font-weight:800}.template-qr-id{font-size:7pt;color:#333}`;
  return buildStandalonePrintHtml("QR Template CNC", css, `<div class="print-grid">${area ? area.innerHTML : ""}</div>`);
}
function printTemplateQR(){
  if(!buildTemplateQrPrint()) return;
  const paper=$("templateQrPaper")?.value||"A4";
  if(window.Android && typeof window.Android.printHtml === "function"){
    try{
      const html = buildTemplateQrStandaloneHtml(paper);
      window.Android.printHtml(html, "CNC_QR_Template_" + paper, paper);
      toast("Membuka dialog Print / PDF Android...");
      return;
    }catch(e){
      uiAlert("Gagal membuka print Android: " + e.message);
    }
  }
  let style=$("templateQrPageStyle");if(!style){style=document.createElement("style");style.id="templateQrPageStyle";document.head.appendChild(style);}
  style.textContent=paper==="A4"?'@media print{@page{size:A4 portrait;margin:8mm}.template-qr-print-area{width:100%;min-height:0;padding:0;grid-template-columns:repeat(2,minmax(0,1fr));gap:4mm}}':`@media print{@page{size:${paper}mm auto;margin:1mm}.template-qr-print-area{width:${paper}mm;min-height:0;padding:0;grid-template-columns:1fr;gap:0}.template-qr-label{width:${Number(paper)-4}mm}}`;
  triggerBrowserPrint("templateQr");
}

function renderPrintQRSelection(){
  if(!$("qrSelection")) return;
  const arr=db.storages.filter(s=>s.code!=="WORKSHOP");
  $("qrSelectedCount").textContent = selectedQR.size;
  $("qrSelection").innerHTML=arr.map(s=>`<label class="qr-check-card"><input type="checkbox" ${selectedQR.has(s.code)?"checked":""} onchange="toggleQR('${escAttr(s.code)}',this.checked)"><div><b>${esc(s.code)}</b><span>${esc(s.name)} · ${esc(s.area||"")}</span></div></label>`).join("");
}
function toggleQR(code,on){ on?selectedQR.add(code):selectedQR.delete(code); renderPrintQRSelection(); }
function selectAllQR(on){ selectedQR = new Set(on ? db.storages.filter(s=>s.code!=="WORKSHOP").map(s=>s.code) : []); renderPrintQRSelection(); }
function buildPrintQR(){
  const size=Number($("qrPerPage").value||8); const list=db.storages.filter(s=>selectedQR.has(s.code));
  if(!list.length){ toast("Pilih storage dulu"); return []; }
  const cols=size<=4?2: size<=8?2:3;
  const area=$("qrPrintArea");
  area.style.gridTemplateColumns=`repeat(${cols},1fr)`;
  area.innerHTML = list.map((s,i)=>`<div class="qr-label"><div class="qr-title">${esc(s.name)}</div><div class="qr-real-holder" id="qr-print-${i}"></div><div class="qr-code-text">${esc(s.code)}</div><div class="qr-area-text">${esc(s.area||"")}</div></div>`).join("");
  list.forEach((s,i)=>{
    const el=$("qr-print-"+i);
    if(window.QRCode && el){
      try{ window.QRCode(el,{text:s.code,width:180,height:180,margin:4}); }
      catch(err){ el.innerHTML=`<div class="qr-fallback">QR ERROR<br>${esc(s.code)}</div>`; }
    } else if(el){
      el.innerHTML=`<div class="qr-fallback">QR<br>${esc(s.code)}</div>`;
    }
  });
  materializeQrImages(area);
  toast("Preview QR dibuat");
  return list;
}
function buildStorageQrStandaloneHtml(cols){
  const area = $("qrPrintArea");
  const css = `@page{size:A4 portrait;margin:8mm}.qr-grid{display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:5mm;width:100%}.qr-label{border:1px solid #111;border-radius:4mm;padding:4mm;text-align:center;page-break-inside:avoid;break-inside:avoid;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:56mm}.qr-title{font-weight:800;font-size:13pt;margin-bottom:2mm}.qr-real-holder img{width:34mm;height:34mm;display:block;margin:1mm auto}.qr-code-text{font-weight:800;font-size:11pt;margin-top:2mm}.qr-area-text{font-size:9pt;color:#333}`;
  return buildStandalonePrintHtml("QR Storage CNC", css, `<div class="qr-grid">${area ? area.innerHTML : ""}</div>`);
}
function printQR(){
  const list = buildPrintQR();
  if(!list.length) return;
  const size=Number($("qrPerPage").value||8);
  const cols=size<=4?2: size<=8?2:3;
  if(window.Android && typeof window.Android.printHtml === "function"){
    try{
      const html = buildStorageQrStandaloneHtml(cols);
      window.Android.printHtml(html, "CNC_QR_Storage", "A4");
      toast("Membuka dialog Print / PDF Android...");
      return;
    }catch(e){
      uiAlert("Gagal membuka print Android: " + e.message);
    }
  }
  triggerBrowserPrint("qr");
  toast("Di dialog print pilih Save as PDF jika mau kirim ke WhatsApp.");
}
async function shareQRWhatsApp(){
  const list = buildPrintQR();
  if(!list.length) return;
  const text = "CNC Template Tracker - QR Storage\n\n" + list.map(s=>`${s.code} - ${s.name||""}${s.area?" ("+s.area+")":""}`).join("\n");
  if(window.Android && typeof window.Android.shareQRText === "function"){
    try{ window.Android.shareQRText(text); return; }catch(e){}
  }
  if(navigator.share){
    try{ await navigator.share({title:"QR Storage", text}); return; }catch(e){}
  }
  window.open("https://wa.me/?text="+encodeURIComponent(text), "_blank");
}


function goFieldUpdateStorage(code){
  closeModal();
  showPage('fieldUpdate');
  setTimeout(()=>selectFieldStorage(code), 60);
}
function renderFieldUpdate(){
  renderSuggestions();
  renderFieldUpdateStorageList();
  ensureFieldTemplateRow();
  renderFieldUploadPreview();
}
function renderFieldUpdateStorageList(){
  const box=$('fieldStorageGrid'); if(!box) return;
  const q=($('fieldStorageSearch')?.value||'').toLowerCase();
  const rows=db.storages.filter(s=>!q || [s.code,s.name,s.area].join(' ').toLowerCase().includes(q));
  if($('fieldSelectedStorage')) $('fieldSelectedStorage').value = selectedFieldStorage || '';
  box.innerHTML = rows.length ? rows.map(s=>{
    const total=templatesInStorage(s.code).length;
    const sel=selectedFieldStorage===s.code ? ' selected' : '';
    return `<div class="card storage-card${sel}" onclick="selectFieldStorage('${escAttr(s.code)}')"><b>${esc(s.code)}</b><p>${esc(s.name||'')}</p><span class="badge">${total} template</span><div class="muted">${esc(s.area||'')}</div><div class="actions"><button class="small good" type="button" onclick="event.stopPropagation();selectFieldStorage('${escAttr(s.code)}')">+ Tambah Template</button><button class="small" type="button" onclick="event.stopPropagation();openStorage('${escAttr(s.code)}')">Lihat Isi</button></div></div>`;
  }).join('') : `<div class="empty">Storage tidak ditemukan. Tambahkan dulu di Master Storage.</div>`;
}
function selectFieldStorage(code){
  selectedFieldStorage = normalizeText(code || '');
  const s=db.storages.find(x=>String(x.code).toUpperCase()===selectedFieldStorage);
  if($('fieldSelectedStorage')) $('fieldSelectedStorage').value = selectedFieldStorage;
  if($('fieldStorageTitle')) $('fieldStorageTitle').textContent = s ? `${s.code} · ${s.name || ''}` : selectedFieldStorage;
  if($('fieldTemplateFormCard')) $('fieldTemplateFormCard').classList.toggle('hidden', !selectedFieldStorage);
  ensureFieldTemplateRow();
  renderFieldUpdateStorageList();
  renderFieldUploadPreview();
  if(selectedFieldStorage) toast('Storage dipilih: '+selectedFieldStorage);
}
function addFieldTemplateRow(data={}){
  const box=$('fieldTemplateRows'); if(!box) return;
  const row=document.createElement('div'); row.className='field-row';
  row.innerHTML=`<div class="field-row-grid"><div><label>Buyer</label><input class="field-buyer" list="buyerSuggest" placeholder="Buyer" value="${escAttr(data.buyer||'')}" onblur="normalizeInputLive(this);renderFieldUploadPreview()" oninput="renderFieldUploadPreview()"></div><div><label>Style / KP</label><input class="field-style" list="styleSuggest" placeholder="Style / KP" value="${escAttr(data.stylekp||'')}" onblur="normalizeInputLive(this);renderFieldUploadPreview()" oninput="renderFieldUploadPreview()"></div><div><label>Part Template</label><input class="field-part" list="partSuggest" placeholder="FRONT BODY, BACK BODY x2" value="${escAttr(data.part||'')}" onblur="normalizeInputLive(this);renderFieldUploadPreview()" oninput="renderFieldUploadPreview()"></div><div><label>Qty</label><input class="field-qty" type="number" inputmode="numeric" pattern="[0-9]*" step="1" min="1" value="${Number(data.qty||1)}" oninput="renderFieldUploadPreview()"></div><button class="bad small" type="button" onclick="this.closest('.field-row').remove();ensureFieldTemplateRow();renderFieldUploadPreview()">Hapus</button></div><label>Catatan</label><input class="field-note" placeholder="Opsional" value="${escAttr(data.note||'')}" oninput="renderFieldUploadPreview()">`;
  box.appendChild(row);
  renderSuggestions();
  renderFieldUploadPreview();
}
function addFieldTemplateRows(n=10){ for(let i=0;i<n;i++) addFieldTemplateRow(); }
function clearFieldTemplateRows(){ const box=$('fieldTemplateRows'); if(box) box.innerHTML=''; addFieldTemplateRow(); renderFieldUploadPreview(); }
function ensureFieldTemplateRow(){ if($('fieldTemplateRows') && !$('fieldTemplateRows').children.length) addFieldTemplateRow(); }
function getFieldTemplateRows(){
  const rows=[]; const errors=[];
  [...document.querySelectorAll('#fieldTemplateRows .field-row')].forEach((r,i)=>{
    const buyer=normalizeText(r.querySelector('.field-buyer')?.value || '');
    const stylekp=normalizeText(r.querySelector('.field-style')?.value || '');
    const partTextRaw=normalizeText(r.querySelector('.field-part')?.value || '');
    const qty=Math.max(1, Number(r.querySelector('.field-qty')?.value || 1));
    const note=(r.querySelector('.field-note')?.value || '').trim();
    if(!buyer && !stylekp && !partTextRaw) return;
    let parts=parsePartString(partTextRaw);
    if(parts.length===1 && qty>1) parts[0].qty=qty;
    if(!buyer || !stylekp || !parts.length){ errors.push(`Baris ${i+1}: Buyer, Style/KP, dan Part wajib lengkap.`); return; }
    rows.push({buyer, stylekp, parts, storage:selectedFieldStorage, note});
  });
  return {rows, errors};
}
function renderFieldUploadPreview(){
  const box=$('fieldUploadPreview'); if(!box) return;
  const {rows, errors}=getFieldTemplateRows();
  if($('fieldRowCount')) $('fieldRowCount').textContent=rows.length;
  if(!selectedFieldStorage){ box.innerHTML='<div class="empty">Pilih storage dulu, lalu tambah template.</div>'; return; }
  box.innerHTML = `<div class="muted">Preview upload ke <b>${esc(selectedFieldStorage)}</b>: ${rows.length} template valid${errors.length?` · ${errors.length} error`:''}</div>` + (errors.length?`<div class="empty">${errors.slice(0,8).map(esc).join('<br>')}</div>`:'') + (rows.length?`<table><thead><tr><th>Buyer</th><th>Style/KP</th><th>Part</th><th>Catatan</th></tr></thead><tbody>${rows.slice(0,30).map(r=>`<tr><td>${esc(r.buyer)}</td><td>${esc(r.stylekp)}</td><td>${esc(r.parts.map(p=>p.part+(p.qty>1?` x${p.qty}`:'')).join(', '))}</td><td>${esc(r.note||'')}</td></tr>`).join('')}</tbody></table>`:'');
}
async function applyBulkImportOffline(rows, opts){
  opts = opts || {};
  const now=nowISO();
  const defaultStorage=normalizeText(opts.defaultStorage||"");
  const forceDefaultStorage=!!opts.forceDefaultStorage;
  const createMissingStorage=opts.createMissingStorage!==false;
  const knownStorages=new Set(db.storages.map(s=>normalizeText(s.code)));
  const newStorages=[];
  const putTemplates=[];
  const putParts=[];
  const putMovements=[];
  const outboxRows=[];
  const errors=[];
  let inserted=0, updated=0;

  rows.forEach((r, idx)=>{
    const buyer=normalizeText(r.buyer);
    const stylekp=normalizeText(r.stylekp);
    const parts=(r.parts||[]).filter(p=>p && normalizeText(p.part));
    const st=(forceDefaultStorage && defaultStorage) ? defaultStorage : normalizeText(r.storage || defaultStorage);
    const note=String(r.note || "Update template existing/lapangan");
    if(!buyer || !stylekp || !parts.length){ errors.push(`Baris ${idx+1}: Buyer/Style/Part wajib`); return; }
    if(!st){ errors.push(`Baris ${idx+1}: Storage wajib`); return; }
    if(!knownStorages.has(st)){
      if(createMissingStorage){
        knownStorages.add(st);
        newStorages.push({ code: st, name: st, area: "Import Lapangan", createdAt: now, updatedAt: now, deleted: false });
      }else{
        errors.push(`Baris ${idx+1}: Storage ${st} belum ada di master`);
        return;
      }
    }

    const dup=findDuplicateTemplateLocal(buyer, stylekp, parts);
    const movId=id("MOV");
    if(dup){
      const oldSt=dup.currentStorage || "LAPANGAN";
      putTemplates.push({ ...dup, status: "DISTRIBUTED", currentStorage: st, distributedAt: dup.distributedAt || now, updatedAt: now, deleted: false });
      partsOf(dup.id).forEach(pp=>{
        putParts.push({ ...pp, status: "DISTRIBUTED", currentStorage: st, distributedAt: pp.distributedAt || now, updatedAt: now, deleted: false });
      });
      putMovements.push({ id: movId, templateId: dup.id, type: "UPDATE_EXISTING", from: oldSt, to: st, by: userName(), note, at: now });
      outboxRows.push({ id: dup.id, buyer, stylekp, parts, storage: st, note, movementId: movId });
      updated++;
    }else{
      const tid=id("TPL");
      const pRows=parts.map(x=>({
        partId: id("PRT"),
        templateId: tid,
        part: normalizeText(x.part),
        size: normalizeText(x.size || ""),
        qty: Math.max(1, Math.round(Number(x.qty || 1))),
        createdAt: now,
        status: "DISTRIBUTED",
        currentStorage: st,
        distributedAt: now,
        updatedAt: now,
        deleted: false
      }));
      putTemplates.push({ id: tid, buyer, stylekp, status: "DISTRIBUTED", currentStorage: st, hasSketch: false, createdBy: userName(), createdAt: now, updatedAt: now, distributedAt: now, deleted: false });
      pRows.forEach(p=>putParts.push(p));
      putMovements.push({ id: movId, templateId: tid, type: "IMPORT_EXISTING", from: "LAPANGAN", to: st, by: userName(), note, at: now });
      outboxRows.push({ id: tid, buyer, stylekp, parts: pRows, storage: st, note, movementId: movId, createdAt: now });
      inserted++;
    }
  });

  if(newStorages.length) await CNCDB.putMany("storages", newStorages);
  if(putTemplates.length) await CNCDB.putMany("templates", putTemplates);
  if(putParts.length) await CNCDB.putMany("parts", putParts);
  if(putMovements.length) await CNCDB.putMany("movements", putMovements);
  if(outboxRows.length){
    await CNCSync.enqueueAndSync("bulkImportExisting", {
      rows: outboxRows,
      defaultStorage,
      forceDefaultStorage,
      createMissingStorage,
      by: userName(),
      updatedAt: now
    });
  }
  await reloadLocalState();
  return { inserted, updated, errors };
}

async function saveFieldStorageTemplates(){
  if(!requireLogin("menyimpan update lapangan")) return;
  if(!selectedFieldStorage) return uiAlert('Pilih storage dulu.');
  const {rows, errors}=getFieldTemplateRows();
  if(errors.length) return uiAlert('Masih ada data belum lengkap:\n'+errors.slice(0,12).join('\n'));
  if(!rows.length) return uiAlert('Belum ada template yang diisi.');
  if(!(await uiConfirm(`Simpan ${rows.length} template ke storage ${selectedFieldStorage}?`, "Simpan Update Lapangan", { okText: "Ya, Simpan" }))) return;
  setBusy(true,'Menyimpan template ke database lokal...');
  try{
    const res=await applyBulkImportOffline(rows, { defaultStorage: selectedFieldStorage, forceDefaultStorage: true, createMissingStorage: false });
    clearFieldTemplateRows();
    selectFieldStorage(selectedFieldStorage);
    toast(`Tersimpan lokal: ${res.inserted} baru, ${res.updated} update · masuk antrean sync`);
    if(res.errors.length) uiAlert('Selesai dengan catatan:\n'+res.errors.slice(0,10).join('\n'));
  }catch(e){ uiAlert('Simpan gagal: '+e.message); }
  finally{ setBusy(false); }
}

function parsePartString(text){
  return String(text||"").split(/[,/]+/).map(x=>x.trim()).filter(Boolean).map(raw=>{
    const m=raw.match(/^(.*?)(?:\s*[xX]\s*(\d+))$/); return {part:normalizeText(m?m[1]:raw), qty:Math.max(1, Number(m?m[2]:1))};
  }).filter(x=>x.part);
}
function splitImportLine(line){
  if(line.includes("\t")) return line.split("\t").map(x=>x.trim());
  if(line.includes("|")) return line.split("|").map(x=>x.trim());
  if(line.includes(";")) return line.split(";").map(x=>x.trim());
  return line.split(",").map(x=>x.trim());
}
function importMainStorage(){ return normalizeText($("importMainStorage")?.value || ""); }
function isKnownStorageCode(v){ const code=normalizeText(v); return !!code && db.storages.some(s=>String(s.code).toUpperCase()===code); }
function parseExistingImportText(){
  const raw=$("existingImportText")?.value || "";
  const mainStorage=importMainStorage();
  const forceMain=!!$("importForceStorage")?.checked;
  const rows=[]; const errors=[];
  raw.split(/\r?\n/).forEach((line,i)=>{
    const clean=line.trim(); if(!clean) return;
    if(i===0 && /buyer/i.test(clean) && /(style|kp)/i.test(clean)) return;
    const cols=splitImportLine(clean);
    const buyer=normalizeText(cols[0]);
    const stylekp=normalizeText(cols[1]);
    const parts=parsePartString(cols[2]||"");
    let rowStorage="";
    let note="";
    if(cols.length>=5){
      rowStorage=normalizeText(cols[3]||"");
      note=cols.slice(4).join(" | ").trim();
    }else if(cols.length===4){
      if(mainStorage || forceMain){ note=cols[3].trim(); }
      else if(isKnownStorageCode(cols[3])){ rowStorage=normalizeText(cols[3]); }
      else { note=cols[3].trim(); }
    }
    const storage = (forceMain && mainStorage) ? mainStorage : normalizeText(rowStorage || mainStorage);
    if(!buyer || !stylekp || !parts.length){ errors.push(`Baris ${i+1}: Buyer/Style/Part belum lengkap`); return; }
    if(!storage){ errors.push(`Baris ${i+1}: Storage wajib. Isi Storage di atas atau kolom Storage.`); return; }
    rows.push({buyer,stylekp,parts,storage,note});
  });
  return {rows,errors,mainStorage,forceMain};
}
function renderImportPreview(){
  if(!$("importPreview")) return;
  const {rows,errors,mainStorage}=parseExistingImportText();
  const storageInfo = mainStorage ? `Storage utama: <b>${esc(mainStorage)}</b>` : `<b>Storage utama belum diisi</b>`;
  $("importPreview").innerHTML = `<div class="muted">${storageInfo} · Preview: ${rows.length} template valid${errors.length?` · ${errors.length} baris error`:""}. Data valid akan disimpan lokal & masuk antrean sync.</div>` + (errors.length?`<div class="empty">${errors.slice(0,8).map(esc).join("<br>")}</div>`:"") + (rows.length?`<table><thead><tr><th>Buyer</th><th>Style/KP</th><th>Part</th><th>Storage Update</th><th>Catatan</th></tr></thead><tbody>${rows.slice(0,30).map(r=>`<tr><td>${esc(r.buyer)}</td><td>${esc(r.stylekp)}</td><td>${esc(r.parts.map(p=>p.part+(p.qty>1?` x${p.qty}`:"")).join(", "))}</td><td>${esc(r.storage)}</td><td>${esc(r.note||"")}</td></tr>`).join("")}</tbody></table>`:"");
}
function setImportStorageScanned(){
  const code=normalizeText($("importMainStorage")?.value || "");
  if($("importMainStorage")) $("importMainStorage").value=code;
  renderImportPreview();
  if(code) toast("Storage import dipilih: "+code);
}
async function importExistingTemplates(){
  if(!requireLogin("mengimpor template lapangan")) return;
  const {rows,errors,mainStorage}=parseExistingImportText();
  if(errors.length) return uiAlert("Masih ada baris error. Rapikan dulu data import.");
  if(!rows.length) return uiAlert("Belum ada data yang bisa diupdate.");
  if(!(await uiConfirm(`Simpan ${rows.length} template lapangan ke storage ${mainStorage || rows[0].storage}?`, "Import Template Lapangan", { okText: "Ya, Import" }))) return;
  setBusy(true,"Menyimpan import lapangan ke database lokal...");
  try{
    const res=await applyBulkImportOffline(rows, {
      defaultStorage: mainStorage,
      forceDefaultStorage: !!$("importForceStorage")?.checked,
      createMissingStorage: !!$("importCreateStorage")?.checked
    });
    $("existingImportText").value=""; renderImportPreview();
    toast(`Tersimpan lokal: ${res.inserted} baru, ${res.updated} update · masuk antrean sync`);
    if(res.errors.length) uiAlert("Selesai dengan catatan:\n"+res.errors.slice(0,10).join("\n"));
  }catch(e){ uiAlert("Update gagal: "+e.message); }
  finally{ setBusy(false); }
}

window.addEventListener("DOMContentLoaded", async ()=>{
  detectDevice();
  addPartRow();
  setupSketchDropZone();
  CNCSync.subscribe(updateSyncIndicator);
  updateHeader();
  const loggedIn = await tryAutoLogin();
  if(!loggedIn) renderAuth();
  setTemplateAcrylicMode(db.acrylics.some(a=>a.qtyAvailable > 0) ? "NEW_SHEET" : "LEFTOVER");
});
