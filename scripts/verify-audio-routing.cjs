const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DEFAULT_AUDIO_SETTINGS } = require('../electron/audio-settings.js');
const root = path.resolve(__dirname, '..');
const probeDir = path.join(root, 'data', 'probes');
const userData = path.join(probeDir, 'audio-routing-test-user');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'audio-settings.json'), JSON.stringify(DEFAULT_AUDIO_SETTINGS));
process.env.SERVER_PORT = '0';
process.env.DDTRANS_TEST_USER_DATA = userData;
process.env.DDTRANS_DATA_DIR = path.join(probeDir, 'audio-routing-test-data');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(check, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await check(); if (value) return value; await wait(80); }
    throw new Error('音频路由验证超时');
}
const page = suffix => BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().endsWith(suffix));
const js = (window, code) => window.webContents.executeJavaScript(code, true);
let verified = false;
const report = { date: '2026-10-30', checks: {}, consoleErrors: [] };
app.on('browser-window-created', (_event, window) => {
    window.webContents.on('console-message', details => { if (details.level === 'error' || details.level === 3) report.consoleErrors.push(details.message); });
});

async function nativeAudioTest() {
    const { createAudioMixBus, classifyAudioDevices } = await import('/js/audio-mix-bus.js');
    const { createPcmPlayer } = await import('/js/audio-engine.js');
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const inputContext = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
    const analyserContext = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
    await inputContext.resume(); await analyserContext.resume();
    const devices = classifyAudioDevices(await navigator.mediaDevices.enumerateDevices());
    const bus = createAudioMixBus({ routing: { monitorEnabled: false, originalGain: 1, translatedGain: 1 } });
    await bus.updateDevices(devices);
    const streams = [], nodes = [], oscillators = [];
    let player;
    function tone(frequency, amplitude) {
        const oscillator = inputContext.createOscillator(); oscillator.frequency.value = frequency;
        const gain = inputContext.createGain(); gain.gain.value = amplitude;
        const destination = inputContext.createMediaStreamDestination();
        oscillator.connect(gain); gain.connect(destination); oscillator.start();
        oscillators.push(oscillator); nodes.push(oscillator, gain, destination); streams.push(destination.stream);
        return { stream: destination.stream, gain };
    }
    function analyzer(stream) {
        const source = analyserContext.createMediaStreamSource(stream), node = analyserContext.createAnalyser();
        node.fftSize = 4096; source.connect(node); nodes.push(source, node); return node;
    }
    function amplitude(node, frequency) {
        const samples = new Float32Array(node.fftSize); node.getFloatTimeDomainData(samples);
        let real = 0, imaginary = 0;
        for (let i = 0; i < samples.length; i++) { const angle = 2 * Math.PI * frequency * i / analyserContext.sampleRate; real += samples[i] * Math.cos(angle); imaginary += samples[i] * Math.sin(angle); }
        return 2 * Math.hypot(real, imaginary) / samples.length;
    }
    async function measure(node, settleMs = 220) {
        await delay(settleMs);
        let original = 0, translated = 0;
        for (let i = 0; i < 4; i++) { original += amplitude(node, 440); translated += amplitude(node, 997); await delay(60); }
        return { original: original / 4, translated: translated / 4 };
    }
    const result = {};
    try {
        const original = tone(440, 0.12), translated = tone(997, 0.08);
        await bus.connectOriginalStream(original.stream); await bus.connectTranslatedStream(translated.stream);
        const mixedStream = bus.getOutputStream(), mixed = analyzer(mixedStream);
        result.both = await measure(mixed);
        await bus.setRouting({ originalGain: 0 }); result.originalMuted = await measure(mixed);
        await bus.setRouting({ originalGain: 0.25 }); result.originalQuarter = await measure(mixed);
        await bus.setRouting({ originalGain: 1, translatedGain: 0 }); result.translatedMuted = await measure(mixed);
        await bus.setRouting({ translatedGain: 1, ttsEnabled: false }); result.ttsOff = await measure(mixed);
        await bus.setRouting({ ttsEnabled: true });
        original.gain.gain.value = 0.85; translated.gain.gain.value = 0.85;
        await delay(350);
        const samples = new Float32Array(mixed.fftSize); mixed.getFloatTimeDomainData(samples);
        result.maxMixedSample = Math.max(...samples.map(Math.abs));
        result.clippedSamples = bus.getSnapshot().levels.clippedSamples;
        original.gain.gain.value = 0.12; translated.gain.gain.value = 0.08;
        const loopback = await navigator.mediaDevices.getDisplayMedia({ audio: { restrictOwnAudio: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: true });
        streams.push(loopback); loopback.getVideoTracks().forEach(track => track.stop());
        const loopbackAnalyzer = analyzer(loopback);
        await bus.setRouting({ monitorEnabled: true, monitorMode: 'translated', monitorVolume: 1 });
        result.monitorTranslatedOnly = await measure(loopbackAnalyzer);
        await bus.setRouting({ monitorVolume: 0.2 }); result.monitorFifth = await measure(loopbackAnalyzer);
        await bus.setRouting({ monitorEnabled: false }); result.monitorOff = await measure(loopbackAnalyzer);
        const defaultLabel = devices.outputs.find(device => device.deviceId === 'default')?.label.replace(/^Default - /, '');
        const speaker = devices.outputs.find(device => device.deviceId !== 'default' && device.label === defaultLabel);
        if (!speaker) throw new Error('Selected-output verification needs an explicit endpoint for the default speaker');
        result.selectedOutputDevice = { label: speaker.label, likelyVirtual: speaker.likelyVirtual };
        await bus.setRouting({ virtualOutputEnabled: true, virtualRenderDeviceId: speaker.deviceId });
        result.selectedOutput = await measure(loopbackAnalyzer, 1200);
        await bus.setRouting({ monitorVolume: 0 }); result.selectedOutputMonitorMuted = await measure(loopbackAnalyzer, 1200);
        await bus.setRouting({ originalGain: 0 }); result.selectedOutputOriginalMuted = await measure(loopbackAnalyzer, 1200);
        await bus.setRouting({ originalGain: 1, monitorEnabled: true, monitorVolume: 1 });
        result.sameDeviceMonitorBlocked = !bus.getSnapshot().monitorOutputReady && bus.getSnapshot().virtualOutputReady;
        result.selectedOutputNoDuplicate = await measure(loopbackAnalyzer, 1200);
        await bus.setRouting({ monitorEnabled: false, virtualOutputEnabled: true, virtualRenderDeviceId: 'ddtrans-device-does-not-exist' });
        result.missingDevice = bus.getSnapshot();
        result.missingDeviceSilent = await measure(loopbackAnalyzer);
        await bus.setRouting({ virtualOutputEnabled: false, virtualRenderDeviceId: '' });
        await bus.disconnectOriginalStream(); await bus.disconnectTranslatedStream();
        player = createPcmPlayer({ sampleRate: 24000, streamOutput: true, volume: 1, onError: () => {} });
        await bus.connectTranslatedStream(player.getOutputStream());
        const pcm = new Int16Array(24000 * 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(2 * Math.PI * 997 * i / 24000) * 2621);
        player.append(new Uint8Array(pcm.buffer));
        result.playerFull = await measure(mixed);
        player.setVolume(0.25); result.playerQuarter = await measure(mixed);
        result.playerBuffer = player.getDiagnostics();
        try { player.append(new Uint8Array(24000 * 2 * 11)); result.overflowRejected = false; }
        catch (error) { result.overflowRejected = error.code === 'AUDIO_BUFFER_OVERFLOW'; }
        await player.stop();
        await bus.stop();
        result.released = !bus.getSnapshot().active && !bus.getSnapshot().monitorOutputReady && !bus.getSnapshot().virtualOutputReady && mixedStream.getAudioTracks().every(track => track.readyState === 'ended');
        const tested = await bus.testTone({ target: 'monitor' });
        result.idleTestReleased = tested.target === 'monitor' && !bus.getSnapshot().active;
        return result;
    } finally {
        await player?.stop(); await bus.stop();
        streams.flatMap(stream => stream.getTracks()).forEach(track => track.stop());
        for (const oscillator of oscillators) { try { oscillator.stop(); } catch (_) {} }
        nodes.forEach(node => { try { node.disconnect(); } catch (_) {} });
        await inputContext.close(); await analyserContext.close();
    }
}

app.whenReady().then(async () => {
    console.log(JSON.stringify({ probeRoot: root, appRoot: app.getAppPath() }));
    const home = await poll(() => page('/home.html'));
    await poll(() => !home.webContents.isLoadingMainFrame());
    await js(home, 'document.getElementById("openSettingsBtn").click()');
    let settings = await poll(() => page('/settings.html'));
    await poll(() => !settings.webContents.isLoadingMainFrame());
    await poll(() => js(settings, 'document.getElementById("virtualStatusTitle").textContent !== "正在读取音频设备"'));
    await poll(() => js(settings, 'document.documentElement.dataset.audioSettingsReady === "true"'));
    report.devices = await js(settings, 'window.electronAPI.mediaCommand("enumerate-devices")');
    const listeningTarget = await js(settings, 'document.getElementById("targetLanguage").value');
    report.outgoing = await js(settings, '({deviceState:document.getElementById("outgoingStatus").dataset.deviceState,detail:document.getElementById("outgoingStatusDetail").textContent,startDisabled:document.getElementById("startOutgoingBtn").disabled})');
    if (report.outgoing.deviceState !== 'available') {
        assert.equal(report.outgoing.startDisabled, true);
        assert.ok(report.outgoing.detail.length > 10);
        const before = await js(home, 'window.electronAPI.getMediaSnapshot()');
        await js(settings, 'document.getElementById("startOutgoingBtn").click()');
        const after = await js(home, 'window.electronAPI.getMediaSnapshot()');
        assert.equal(after.phase, before.phase); assert.equal(after.sessionId, before.sessionId);
        report.checks.outgoingUnavailableDoesNotStart = true;
    }
    await js(settings, 'document.getElementById("outgoingTargetLanguage").value="ja";document.getElementById("outgoingTargetLanguage").dispatchEvent(new Event("change"))');
    await js(settings, 'document.getElementById("originalGain").value="33";document.getElementById("originalGain").dispatchEvent(new Event("input"));document.getElementById("closeBtn").click()');
    await poll(() => !page('/settings.html'));
    const persisted = await js(home, 'window.electronAPI.getAudioSettings()');
    assert.equal(persisted.originalGain, 0.33); assert.equal(persisted.outgoingTargetLanguage, 'ja');
    report.checks.quickCloseSaves = true; report.checks.outgoingLanguageSaved = true;
    await js(home, 'document.getElementById("openSettingsBtn").click()');
    settings = await poll(() => page('/settings.html'));
    await poll(() => !settings.webContents.isLoadingMainFrame());
    await poll(() => js(settings, 'document.getElementById("originalGain").value === "33"'));
    assert.equal(await js(settings, 'document.getElementById("outgoingTargetLanguage").value'), 'ja');
    assert.equal(await js(settings, 'document.getElementById("targetLanguage").value'), listeningTarget);
    report.checks.outgoingLanguageIndependent = true;
    report.checks.reopenRestores = true;
    await js(settings, 'window.electronAPI.mediaCommand("set-audio-routing",{virtualOutputEnabled:true,virtualRenderDeviceId:"ddtrans-device-does-not-exist"})');
    await poll(() => js(settings, 'document.getElementById("virtualStatus").textContent === "设备已断开"'));
    report.checks.disconnectedDeviceHonest = true;
    await js(settings, 'window.electronAPI.mediaCommand("set-audio-routing",{virtualOutputEnabled:false,virtualRenderDeviceId:""})');
    const host = page('/media-host.html');
    report.audio = await js(host, '(' + nativeAudioTest.toString() + ')()');
    const audio = report.audio;
    fs.writeFileSync(path.join(probeDir, 'audio-routing-verification.json'), JSON.stringify(report, null, 2));
    assert.ok(audio.both.original > 0.08 && audio.both.translated > 0.05, 'both signals must be audible on the actual mix stream');
    assert.ok(audio.originalMuted.original < 0.002 && Math.abs(audio.originalMuted.translated / audio.both.translated - 1) < 0.08);
    assert.ok(Math.abs(audio.originalQuarter.original / audio.both.original - 0.25) < 0.04);
    assert.ok(audio.translatedMuted.translated < 0.002 && audio.translatedMuted.original > 0.08);
    assert.ok(audio.ttsOff.translated < 0.002 && audio.ttsOff.original > 0.08);
    assert.ok(audio.maxMixedSample <= 1.000001 && audio.clippedSamples > 0);
    assert.ok(audio.monitorTranslatedOnly.original < 0.002 && audio.monitorTranslatedOnly.translated > 0.02);
    assert.ok(Math.abs(audio.monitorFifth.translated / audio.monitorTranslatedOnly.translated - 0.2) < 0.05);
    assert.ok(audio.monitorOff.translated < 0.002);
    assert.ok(audio.selectedOutput.original > 0.04 && audio.selectedOutput.translated > 0.02);
    assert.ok(Math.abs(audio.selectedOutputMonitorMuted.original / audio.selectedOutput.original - 1) < 0.08);
    assert.ok(Math.abs(audio.selectedOutputMonitorMuted.translated / audio.selectedOutput.translated - 1) < 0.08);
    assert.ok(audio.selectedOutputOriginalMuted.original < 0.002 && Math.abs(audio.selectedOutputOriginalMuted.translated / audio.selectedOutput.translated - 1) < 0.08);
    assert.equal(audio.sameDeviceMonitorBlocked, true);
    assert.ok(Math.abs(audio.selectedOutputNoDuplicate.original / audio.selectedOutput.original - 1) < 0.08);
    assert.ok(Math.abs(audio.selectedOutputNoDuplicate.translated / audio.selectedOutput.translated - 1) < 0.08);
    assert.ok(audio.missingDeviceSilent.original < 0.002 && audio.missingDeviceSilent.translated < 0.002);
    assert.equal(audio.missingDevice.status, 'error'); assert.equal(audio.missingDevice.virtualOutputReady, false);
    assert.ok(audio.playerFull.translated > 0.04 && Math.abs(audio.playerQuarter.translated / audio.playerFull.translated - 0.25) < 0.06);
    assert.ok(audio.playerBuffer.bufferedMs <= audio.playerBuffer.maxBufferedMs);
    assert.equal(audio.overflowRejected, true); assert.equal(audio.released, true); assert.equal(audio.idleTestReleased, true);
    report.checks.actualAudio = true;
    const layout = await js(settings, '({width:innerWidth,scrollWidth:document.querySelector(".settings-content").scrollWidth,clientWidth:document.querySelector(".settings-content").clientWidth})');
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1); report.checks.layout = layout;
    const imageDir = path.join(root, 'docs', 'images'); fs.mkdirSync(imageDir, { recursive: true });
    await js(settings, 'document.querySelector(".settings-content").scrollTop=0');
    fs.writeFileSync(path.join(imageDir, 'audio-settings-2026-10-29.png'), (await settings.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(probeDir, 'audio-routing-verification.json'), JSON.stringify(report, null, 2));
    verified = true; console.log(JSON.stringify(report, null, 2)); app.quit();
}).catch(error => { console.error(error.stack || error.message); console.error(JSON.stringify(report)); process.exitCode = 1; app.quit(); });
app.on('will-quit', event => { if (!verified) { event.preventDefault(); app.exit(1); } });
setTimeout(() => { if (!verified) { console.error('audio routing verification timeout'); process.exitCode = 1; app.quit(); } }, 60000).unref();
require('../electron/main.js');
