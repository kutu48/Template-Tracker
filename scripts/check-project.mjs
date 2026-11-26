import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

const rel = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFile(rel(p), 'utf8');

const [html, configJs, dbJs, syncJs, gas, bat, capConfig, mainKt, gradleProps, appGradle] = await Promise.all([
  read('public/index.html'),
  read('public/config.js'),
  read('public/db.js'),
  read('public/sync.js'),
  read('apps-script/Code.gs'),
  read('Jalankan.bat'),
  read('capacitor.config.json'),
  read('android/app/src/main/java/com/pancaprima/cnctracker/MainActivity.kt'),
  read('android/gradle.properties'),
  read('android/app/build.gradle.kts'),
]);

// 1. Validasi sintaks semua skrip klasik + Apps Script
new vm.Script(configJs, { filename: 'public/config.js' });
new vm.Script(dbJs, { filename: 'public/db.js' });
new vm.Script(syncJs, { filename: 'public/sync.js' });
new vm.Script(gas, { filename: 'apps-script/Code.gs' });

const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1])
  .filter((s) => s.trim());
if (!inlineScripts.length) throw new Error('No inline application scripts found in public/index.html');
for (const [i, script] of inlineScripts.entries()) {
  new vm.Script(script, { filename: `inline-${i + 1}.js` });
}

// 2. Pastikan offline-first, jalan di file://, tanpa CDN / type="module" / OpenSheet / JSONP / no-cors / hardcoded ID
if (/type\s*=\s*["']module["']/i.test(html)) throw new Error('Found type="module" in public/index.html (breaks file://)');
for (const forbidden of ['opensheet.elk.sh', 'jsonpGet', 'cdn.jsdelivr', 'unpkg.com', 'cdnjs.cloudflare', 'challenge-platform', 'DEFAULT_SPREADSHEET_ID', 'DEFAULT_API_BASE']) {
  if ((html + dbJs + syncJs).includes(forbidden)) {
    throw new Error(`Forbidden legacy/external pattern found: ${forbidden}`);
  }
}
if (/mode\s*:\s*['"]no-cors['"]/.test(html + dbJs + syncJs)) {
  throw new Error('Forbidden fetch mode: no-cors found');
}
for (const text of [html, gas]) {
  if (/const SPREADSHEET_ID\s*=\s*['"][A-Za-z0-9_-]{20,}['"]/.test(text)) {
    throw new Error('Found hard-coded SPREADSHEET_ID');
  }
}
if (/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/.test(html)) {
  throw new Error('Found hard-coded Apps Script Web App URL in public/index.html (move to config.js)');
}

// 3. Validasi fitur inti offline-first, UI Blue Navy, Login Pop-up, Akrilik, & Print APK
for (const needle of [
  './config.js',
  './db.js',
  './sync.js',
  'templateQrPrint',
  'slice(0, 5)',
  'syncNetBadge',
  'syncQueueBadge',
  'openServerSettingsModal',
  'exportBackupFile',
  'setupAutoBackupFolder',
  '--navy-900',
  'loginModal',
  'openLoginModal',
  'page-acrylic',
  'saveAcrylicStockIn',
  'materializeQrImages',
  'Android.printHtml',
]) {
  if (!html.includes(needle)) throw new Error(`Missing frontend feature in public/index.html: ${needle}`);
}

for (const needle of ['indexedDB', 'outbox', 'acrylics', 'acrylicLogs', 'exportBackupObject', 'importBackupObject', 'pickAutoBackupFolder', 'saveSketchLocal']) {
  if (!dbJs.includes(needle)) throw new Error(`Missing local DB feature in public/db.js: ${needle}`);
}

for (const needle of ['text/plain;charset=utf-8', 'pushOutbox', 'syncDelta', 'fetchSketch', 'retryAllFailedOutbox']) {
  if (!syncJs.includes(needle)) throw new Error(`Missing sync feature in public/sync.js: ${needle}`);
}

for (const needle of [
  'SESSIONS',
  'ACRYLIC_STOCKS',
  'ACRYLIC_LOGS',
  'TOKEN_TTL_DAYS = 30',
  'MAX_SKETCH_BYTES = 1024 * 1024',
  'DRIVE_FILE:',
  'function syncDelta_(',
  'function pushOutbox_(',
  'function requireSession_(',
  'function createPasswordHash_(',
  'function verifyPassword_(',
  'function stockInAcrylicCore_(',
  'function softDeleteAcrylicCore_(',
  'deleted',
]) {
  if (!gas.includes(needle)) throw new Error(`Missing backend feature in apps-script/Code.gs: ${needle}`);
}

// 4. Validasi PC launcher & Android Capacitor
if (!bat.includes('public\\index.html') || !bat.includes('--user-data-dir')) {
  throw new Error('Jalankan.bat missing local public\\index.html or --user-data-dir');
}
const cap = JSON.parse(capConfig);
if (cap.webDir !== 'public') throw new Error('capacitor.config.json webDir must be "public"');
if (gradleProps.includes('APP_URL') || appGradle.includes('APP_URL')) {
  throw new Error('Android config still references obsolete APP_URL');
}
for (const needle of ['BridgeActivity', 'fun shareQRText(', 'fun printHtml(', 'buildPrintAttributes', 'onShowFileChooser', 'fun saveSketchFile(', 'fun readSketchFile(']) {
  if (!mainKt.includes(needle)) throw new Error(`Missing Android bridge/Capacitor feature in MainActivity.kt: ${needle}`);
}
await access(rel('android/app/src/main/res/xml/file_paths.xml'));

console.log(`OK: parsed config.js, db.js, sync.js, ${inlineScripts.length} inline scripts, and Code.gs; offline-first PC, Capacitor Android printHtml, Blue Navy UI, and Akrilik flow checks passed.`);
