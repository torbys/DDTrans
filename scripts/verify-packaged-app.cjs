const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const executable = process.argv[2] || path.join(root, 'release', 'win-unpacked', 'DDTrans.exe');
const requireVirtualAudio = process.argv.includes('--require-virtual-audio');
const evidence = path.join(root, 'data', 'probes');
fs.mkdirSync(evidence, { recursive: true });
const userData = fs.mkdtempSync(path.join(evidence, 'packaged-user-'));
const environment = { ...process.env, DDTRANS_TEST_USER_DATA: userData };
for (const key of ['DASHSCOPE_API_KEY', 'QWEN_WS_URL', 'DDTRANS_SERVICE_CONFIG', 'DDTRANS_DATA_DIR', 'ELECTRON_RUN_AS_NODE']) delete environment[key];
const child = spawn(executable, ['--inspect=127.0.0.1:0'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', inspector, requestId = 0, socket;
const pending = new Map();
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  output = (output + chunk.toString()).slice(-100_000);
  inspector ||= output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(check, label, timeout = 25_000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) { const result = await check(); if (result) return result; if (child.exitCode !== null) throw new Error(`Packaged app exited (${child.exitCode}) during ${label}: ${output}`); await delay(100); }
  throw new Error('Packaged verification timed out: ' + label);
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const electron = 'process.mainModule.require("electron")';
function pageExpression(page, code) {
  return `(async () => { const window = ${electron}.BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().endsWith(${JSON.stringify('/' + page)})); if (!window) return null; return window.webContents.executeJavaScript(${JSON.stringify(code)}, true); })()`;
}
const report = { checkedAt: new Date().toISOString(), mode: 'packaged-app-no-model-calls', checks: {} };
(async () => {
  try {
    await poll(() => inspector, 'main-process inspector');
    socket = new WebSocket(inspector);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (!message.id) return;
      const waiter = pending.get(message.id); if (!waiter) return;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
    });
    await poll(() => evaluate(pageExpression('home.html', 'Boolean(window.electronAPI && document.readyState === "complete")')), 'packaged home page');
    const appState = await evaluate(`({ packaged: ${electron}.app.isPackaged, userData: ${electron}.app.getPath('userData'), appPath: ${electron}.app.getAppPath() })`);
    assert.equal(appState.packaged, true); assert.equal(path.resolve(appState.userData), path.resolve(userData));
    assert.ok(fs.existsSync(path.join(userData, 'data', 'translation.db')), 'DB is not in writable user data');
    report.checks.packagedStartup = appState;
    const healthBefore = await evaluate(pageExpression('home.html', 'fetch("/api/health").then(response => response.json())'));
    assert.equal(healthBefore.ready, true); assert.equal(healthBefore.active_sessions, 0);
    const originBefore = await evaluate(pageExpression('home.html', 'location.origin'));
    await evaluate(pageExpression('home.html', 'window.electronAPI.openAudioSettings()'));
    await poll(() => evaluate(pageExpression('settings.html', 'Boolean(document.getElementById("connectionSettingsBtn"))')), 'settings connection entry');
    if (requireVirtualAudio) {
      const route = await evaluate(pageExpression('settings.html', `(async () => {
          const permission = await window.electronAPI.mediaCommand('request-audio-permission');
          if (!permission.granted) throw new Error(permission.message);
          const devices = await window.electronAPI.mediaCommand('enumerate-devices');
          const { resolveDDTransVirtualPair } = await import('./js/audio-mix-bus.js');
          const pair = resolveDDTransVirtualPair(devices, await window.electronAPI.getAudioSettings());
          if (!pair.available) throw new Error(pair.message);
          await window.electronAPI.mediaCommand('set-audio-routing', {
            virtualRenderDeviceId: pair.render.deviceId, virtualCaptureDeviceId: pair.capture.deviceId,
            virtualRenderDeviceLabel: pair.render.label, virtualCaptureDeviceLabel: pair.capture.label,
            monitorEnabled: false, virtualOutputEnabled: false,
          });
          const test = await window.electronAPI.mediaCommand('audio-routing-test', { target: 'virtual', verifyCapture: true });
          return { provider: pair.provider, render: pair.render.label, capture: pair.capture.label,
            captureVerified: test.captureVerified, signalAmplitude: test.signalAmplitude };
        })()`));
      assert.equal(route.captureVerified, true);
      report.checks.virtualAudio = route;
    }
    await evaluate(pageExpression('settings.html', 'document.getElementById("connectionSettingsBtn").click(); true'));
    await poll(() => evaluate(pageExpression('connection.html', 'Boolean(window.electronAPI && document.getElementById("endpoint")?.value)')), 'connection form');
    const initial = await evaluate(pageExpression('connection.html', 'window.electronAPI.getConnectionSettings()'));
    assert.equal(initial.hasKey, false); assert.equal(Object.hasOwn(initial, 'apiKey'), false);
    const nextEndpoint = 'wss://packaged-probe.invalid/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime';
    const fakeKey = 'ddtrans-packaged-probe-not-a-real-api-key';
    const saved = await evaluate(pageExpression('connection.html', `window.electronAPI.saveConnectionSettings(${JSON.stringify({ endpoint: nextEndpoint, apiKey: fakeKey })})`));
    assert.equal(saved.hasKey, true); assert.equal(saved.endpoint, nextEndpoint); assert.equal(Object.hasOwn(saved, 'apiKey'), false);
    const profileText = fs.readFileSync(path.join(userData, 'connection-settings.json'), 'utf8');
    assert.ok(!profileText.includes(fakeKey), 'Plaintext key persisted'); assert.ok(JSON.parse(profileText).encryptedApiKey);
    const retained = await evaluate(pageExpression('connection.html', `window.electronAPI.saveConnectionSettings(${JSON.stringify({ endpoint: nextEndpoint, apiKey: '' })})`));
    assert.equal(retained.hasKey, true);
    assert.equal(await evaluate(pageExpression('home.html', 'location.origin')), originBefore);
    const healthAfter = await evaluate(pageExpression('home.html', 'fetch("/api/health").then(response => response.json())'));
    assert.equal(healthAfter.active_sessions, 0);
    report.checks.encryptedConnectionUpdate = { saved: true, plaintextOnDisk: false, keyExposedToPage: false, blankPreserved: true, originUnchanged: true, activeSessions: 0 };
    await evaluate(pageExpression('connection.html', 'location.reload(); true'));
    await poll(() => evaluate(pageExpression('connection.html', `document.getElementById('endpoint')?.value === ${JSON.stringify(nextEndpoint)}`)), 'saved connection refresh');
    const screenshot = path.join(root, 'docs', 'images', 'connection-settings-2026-10-30.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await evaluate(`(async () => { const window = ${electron}.BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/connection.html')); process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(screenshot)}, (await window.webContents.capturePage()).toPNG()); return true; })()`);
    report.checks.connectionScreenshot = path.relative(root, screenshot);
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error.stack || error.message; process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(evidence, 'packaged-app.json'), JSON.stringify(report, null, 2));
    if (socket?.readyState === WebSocket.OPEN) {
      try { await evaluate(`setTimeout(() => ${electron}.app.quit(), 50); true`); } catch (_) {}
      socket.close();
    }
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Inspector closed')); }
    pending.clear();
    const until = Date.now() + 10_000;
    while (child.exitCode === null && Date.now() < until) await delay(100);
    if (child.exitCode === null) child.kill();
    console.log(JSON.stringify(report, null, 2));
  }
})();
