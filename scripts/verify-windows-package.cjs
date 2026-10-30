const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const unpacked = path.join(root, 'release', 'win-unpacked');
const resources = path.join(unpacked, 'resources');
const appAsar = path.join(resources, 'app.asar');
const payload = path.join(resources, 'virtual-audio');
const requiredPayloadEntries = [
  'ddtrans-audio-device.exe',
  'ddtrans-audio-probe.exe',
  'vendor',
  'VBCABLE_Driver_Pack45.zip',
  'THIRD-PARTY-NOTICES.txt',
  'vendor-license.html',
  'manifest.json',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

assert.ok(fs.existsSync(appAsar), `Missing unpacked application archive: ${appAsar}`);
assert.ok(fs.existsSync(payload), `Missing bundled virtual-audio payload: ${payload}`);

const entries = asar.listPackage(appAsar)
  .map(entry => entry.replaceAll('\\', '/').replace(/^\/+/, ''));
for (const expected of ['app/index.html', 'electron/main.js', 'package.json', 'node_modules/ws/package.json', 'app/vendor/remixicon/remixicon.css', 'app/vendor/remixicon/remixicon.woff2', 'app/vendor/remixicon/LICENSE', 'resources/icons/千问logo.png', 'resources/icons/logo.png', 'resources/icons/bg.jpg']) {
  assert.ok(entries.includes(expected), `Missing packaged application file: ${expected}`);
}
for (const entry of entries) {
  assert.ok(!/^(data|native|logs|scripts|tests)\//.test(entry), `Excluded source path is packaged: ${entry}`);
  assert.ok(!/(^|\/)\.env(?:\.|\/|$)/i.test(entry), `Environment file is packaged: ${entry}`);
  assert.ok(!/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)|\.(pem|key|pfx|p12)$/i.test(entry), `Private key is packaged: ${entry}`);
  if (entry.startsWith('node_modules/')) {
    assert.ok(entry === 'node_modules' || entry === 'node_modules/ws' || entry.startsWith('node_modules/ws/'), `Non-production dependency is packaged: ${entry}`);
  }
}

for (const entry of requiredPayloadEntries) {
  assert.ok(fs.existsSync(path.join(payload, entry)), `Missing payload entry: ${entry}`);
}

const notices = fs.readFileSync(path.join(payload, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
assert.match(notices, /VB-Audio Software/);
assert.match(notices, /[\u4e00-\u9fff]/, 'Third-party notice must include Chinese information');

const upstreamCheck = spawnSync('pwsh.exe', ['-NoProfile', '-File', path.join(root, 'scripts', 'verify-virtual-audio-payload.ps1'), '-PayloadDirectory', payload], { stdio: 'inherit', shell: false });
if (upstreamCheck.error) throw upstreamCheck.error;
assert.equal(upstreamCheck.status, 0, 'Bundled vendor files differ from the original signed package');

const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'manifest.json'), 'utf8'));
assert.equal(manifest.provider, 'VB-Audio Software');
assert.equal(sha256(path.join(payload, 'VBCABLE_Driver_Pack45.zip')), manifest.archiveSha256.toUpperCase(), 'Bundled original ZIP hash does not match manifest');

for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
  const file = path.join(payload, ...relativePath.split('/'));
  assert.ok(fs.existsSync(file), `Manifest file is missing from payload: ${relativePath}`);
  assert.equal(sha256(file), expectedHash.toUpperCase(), `Payload hash mismatch: ${relativePath}`);
}

for (const vendorFile of filesUnder(path.join(payload, 'vendor'))) {
  const relativePath = path.relative(payload, vendorFile).replaceAll(path.sep, '/');
  assert.ok(manifest.files[relativePath], `Vendor file is not covered by manifest: ${relativePath}`);
}

for (const file of filesUnder(payload)) {
  assert.ok(!file.endsWith('.obj'), `Object file was bundled: ${file}`);
  assert.notEqual(path.basename(file), 'vendor-pins.h', `Build-only pin header was bundled: ${file}`);
}

console.log(`Verified packaged DDTrans application and ${Object.keys(manifest.files).length} signed virtual-audio payload files.`);
