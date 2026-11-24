import { readFile, writeFile, unlink } from 'node:fs/promises';
import vm from 'node:vm';
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(s => s.trim());
if (!scripts.length) throw new Error('No inline application scripts found');
for (const [i, script] of scripts.entries()) new vm.Script(script, { filename: `inline-${i + 1}.js` });
const gas = await readFile(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
new vm.Script(gas, { filename: 'Code.gs' });
for (const text of [html, gas]) {
  if (/const SPREADSHEET_ID\s*=\s*['"][A-Za-z0-9_-]{20,}['"]/.test(text)) throw new Error('Found hard-coded spreadsheet ID');
}
for (const needle of ['opensheet.elk.sh', 'MAX_SKETCH_BYTES = 1024 * 1024', 'DRIVE_FILE:', 'templateQrPrint', 'slice(0, 5)', 'requireSession_', 'createPasswordHash_']) {
  if (!(html + gas).includes(needle)) throw new Error(`Missing requirement check: ${needle}`);
}
if (!gas.includes('function verifyPassword_(')) throw new Error('Missing Apps Script password verification helper');
if (html.includes('encodeURIComponent(tab)}?v=')) throw new Error('OpenSheet URL has an unsupported cache-buster query');
console.log(`OK: parsed ${scripts.length} inline scripts and Apps Script; required features present.`);
