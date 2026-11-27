import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

const rel = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFile(rel(p), 'utf8');

const [
  html,
  stylesCss,
  configJs,
  dbJs,
  syncJs,
  qrcodeJs,
  appJs,
  gas,
  bat,
  capConfig,
  mainKt,
  gradleProps,
  appGradle,
  settingsGradle,
  manifestXml,
  proguardRules,
] = await Promise.all([
  read('public/index.html'),
  read('public/styles.css'),
  read('public/config.js'),
  read('public/db.js'),
  read('public/sync.js'),
  read('public/vendor/qrcode.js'),
  read('public/app.js'),
  read('apps-script/Code.gs'),
  read('Jalankan.bat'),
  read('capacitor.config.json'),
  read('android/app/src/main/java/com/pancaprima/cnctracker/MainActivity.kt'),
  read('android/gradle.properties'),
  read('android/app/build.gradle.kts'),
  read('android/settings.gradle.kts'),
  read('android/app/src/main/AndroidManifest.xml'),
  read('android/app/proguard-rules.pro'),
]);

// 1. Validasi sintaks semua skrip klasik + Apps Script
new vm.Script(configJs, { filename: 'public/config.js' });
new vm.Script(dbJs, { filename: 'public/db.js' });
new vm.Script(syncJs, { filename: 'public/sync.js' });
new vm.Script(qrcodeJs, { filename: 'public/vendor/qrcode.js' });
new vm.Script(appJs, { filename: 'public/app.js' });
new vm.Script(gas, { filename: 'apps-script/Code.gs' });

const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1])
  .filter((s) => s.trim());
for (const [i, script] of inlineScripts.entries()) {
  new vm.Script(script, { filename: `inline-${i + 1}.js` });
}

