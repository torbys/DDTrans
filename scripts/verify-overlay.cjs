const { app, BrowserWindow, utilityProcess, clipboard, ClipboardItem, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readPcm16 } = require('./probe-realtime.cjs');
const live = process.env.DDTRANS_VERIFY_LIVE === '1';
const probeDir = path.resolve(__dirname, '../data/probes');
const dataDir = path.join(probeDir, live ? 'overlay-live-data' : 'overlay-test-data');
process.env.SERVER_PORT = '0';
process.env.DDTRANS_DATA_DIR = dataDir;
process.env.DDTRANS_TEST_USER_DATA = path.join(probeDir, live ? 'overlay-live-user' : 'overlay-test-user');
fs.mkdirSync(process.env.DDTRANS_TEST_USER_DATA, { recursive: true });
const gateways = [], errors = [], result = { mode: live ? 'real-qwen3.8' : 'fake-gateway', checks: {} };
let host, home, backend, started = false, verified = false, captureCounts = { started: 0, stopped: 0 };
let injected = Promise.resolve();
const copyRequests = [];
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, channel === 'copy-text' ? ((event, text) => { copyRequests.push(text); return listener(event,text); }) : listener);

function emitPair(onEvent, index, text, language = 'en') {
  const source = 'source-' + index, target = 'target-' + index, response = 'response-' + index;
  onEvent({ type: 'input_audio_buffer.speech_started', item_id: source, audio_start_ms: index * 200, speaker_id: index % 2 });
  onEvent({ type: 'response.output_item.added', response_id: response, item: { id: target } });
  onEvent({ type: 'conversation.item.created', previous_item_id: source, item: { id: target, type: 'message' } });
  onEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: source, transcript: text || '这是第' + index + '句原文。' });
  onEvent({ type: 'response.audio_transcript.done', response_id: response, item_id: target, transcript: language + ': translation ' + index });
  const pcm = Buffer.alloc(4800); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 24000) * 600), i * 2);
  onEvent({ type: 'response.audio.delta', response_id: response, item_id: target, delta: pcm.toString('base64') });
  onEvent({ type: 'response.audio.done', response_id: response, item_id: target });
  onEvent({ type: 'response.done', response: { id: response, status: 'completed', output: [{ id: target, content: [{ type: 'audio', transcript: language + ': translation ' + index }] }] } });
}
if (!live) {
  utilityProcess.fork = () => {
    const child = new EventEmitter(); child.pid = process.pid;
    child.postMessage = async message => { if (message.type === 'shutdown') { await backend?.close(); child.emit('message', { type: 'stopped' }); } };
    child.kill = () => { child.pid = null; child.emit('exit', 0); };
    void require('../electron/service.js').startService({ root: path.resolve(__dirname, '..'), dataDir, port: 0, model: 'qwen3.8-livetranslate-flash-realtime', endpoint: 'wss://test', apiKey: 'test' }, {
      gatewayFactory: ({ onEvent }) => {
        let samples = 0, count = 0, language = 'en';
        const gateway = { metrics: { connect_ms: 1 }, async connect(config) { language = config.translation.language; return { model: 'qwen3.8-livetranslate-flash-realtime', ...config }; },
          sendAudio(bytes) { samples += bytes.length / 2; if (samples >= (count + 1) * 3200 && count < 20) emitPair(onEvent, ++count, null, language); },
          async finish() { await new Promise(resolve => setTimeout(resolve, 150)); emitPair(onEvent, ++count, '退出前的最后一句。', language); onEvent({ type: 'session.finished' }); }, close() {},
        }; gateways.push(gateway); return gateway;
      },
    }).then(service => { backend = service; child.emit('message', { type: 'ready', origin: service.origin }); }).catch(error => child.emit('message', { type: 'error', message: error.message }));
    return child;
  };
}

