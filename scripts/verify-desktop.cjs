const { app, BrowserWindow, utilityProcess } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const probeDir = path.join(root, 'data', 'probes');
process.env.SERVER_PORT = '0';
process.env.DDTRANS_DATA_DIR = path.join(probeDir, 'desktop-test-data');
process.env.DDTRANS_TEST_USER_DATA = path.join(probeDir, 'desktop-test-user');
fs.mkdirSync(process.env.DDTRANS_TEST_USER_DATA, { recursive: true });
const report = { mode: 'fake-gateway', checks: {} }, errors = [];
let backend, host, injection = Promise.resolve(), started = false, verified = false;
function emitSegment(onEvent, index, tail = false) {
    const source = 'desktop-source-' + index, target = 'desktop-target-' + index, response = 'desktop-response-' + index;
    onEvent({ type: 'input_audio_buffer.speech_started', item_id: source, audio_start_ms: index * 200, speaker_id: index % 2 });
    onEvent({ type: 'response.output_item.added', response_id: response, item: { id: target } });
    onEvent({ type: 'conversation.item.created', previous_item_id: source, item: { id: target, type: 'message' } });
    onEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: source, transcript: tail ? '停止前的最后一句。' : '桌面验证原文' + index });
    onEvent({ type: 'response.audio_transcript.done', response_id: response, item_id: target, transcript: tail ? 'The final desktop sentence.' : 'Desktop translation ' + index });
    onEvent({ type: 'response.audio.delta', response_id: response, item_id: target, delta: Buffer.alloc(4800).toString('base64') });
    onEvent({ type: 'response.audio.done', response_id: response, item_id: target });
    onEvent({ type: 'response.done', response: { id: response, status: 'completed', output: [{ id: target, content: [] }] } });
}
utilityProcess.fork = () => {
    const child = new EventEmitter(); child.pid = process.pid;
    child.postMessage = async message => { if (message.type === 'shutdown') { await backend?.close(); child.emit('message', { type: 'stopped' }); } };
    child.kill = () => { child.pid = null; child.emit('exit', 0); };
    void require('../electron/service.js').startService({ root, dataDir: process.env.DDTRANS_DATA_DIR, port: 0, model: 'qwen3.8-livetranslate-flash-realtime', endpoint: 'wss://test', apiKey: 'test' }, {
        gatewayFactory: ({ onEvent }) => {
            let samples = 0, count = 0;
            return { metrics: { connect_ms: 1 }, async connect(config) { return { ...config, model: 'qwen3.8-livetranslate-flash-realtime' }; },
                sendAudio(bytes) { samples += bytes.length / 2; if (samples >= (count + 1) * 3200 && count < 6) emitSegment(onEvent, ++count); },
                async finish() { emitSegment(onEvent, ++count, true); onEvent({ type: 'session.finished' }); }, close() {} };
        },
    }).then(service => { backend = service; child.emit('message', { type: 'ready', origin: service.origin }); }).catch(error => child.emit('message', { type: 'error', message: error.message }));
    return child;
};
const ui = (window, code) => window.webContents.executeJavaScript(code, true);
async function poll(check, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
    throw new Error('Desktop verification timed out: ' + label);
}
app.on('browser-window-created', (_event, window) => {
    window.webContents.on('console-message', details => { if (details.level === 'error' || details.level === 3) errors.push(details.message); });
    window.webContents.once('did-finish-load', () => {
        const pathname = new URL(window.webContents.getURL()).pathname;
        if (pathname === '/media-host.html') {
            host = window; window.webContents.setAudioMuted(true);
            injection = ui(host, '(' + (function () {
                const counts = window.__desktopTest = { started: 0, stopped: 0, errors: [] };
                window.addEventListener('error', event => counts.errors.push(event.message));
                window.addEventListener('unhandledrejection', event => counts.errors.push(String(event.reason)));
                async function capture() {
                    const context = new AudioContext({ sampleRate: 16000, sinkId: { type: 'none' } }); await context.resume();
                    const destination = context.createMediaStreamDestination(), oscillator = context.createOscillator();
                    oscillator.connect(destination); oscillator.start(); counts.started++;
                    const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track); let stopped = false;
                    track.getSettings = () => ({ restrictOwnAudio: true });
                    track.stop = () => { if (stopped) return; stopped = true; stop(); oscillator.stop(); oscillator.disconnect(); void context.close(); counts.stopped++; };
                    return destination.stream;
                }
                Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: capture });
                Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: capture });
            }).toString() + ')()');
        }
        if (pathname === '/home.html' && !started) { started = true; void verify(window).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; app.quit(); }); }
    });
});
async function verify(window) {
    await poll(() => host, 'media host ready'); await injection;
    await poll(() => window.isVisible(), 'main window visible');
    await ui(window, 'document.getElementById("createMeetingCard").click();document.getElementById("meetingNameInput").value="Desktop milestone verification";document.getElementById("modalTargetLanguage").value="en";document.getElementById("modalTargetLanguage").dispatchEvent(new Event("change"))');
    const creation = await ui(window, '({source:!!document.getElementById("modalSourceLangDropdown"),swap:!!document.getElementById("modalLangSwapBtn"),target:document.getElementById("modalTargetLanguage").value})');
    assert.deepEqual(creation, { source: false, swap: false, target: 'en' });
    await ui(window, 'Promise.all(document.getAnimations().map(animation=>animation.finished))');
    await ui(window, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(probeDir, 'creation-ui.png'), (await window.webContents.capturePage()).toPNG());
    await ui(window, 'document.getElementById("modalConfirm").click()');
    await poll(() => !window.webContents.isLoadingMainFrame() && window.webContents.getURL().includes('/index.html'), 'meeting page');
    await poll(() => ui(window, 'Boolean(document.getElementById("startBtn"))'), 'start control');
    const snapshot = () => ui(window, 'window.electronAPI.getMediaSnapshot()');
    const visual = await ui(window, '(async()=>{await document.fonts.ready; return {images:[...document.images].every(image=>image.complete&&image.naturalWidth>0),font:document.fonts.check("20px remixicon"),target:document.getElementById("targetLanguageSelect").value,source:!!document.getElementById("sourceLangDropdown"),hint:document.getElementById("sessionStatusRow").hidden,icons:[...document.querySelectorAll("#settingsBtn i,#overlayBtn i")].map(icon=>getComputedStyle(icon,"::before").content)}})()');
    assert.equal(visual.images, true); assert.equal(visual.font, true); assert.equal(visual.target, 'en'); assert.equal(visual.source, false); assert.equal(visual.hint, true);
    assert.equal(visual.icons.length, 2); assert.ok(visual.icons.every(content => content && content !== 'none'));
    report.checks.localIconsAndTargetOnlyLanguage = visual;
    await ui(window, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(probeDir, 'session-ui.png'), (await window.webContents.capturePage()).toPNG());
    if (!(await ui(window, 'document.getElementById("aiVoiceBtn").getAttribute("aria-pressed")==="true"'))) await ui(window, 'document.getElementById("aiVoiceBtn").click()');
    await ui(window, 'document.getElementById("startBtn").click()');
    const running = await poll(async () => { const value = await snapshot(); return value.phase === 'running' && value.segments.length > 0 && value; }, 'translation running');
    report.sessionId = running.sessionId;
    await poll(() => ui(window, 'document.getElementById("sourceText").textContent.includes("桌面验证原文") && document.getElementById("targetText").textContent.includes("Desktop translation")'), 'paired captions rendered');
    report.checks.createdMeetingAndRenderedCaptions = true;
    await ui(window, 'document.querySelector(".notes-textarea").value="Desktop milestone note";document.querySelector(".notes-textarea").dispatchEvent(new Event("input"))');
    await ui(window, 'document.getElementById("fcPauseBtn").click()');
    await poll(async () => (await snapshot()).phase === 'paused', 'pause');
    const paused = await ui(host, 'window.__desktopTest'); assert.equal(paused.started, paused.stopped);
    await ui(window, 'document.getElementById("fcPauseBtn").click()');
    await poll(async () => (await snapshot()).phase === 'running', 'resume');
    assert.equal((await snapshot()).sessionId, running.sessionId); report.checks.pauseReleasesCaptureAndKeepsSession = true;
    await ui(window, 'document.getElementById("fcStopBtn").click();document.getElementById("stopConfirmOk").click()');
    await poll(async () => (await snapshot()).phase === 'stopped', 'stop');
    const detail = await ui(window, `fetch('/api/sessions/${running.sessionId}').then(response=>response.json())`);
    assert.equal(detail.session.status, 'completed'); assert.ok(detail.notes.some(note => note.content === 'Desktop milestone note'));
    assert.ok(detail.segments.at(-1).source_text === '停止前的最后一句。'); assert.ok(detail.segments.every(segment => segment.status === 'final'));
    report.checks.stopPersistsNoteAndFinalTail = true;
    await ui(window, 'window.electronAPI.openManageWindow()');
    const manage = await poll(() => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/manage.html')), 'history window');
    await poll(() => !manage.webContents.isLoadingMainFrame(), 'history loaded');
    await poll(() => ui(manage, 'document.body.textContent.includes("Desktop milestone verification")'), 'history item rendered');
    report.checks.historyListsSavedMeeting = true;
    const counts = await ui(host, 'window.__desktopTest'); assert.equal(counts.started, counts.stopped); assert.deepEqual(counts.errors, []); assert.deepEqual(errors, []);
    report.captureCounts = counts; report.consoleErrors = errors;
    fs.mkdirSync(probeDir, { recursive: true }); fs.writeFileSync(path.join(probeDir, 'desktop-verification.json'), JSON.stringify(report, null, 2));
    verified = true; console.log(JSON.stringify(report, null, 2)); app.quit();
}
app.on('will-quit', event => { if (!verified) { event.preventDefault(); app.exit(1); } });
setTimeout(() => { if (!verified) { console.error('Desktop verification timeout', errors); process.exitCode = 1; app.quit(); } }, 45000).unref();
require('../electron/main.js');