// 2. Pastikan offline-first, jalan di file://, tanpa CDN / type="module" / OpenSheet / JSONP / no-cors / hardcoded ID
if (/type\s*=\s*["']module["']/i.test(html)) {
  throw new Error('Found type="module" in public/index.html (breaks file://)');
}
const allFrontend = html + stylesCss + dbJs + syncJs + qrcodeJs + appJs;
for (const forbidden of [
  'opensheet.elk.sh',
  'jsonpGet',
  'cdn.jsdelivr',
  'unpkg.com',
  'cdnjs.cloudflare',
  'challenge-platform',
  'DEFAULT_SPREADSHEET_ID',
  'DEFAULT_API_BASE',
]) {
  if (allFrontend.includes(forbidden)) {
    throw new Error(`Forbidden legacy/external pattern found: ${forbidden}`);
  }
}
if (/mode\s*:\s*['"]no-cors['"]/.test(allFrontend)) {
  throw new Error('Forbidden fetch mode: no-cors found');
}
for (const text of [html, appJs, gas]) {
  if (/const SPREADSHEET_ID\s*=\s*['"][A-Za-z0-9_-]{20,}['"]/.test(text)) {
    throw new Error('Found hard-coded SPREADSHEET_ID');
  }
}
if (/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/.test(html + appJs)) {
  throw new Error('Found hard-coded Apps Script Web App URL in frontend (move to config.js)');
}
if (/\b(alert|confirm|prompt)\s*\(/.test(appJs)) {
  throw new Error('Found native blocking alert/confirm/prompt in public/app.js (use uiAlert/uiConfirm/uiPrompt)');
}

// 3. Validasi struktur modular HTML, CSS Blue Navy + Safe-Area + Sidebar, dan App JS
for (const needle of [
  './styles.css',
  './config.js',
  './db.js',
  './sync.js',
  './vendor/qrcode.js',
  './app.js',
  'viewport-fit=cover',
  'appShell',
  'sideNav',
  'dialogModal',
  'loginModal',
  'page-acrylic',
  'templateQrPrint',
  'syncNetBadge',
  'syncQueueBadge',
  'openMoreMenuModal',
]) {
  if (!html.includes(needle)) throw new Error(`Missing markup/reference in public/index.html: ${needle}`);
}

for (const needle of [
  '--navy-900',
  'env(safe-area-inset-top',
  'env(safe-area-inset-bottom',
  '.side-nav',
  '.dialog-modal',
  ':focus-visible',
]) {
  if (!stylesCss.includes(needle)) throw new Error(`Missing style rule in public/styles.css: ${needle}`);
}

for (const needle of [
  'uiAlert',
  'uiConfirm',
  'uiPrompt',
  'handleHardwareBack',
  'openMoreMenuModal',
  'openLoginModal',
  'openServerSettingsModal',
  'exportBackupFile',
  'setupAutoBackupFolder',
  'saveAcrylicStockIn',
  'materializeQrImages',
  'Android.printHtml',
  'slice(0, 5)',
]) {
  if (!appJs.includes(needle)) throw new Error(`Missing application logic in public/app.js: ${needle}`);
}

for (const needle of [
  'indexedDB',
  'outbox',
  'acrylics',
  'acrylicLogs',
  'exportBackupObject',
  'importBackupObject',
  'pickAutoBackupFolder',
  'saveSketchLocal',
]) {
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

// 4. Validasi PC launcher & Android Capacitor Engineering
if (!bat.includes('public\\index.html') || !bat.includes('--user-data-dir')) {
  throw new Error('Jalankan.bat missing local public\\index.html or --user-data-dir');
}
const cap = JSON.parse(capConfig);
if (cap.webDir !== 'public') throw new Error('capacitor.config.json webDir must be "public"');
if (gradleProps.includes('APP_URL') || appGradle.includes('APP_URL')) {
  throw new Error('Android config still references obsolete APP_URL');
}
if (settingsGradle.includes('FAIL_ON_PROJECT_REPOS')) {
  throw new Error('android/settings.gradle.kts must not use FAIL_ON_PROJECT_REPOS (breaks :capacitor-android)');
}
for (const needle of ['capacitor.settings.gradle', 'PREFER_PROJECT']) {
  if (!settingsGradle.includes(needle)) throw new Error(`Missing setting in android/settings.gradle.kts: ${needle}`);
}
for (const needle of ['capacitor.build.gradle', 'proguard-rules.pro']) {
  if (!appGradle.includes(needle)) throw new Error(`Missing build config in android/app/build.gradle.kts: ${needle}`);
}
for (const needle of ['@mipmap/ic_launcher', '@mipmap/ic_launcher_round', 'android.hardware.camera']) {
  if (!manifestXml.includes(needle)) throw new Error(`Missing manifest entry in AndroidManifest.xml: ${needle}`);
}
if (!proguardRules.includes('JavascriptInterface')) {
  throw new Error('proguard-rules.pro must preserve @JavascriptInterface methods');
}
for (const needle of [
  'BridgeActivity',
  'setOnApplyWindowInsetsListener',
  'OnBackPressedCallback',
  'RequestPermission',
  'cleanupPrintWebView',
  'fun shareQRText(',
  'fun printHtml(',
  'buildPrintAttributes',
  'onShowFileChooser',
  'fun saveSketchFile(',
  'fun readSketchFile(',
]) {
  if (!mainKt.includes(needle)) throw new Error(`Missing Android engineering feature in MainActivity.kt: ${needle}`);
}

await Promise.all([
  access(rel('android/app/src/main/res/xml/file_paths.xml')),
  access(rel('android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml')),
  access(rel('android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml')),
  access(rel('android/gradlew')),
  access(rel('android/gradlew.bat')),
  access(rel('android/gradle/wrapper/gradle-wrapper.jar')),
]);

console.log(
  'OK: parsed modular public/{config,db,sync,vendor/qrcode,app}.js + Code.gs; verified offline-first PC, Capacitor Android APK engineering, custom Blue Navy dialogs, and desktop/mobile navigation.'
);