async function injectFixture(window) {
  const pcm = live ? readPcm16(path.resolve(process.argv[2] || path.join(probeDir, 'fixtures/two-speakers-16k.pcm'))).toString('base64') : '';
  await window.webContents.executeJavaScript('(' + (function (base64) {
    const samples = base64 ? new Int16Array(Uint8Array.from(atob(base64), char => char.charCodeAt(0)).buffer) : null;
    const verification = window.__overlayVerification = { capturesStarted: 0, capturesStopped: 0, frames: 0, position: 0, pendingSources: [], active: [], errors: [] };
    window.addEventListener('error', event => verification.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => verification.errors.push(String(event.reason)));
    async function stream() {
      const context = new AudioContext({ sampleRate: 16000 }); await context.resume();
      const destination = context.createMediaStreamDestination();
      const source = samples ? context.createBufferSource() : context.createOscillator();
      if (samples) {
        const buffer = context.createBuffer(1, samples.length, 16000);
        const channel = buffer.getChannelData(0); for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
        source.buffer = buffer;
      } else source.frequency.value = 220;
      source.connect(destination);
      let startedAt = null, stopped = false;
      const item = { start() { if (startedAt !== null || stopped) return; startedAt = context.currentTime; source.start(0, samples ? Math.min(verification.position, source.buffer.duration) : undefined); }, context };
      verification.pendingSources.push(item); verification.active.push(item); verification.capturesStarted++;
      const track = destination.stream.getAudioTracks()[0], originalStop = track.stop.bind(track);
      track.getSettings = () => ({ restrictOwnAudio: true });
      track.stop = () => {
        if (stopped) return; stopped = true;
        if (samples && startedAt !== null) verification.position += context.currentTime - startedAt;
        originalStop(); source.disconnect(); void context.close(); verification.capturesStopped++;
        console.log('DDTRANS_CAPTURE_COUNTS ' + JSON.stringify({ started: verification.capturesStarted, stopped: verification.capturesStopped }));
      };
      return destination.stream;
    }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: stream });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: stream });
    const NativeSocket = WebSocket;
    window.WebSocket = function (...args) {
      const socket = new NativeSocket(...args);
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'ready' || message.type === 'state' && message.state === 'running') verification.pendingSources.splice(0).forEach(item => item.start());
      });
      const nativeSend = socket.send.bind(socket);
      socket.send = data => { if (data instanceof ArrayBuffer) verification.frames++; return nativeSend(data); };
      return socket;
    };
  }).toString() + ')(' + JSON.stringify(pcm) + ')', true);
}

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', details => {
    const message = details.message || '';
    if (message.startsWith('DDTRANS_CAPTURE_COUNTS ')) captureCounts = JSON.parse(message.slice(23));
    if (details.level === 'error' || details.level === 3) errors.push(message);
  });
  window.webContents.once('did-finish-load', () => {
    const page = new URL(window.webContents.getURL()).pathname;
    if (page === '/media-host.html') { host = window; window.webContents.setAudioMuted(true); injected = injectFixture(window); }
    if (page === '/home.html' && !started) {
      started = true; home = window;
      void verify().catch(async error => { console.error(error); console.error('CHECKS_COMPLETED',result.checks); console.error(errors); const visible = overlay() || home; if(visible && !visible.isDestroyed()) { console.error('WINDOW_BOUNDS',visible.getBounds());console.error('MEDIA_STATE', await snapshot(visible).catch(error=>({error:error.message}))); } if(host && !host.isDestroyed()) console.error('HOST_STATE', await ui(host, '({frames:__overlayVerification.frames,captures:__overlayVerification.capturesStarted,stopped:__overlayVerification.capturesStopped,contexts:__overlayVerification.active.map(item=>({state:item.context.state,time:item.context.currentTime})),errors:__overlayVerification.errors})')); process.exitCode = 1; app.quit(); });
    }
  });
});
async function poll(check, timeout = 12000, label = 'condition') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error('Timed out: ' + label);
}
const ui = (window, code) => window.webContents.executeJavaScript(code, true);
const snapshot = window => ui(window, 'window.electronAPI.getMediaSnapshot()');
const media = (window, command, payload = {}) => ui(window, 'window.electronAPI.mediaCommand(' + JSON.stringify(command) + ',' + JSON.stringify(payload) + ')');
const overlay = () => BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().endsWith('/overlay.html'));

async function clickButton(window, id) {
  window.show();
  window.focus();
  await poll(() => window.isFocused(), 5000, id + ' window focused');
  await ui(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const point = await poll(() => ui(window, '(' + (function (buttonId) {
    const button = document.getElementById(buttonId);
    if (!button || button.disabled) return false;
    const rect = button.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    return rect.width > 0 && rect.height > 0 && button.contains(hit) && { x, y };
  }).toString() + ')(' + JSON.stringify(id) + ')'), 5000, id + ' enabled and visible');
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
}

async function verify() {
  await injected;
  assert.ok(await ui(home, 'Boolean(document.getElementById("openOverlayBtn"))'));
  const origin = new URL(home.webContents.getURL()).origin;
  result.origin = origin;
  await home.loadURL(origin + '/index.html?name=Overlay%20lifecycle&targetLang=en');
  await ui(home, 'document.getElementById("hotwordBtn").click();const fields=document.querySelectorAll(".hotword-row input");fields[0].value="七牛灵矽";fields[1].value="Qiniu Xrobot";document.getElementById("hotwordConfirm").click();if(document.getElementById("aiVoiceBtn").getAttribute("aria-pressed")!=="true")document.getElementById("aiVoiceBtn").click();document.getElementById("startBtn").click()');
  const running = await poll(async () => { const current = await snapshot(home); if (current.phase === 'failed') throw new Error(current.feedback.message); return current.phase === 'running' && current; }, 30000, 'model running');
  result.initialSessionId = running.sessionId;
  await ui(home, 'document.querySelector(".notes-textarea").value="悬浮窗生命周期验证";import("/js/translation.js").then(module=>module.flushNote())');
  const first = await poll(async () => { const current = await snapshot(home); return current.segments.some(segment => segment.target_text) && current; }, live ? 40000 : 12000, 'first translation');
  result.checks.received_translation = first.segments.length;
  const hostId = host.id;
  const framesBefore = await ui(host, 'window.__overlayVerification.frames');
  await ui(home, 'document.getElementById("overlayBtn").click()');
  let floating = await poll(overlay, 15000, 'overlay created');
  await poll(() => ui(floating, 'Boolean(document.getElementById("captureBtn") && ["采集中","正在采集"].includes(document.getElementById("sessionState").textContent))'), 12000, 'overlay loaded');
  await ui(floating, 'window.electronAPI.updateOverlayPreferences({subtitlesVisible:true})');
  assert.equal(home.isDestroyed(), true); assert.equal(host.isDestroyed(), false); assert.equal(host.id, hostId);
  assert.equal((await snapshot(floating)).sessionId, running.sessionId);
  await poll(async () => await ui(host, 'window.__overlayVerification.frames') > framesBefore + 10);
  result.checks.main_destroyed_media_continues = true;
  assert.equal(floating.isAlwaysOnTop(), true);
  await media(floating, 'set-volume', { volume: 0.24 });
  await ui(floating, 'document.getElementById("ttsToggle").click()');
  await poll(async () => (await snapshot(floating)).ttsEnabled === false);
  assert.equal((await snapshot(floating)).phase, 'running');
  await ui(floating, 'document.getElementById("ttsToggle").click()');
  await poll(async () => (await snapshot(floating)).ttsEnabled === true);
  result.checks.tts_independent = true;
  floating.setPosition(110, 130);
  await ui(floating, 'window.electronAPI.setOverlayMode("ball")');
  await poll(() => Math.abs(floating.getBounds().width - 72) <= 2, 4000, 'ball bounds ' + JSON.stringify(floating.getBounds()));
  const ballBefore = await ui(host, 'window.__overlayVerification.frames');
  await poll(async () => await ui(host, 'window.__overlayVerification.frames') > ballBefore + 10);
  assert.equal((await snapshot(floating)).sessionId, running.sessionId);
  await ui(floating, 'window.electronAPI.moveOverlay({deltaX:30,deltaY:-20})');
  const ballPosition = floating.getPosition();
  const ballImage = await floating.webContents.capturePage();
  fs.mkdirSync(path.resolve(__dirname, '../docs/images'), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, '../docs/images/overlay-ball.png'), ballImage.toPNG());
  floating.webContents.sendInputEvent({ type: 'mouseDown', x: 36, y: 36, button: 'left', clickCount: 1 });
  floating.webContents.sendInputEvent({ type: 'mouseUp', x: 36, y: 36, button: 'left', clickCount: 1 });
  await poll(() => Math.abs(floating.getBounds().width - 680) <= 2, 10000, 'ball restores standard window');
  assert.deepEqual(floating.getPosition(), [110, 130]);
  await ui(floating, 'window.electronAPI.setOverlayMode("ball")');
  assert.deepEqual(floating.getPosition(), ballPosition);
  await ui(floating, 'window.electronAPI.setOverlayMode("standard")');
  result.checks.ball_continues_same_session = true; result.checks.separate_positions_remembered = true;
  await ui(floating, 'document.getElementById("hideSubtitlesBtn").click()');
  await poll(() => Math.abs(floating.getBounds().height - 190) <= 2, 10000, 'audio-only compact window');
  assert.equal((await snapshot(floating)).phase, 'running');
  await poll(() => ui(floating, 'innerHeight <= 194 && document.getElementById("overlayShell").classList.contains("subtitles-hidden")'), 3000, 'compact renderer layout');
  result.checks.audio_only_layout = await ui(floating, '({documentHeight:document.documentElement.scrollHeight,windowHeight:innerHeight,exitVisible:document.getElementById("exitBtn").getBoundingClientRect().bottom <= innerHeight})');
  assert.equal(result.checks.audio_only_layout.exitVisible, true);
  result.checks.audio_only_controls_fit = await ui(floating, '([...document.querySelectorAll(".control-deck button,.control-deck select,.control-deck input,.overlay-footer")].every(node=>{const r=node.getBoundingClientRect();return r.bottom<=innerHeight && r.right<=innerWidth && r.left>=0}))');
  assert.equal(result.checks.audio_only_controls_fit,true);
  fs.writeFileSync(path.resolve(__dirname, '../docs/images/overlay-audio-only.png'),(await floating.webContents.capturePage()).toPNG());
  await ui(floating, 'document.getElementById("hideSubtitlesBtn").click()');
  await poll(() => Math.abs(floating.getBounds().height - 560) <= 2);
  if (live) {
    const duration = readPcm16(path.resolve(process.argv[2] || path.join(probeDir, 'fixtures/two-speakers-16k.pcm'))).length / 32;
    const startTime = Date.now();
    await poll(async () => await ui(host, 'window.__overlayVerification.active.at(-1).context.currentTime*1000') > duration + 300, duration + 5000, 'complete live fixture');
    result.live_fixture_wait_ms = Date.now() - startTime;
  } else await poll(async () => (await snapshot(floating)).segments.length >= 6);
  assert.ok(await ui(floating, 'document.querySelectorAll(".subtitle-segment").length <= 4'));
  const rectangle = await ui(floating, '(()=>{const node=document.querySelector(".subtitle-segment:last-child");const r=node.getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+20)}})()');
  floating.focus();floating.webContents.sendInputEvent({ type:'mouseMove', ...rectangle });
  const screenshot = await floating.webContents.capturePage();
  fs.writeFileSync(path.resolve(__dirname, '../docs/images/overlay-standard' + (live ? '-live' : '') + '.png'), screenshot.toPNG());
  const savedClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  await clipboard.writeText('DDTrans clipboard control');
  result.clipboard_available = (await clipboard.readText()) === 'DDTrans clipboard control';
  await clipboard.writeText('');
  try {
  floating.webContents.sendInputEvent({ type: 'mouseDown', ...rectangle, button: 'left', clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 720));
  floating.webContents.sendInputEvent({ type: 'mouseUp', ...rectangle, button: 'left', clickCount: 1 });
  await poll(() => copyRequests.some(text => text.includes(String.fromCharCode(10))), 3000, 'long press sends source and target');
  if(result.clipboard_available) await poll(async () => (await clipboard.readText()).includes(String.fromCharCode(10)),3000,'system clipboard readback');
  else { await poll(() => ui(floating, 'document.getElementById("feedbackToast").textContent.includes("系统剪贴板未接受写入")')); result.checks.clipboard_failure_reported = true; }
  } finally { if (savedClipboard.length) await clipboard.write(savedClipboard); else await clipboard.clear(); }
  result.checks.caption_pairs_and_long_press_dispatch = true;
  result.checks.complete_caption_pairs_visible = await ui(floating, '(()=>{const area=document.getElementById("subtitleArea").getBoundingClientRect();return [...document.querySelectorAll(".subtitle-segment:not([hidden])")].every(node=>{const r=node.getBoundingClientRect();return r.top>=area.top && r.bottom<=area.bottom})})()');
  assert.equal(result.checks.complete_caption_pairs_visible,true);
  await ui(floating, 'document.getElementById("captureBtn").click()');
  await poll(async () => (await snapshot(floating)).phase === 'paused');
  const paused = await ui(host, '({started:window.__overlayVerification.capturesStarted,stopped:window.__overlayVerification.capturesStopped})');
  assert.equal(paused.started, paused.stopped);
  await ui(floating, 'document.getElementById("captureBtn").click()');
  await poll(async () => (await snapshot(floating)).phase === 'running');
  assert.equal((await snapshot(floating)).sessionId, running.sessionId);
  result.checks.capture_switch_releases_tracks = true;
  if (!live) {
    await ui(floating, 'document.getElementById("targetLanguage").value="ja";document.getElementById("targetLanguage").dispatchEvent(new Event("change"))');
    const changed = await poll(async () => { const current = await snapshot(floating); return current.config.targetLanguage === 'ja' && current.phase === 'running' && current; });
    assert.notEqual(changed.sessionId, running.sessionId); result.nextSessionId = changed.sessionId;
    result.checks.target_switch_saves_and_restarts = true;
  }
  const current = await snapshot(floating);
  await ui(floating, 'document.getElementById("originalGain").value="37";document.getElementById("originalGain").dispatchEvent(new Event("input"));document.getElementById("ttsVolume").value="41";document.getElementById("ttsVolume").dispatchEvent(new Event("input"));document.getElementById("returnBtn").click()');
  const restoredAfterButton = await poll(() => BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && /\/index\.html/.test(window.webContents.getURL())), 15000, 'main restored from return button');
  await poll(() => !restoredAfterButton.webContents.isLoadingMainFrame(), 12000, 'restored main loaded');
  home = restoredAfterButton;
  await poll(async () => (await snapshot(home)).phase === 'running', 12000, 'restored main session');
  assert.equal((await snapshot(home)).sessionId, current.sessionId);
  await poll(() => !overlay(), 5000, 'overlay closed after return button');
  result.checks.return_button_restores_main_and_keeps_session = true;
  const savedAudio = await ui(home, 'window.electronAPI.getAudioSettings()');
  assert.equal(savedAudio.originalGain, 0.37); assert.equal(savedAudio.ttsVolume, 0.41);
  assert.equal((await snapshot(home)).ttsVolume, 0.41);
  result.checks.quick_return_saves_audio_gains = true;
  await clickButton(home, 'overlayBtn');
  floating = await poll(overlay, 15000, 'overlay reopened after return');
  await poll(() => ui(floating, 'Boolean(document.getElementById("returnBtn"))'), 12000, 'reopened overlay loaded');
  floating.close();
  const restoredAfterClose = await poll(() => BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.id !== home.id && /\/index\.html/.test(window.webContents.getURL())), 15000, 'main restored from window close');
  await poll(() => !restoredAfterClose.webContents.isLoadingMainFrame(), 12000, 'restored main loaded after close');
  home = restoredAfterClose;
  await poll(async () => (await snapshot(home)).phase === 'running', 12000, 'session survives window close');
  assert.equal((await snapshot(home)).sessionId, current.sessionId);
  await poll(() => !overlay(), 5000, 'overlay closed after window close');
  result.checks.window_close_returns_to_main = true;
  result.checks.close_during_enter_returns_new_main = true;
  await clickButton(home, 'overlayBtn');
  floating = await poll(overlay, 15000, 'overlay reopened for exit');
  await poll(() => ui(floating, 'Boolean(document.getElementById("exitBtn"))'), 12000, 'exit overlay loaded');
  result.finalSessionId = current.sessionId;
  result.beforeExit = { phase: current.phase, segments: current.segments.length, ttsVolume: current.ttsVolume };
  result.host_errors = await ui(host, 'window.__overlayVerification.errors');
  assert.deepEqual(result.host_errors, []); assert.deepEqual(errors, []);
  verified = true;
  await ui(floating, 'document.getElementById("exitBtn").click()');
}
app.on('will-quit', event => {
  try {
    assert.ok(verified, 'verification did not finish');
    assert.equal(captureCounts.started, captureCounts.stopped, 'active capture survived stop');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'translation.db'), { readOnly: true });
    const row = db.prepare('SELECT status FROM sessions WHERE id=?').get(result.finalSessionId);
    assert.equal(row.status, 'completed');
    const tail = db.prepare('SELECT source_text,target_text,status FROM segments WHERE session_id=? ORDER BY sequence_order DESC LIMIT 1').get(result.finalSessionId);
    assert.equal(tail.status, 'final');
    if (!live) assert.equal(tail.source_text, '退出前的最后一句。');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE status IN ('running','paused','stopping')").get().n, 0);
    const savedNotes = db.prepare('SELECT content FROM notes WHERE session_id=?').all(result.initialSessionId);
    assert.ok(savedNotes.some(row => row.content === '悬浮窗生命周期验证'));
    result.checks.notes_persisted = true;
    if (live) {
      const rows=db.prepare('SELECT speaker_id,target_text,status,tts_audio_path FROM segments WHERE session_id=? ORDER BY sequence_order').all(result.finalSessionId);
      assert.ok(new Set(rows.map(row=>row.speaker_id).filter(Boolean)).size >= 2);
      assert.ok(rows.some(row=>row.target_text.includes('Qiniu Xrobot')));
      assert.ok(rows.at(-1).target_text.includes('Thank you'));
      assert.ok(rows.every(row=>row.status==='final' && row.tts_audio_path));
      result.checks.real_model_speakers_hotwords_and_tail = true;
      result.modelSegments = rows.length;
    }
    db.close();
    result.checks.exit_saved_tail_and_released_all = true;
    result.captureCounts = captureCounts; result.finalTail = tail; result.console_errors = errors;
    fs.writeFileSync(path.join(probeDir, live ? 'overlay-live.json' : 'overlay-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error); event.preventDefault(); app.exit(1); }
});
setTimeout(() => { if (!verified) { console.error('overlay verification timeout', errors); process.exitCode = 1; app.quit(); } }, live ? 100000 : 55000).unref();
require('../electron/main.js');
