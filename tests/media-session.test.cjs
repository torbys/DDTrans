const test = require('node:test');
const assert = require('node:assert/strict');
const drain = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ isolated = true, systemAudio = true, failCapture = false, audioSettings = {}, failSave = false, devices, mix = false, routeError = '' } = {}) {
    const { createMediaSession } = await import('../app/js/media-session.js');
    const events = [], captures = [], players = [], sockets = [], requests = [], saved = [];
    let captureFailure = failCapture;
    const bus = {
        routing: {}, original: null, translated: null, allowed: true,
        async setRouting(next) { this.routing = { ...next }; },
        async updateDevices(report) { this.devices = report; },
        async setPlaybackAllowed(allowed) { this.allowed = allowed; },
        async connectOriginalStream(stream) { this.original = stream; },
        async connectTranslatedStream(stream) { this.translated = stream; },
        async disconnectOriginalStream() { this.original = null; },
        async disconnectTranslatedStream() { this.translated = null; },
        async stop() { this.original = this.translated = null; },
        async testTone(options) { this.tested = options; return { target: options.target, captureVerified: false }; },
        getSnapshot() { return { ...this.routing, virtualOutputReady: Boolean(this.original && this.allowed && this.routing.virtualOutputEnabled && !routeError), virtualError: routeError }; },
    };
    const media = createMediaSession({
        capabilities: { systemAudio, isolatedTts: isolated },
        audioSettings,
        saveAudioSettings: async next => { if (failSave) throw new Error('Disk full'); saved.push({ ...next }); },
        ...(devices ? { enumerateDevices: async () => devices } : {}),
        ...(mix ? { createMixBus: ({ routing }) => { bus.routing = { ...routing }; return bus; } } : {}),
        publish: event => events.push(event),
        createCapture: async options => {
            if (captureFailure) { captureFailure = false; throw new Error('Permission denied'); }
            const capture = { options, stream: { source: 'capture' }, stopped: false, paused: false, isolatedSystemAudio: isolated,
                pause() { this.paused = true; }, resume() { this.paused = false; }, async stop() { this.stopped = true; } };
            captures.push(capture); return capture;
        },
        createPlayer: options => {
            const player = { options, chunks: [], stopped: false, volume: options.volume,
                getOutputStream() { return { source: 'translated' }; },
                append(bytes) { this.chunks.push(bytes); }, async stop() { this.stopped = true; }, setVolume(volume) { this.volume = volume; } };
            players.push(player); return player;
        },
        createSocket: () => {
            const socket = { readyState: 0, bufferedAmount: 0, frames: [],
                receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); },
                send(data) {
                    if (typeof data !== 'string') { this.frames.push(data); return; }
                    const request = JSON.parse(data); requests.push(request);
                    if (request.type === 'start') {
                        this.sessionId = 'session-' + sockets.length;
                        this.receive({ type: 'ready', session_id: this.sessionId });
                        this.receive({ type: 'state', state: 'running' });
                    }
                    if (request.type === 'pause') this.receive({ type: 'state', state: 'paused' });
                    if (request.type === 'resume') this.receive({ type: 'state', state: 'running' });
                    if (request.type === 'note') this.receive({ type: 'note_saved' });
                    if (request.type === 'stop') {
                        this.receive({ type: 'segment', segment: { segment_key: this.sessionId + '-tail', sequence_order: 2, source_text: 'last sentence', target_text: '最后一句', status: 'final' } });
                        this.receive({ type: 'stopped', session_id: this.sessionId, status: 'completed' });
                    }
                },
                close() { this.readyState = 3; this.onclose?.(); },
            };
            sockets.push(socket);
            queueMicrotask(() => { socket.readyState = 1; socket.onopen?.(); });
            return socket;
        },
    });
    return { media, events, captures, players, sockets, requests, saved, bus };
}
const pcmAudio = { type: 'audio', audio: Buffer.from([1, 0, 2, 0]).toString('base64'), sample_rate: 24000 };
test('reconnecting keeps capture for local saving, clears TTS, and retains terminal error details', async t => {
    const f = await fixture();
    t.after(() => f.media.execute('stop'));
    await f.media.execute('start', { targetLanguage: 'en', audioEnabled: true, useSystemAudio: true });
    const socket = f.sockets[0];
    socket.receive(pcmAudio); await drain();
    socket.receive({ type: 'state', state: 'reconnecting' }); await drain();
    assert.equal(f.captures[0].stopped, false);
    assert.equal(f.players[0].stopped, true);
    f.captures[0].options.onFrame({ pcm: new Int16Array([1, 2]) });
    assert.equal(socket.frames.length, 1);
    socket.receive({ type: 'stopped', status: 'failed', error: 'API Key 验证失败（HTTP 401）' }); await drain();
    const snapshot = await f.media.execute('snapshot');
    assert.equal(snapshot.phase, 'failed');
    assert.match(snapshot.feedback.message, /401/);
    assert.equal(f.captures[0].stopped, true);
});
function outgoingDevices() {
    return {
        inputs: [
            { deviceId: 'default', label: 'Default - Desk Microphone', groupId: 'mic-group' },
            { deviceId: 'mic', label: 'Desk Microphone', groupId: 'mic-group' },
            { deviceId: 'dd-capture', label: 'DDTrans Virtual Microphone', groupId: 'virtual-group' },
            { deviceId: 'cable', label: 'CABLE Output' },
            { deviceId: 'stereo-mix', label: 'Stereo Mix (Realtek Audio)' },
        ],
        outputs: [
            { deviceId: 'default', label: 'Default - DDTrans Virtual Input' },
            { deviceId: 'dd-render', label: 'DDTrans Virtual Input', groupId: 'virtual-group' },
            { deviceId: 'speakers', label: 'Desk Speakers' },
        ],
    };
}

test('media owner preserves session and final segments across pause, UI attachment and TTS controls', async t => {
    const f = await fixture();
    t.after(() => f.media.execute('stop'));
    await f.media.execute('start', { targetLanguage: 'zh', useSystemAudio: true, useMicAudio: false, audioEnabled: true });
    const ws = f.sockets[0];
    ws.receive({ type: 'segment', segment: { segment_key: 'first', sequence_order: 1, source_text: 'hello', target_text: '你好', speaker_id: 0, status: 'final' } });
    const before = await f.media.execute('snapshot');
    const reattached = await f.media.execute('prepare-overlay');
    assert.equal(before.sessionId, reattached.sessionId); assert.equal(f.sockets.length, 1); assert.equal(f.captures.length, 1);
    assert.equal(reattached.segments[0].speaker_id, 0);
    ws.receive(pcmAudio); await drain(); assert.equal(f.players.length, 1);
    await f.media.execute('set-volume', { volume: 0 }); assert.equal(f.players[0].volume, 0);
    await f.media.execute('set-tts', { enabled: false }); assert.equal(f.players[0].stopped, true);
    ws.receive(pcmAudio); await drain(); assert.equal(f.players.length, 1); assert.equal((await f.media.execute('snapshot')).phase, 'running');
    const pcm = new Int16Array([9, 1, 2, 9]).subarray(1, 3); f.captures[0].options.onFrame({ pcm });
    assert.deepEqual([...new Int16Array(ws.frames[0])], [1, 2]);
    await f.media.execute('pause'); assert.equal(f.captures[0].stopped, true);
    await f.media.execute('resume'); assert.equal(f.captures.length, 2); assert.equal((await f.media.execute('snapshot')).sessionId, before.sessionId);
    await f.media.execute('set-tts', { enabled: true }); ws.receive(pcmAudio); await drain(); assert.equal(f.players.length, 2);
    await f.media.execute('save-note', { content: 'memo' });
    const stopped = await f.media.execute('stop');
    assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.note, 'memo'); assert.equal(stopped.segments.at(-1).target_text, '最后一句');
    assert.ok(f.captures.every(c => c.stopped)); assert.ok(f.players.every(p => p.stopped)); assert.equal(ws.readyState, 3);
});

test('target switch finishes the old session, clears captions and retains paused capture state', async t => {
    const f = await fixture();
    t.after(() => f.media.execute('stop'));
    const old = await f.media.execute('start', { targetLanguage: 'zh' });
    await f.media.execute('pause');
    const next = await f.media.execute('set-target', { targetLanguage: 'ja' });
    assert.notEqual(next.sessionId, old.sessionId); assert.equal(next.config.targetLanguage, 'ja');
    assert.equal(next.phase, 'paused'); assert.deepEqual(next.segments, []);
    assert.deepEqual(f.requests.map(r => r.type), ['start', 'pause', 'stop', 'start', 'pause']);
    assert.equal(f.requests.filter(r => r.type === 'start')[1].target_language, 'ja');
    await f.media.execute('stop');
});

test('unavailable permission fails cleanly and permits a fresh start', async t => {
    const f = await fixture({ failCapture: true });
    t.after(() => f.media.execute('stop'));
    await assert.rejects(f.media.execute('prepare-overlay'), /Permission denied/);
    assert.equal((await f.media.execute('snapshot')).phase, 'failed'); assert.equal(f.sockets.length, 0);
    const result = await f.media.execute('prepare-overlay'); assert.equal(result.phase, 'running');
    await f.media.execute('stop');
});

test('system playback is gated by audio isolation, microphone playback remains available', async t => {
    const f = await fixture({ isolated: false });
    t.after(() => f.media.execute('stop'));
    await f.media.execute('start'); f.sockets[0].receive(pcmAudio); await drain(); assert.equal(f.players.length, 0);
    await f.media.execute('switch-source', { useSystemAudio: false, useMicAudio: true });
    f.sockets[0].receive(pcmAudio); await drain(); assert.equal(f.players.length, 1);
    await f.media.execute('stop');
});

test('concurrent start and stop are serialized and a lost connection releases media', async t => {
    const f = await fixture();
    t.after(() => f.media.execute('stop'));
    const started = f.media.execute('start'); const stopped = f.media.execute('stop');
    await started; assert.equal((await stopped).phase, 'stopped');
    await f.media.execute('start'); f.sockets[1].receive(pcmAudio); f.sockets[1].close();
    assert.equal((await f.media.execute('snapshot')).phase, 'failed');
    await drain();
    assert.ok(f.captures.every(c => c.stopped)); assert.ok(f.players.every(p => p.stopped));
    await f.media.execute('stop');
});

test('exit flushes the last debounced note before model finish', async t => {
    const f = await fixture();
    t.after(() => f.media.execute('stop')); await f.media.execute('start');
    await f.media.execute('save-note', { content: 'first draft', defer: true });
    await f.media.execute('save-note', { content: 'last keystroke', defer: true });
    const result = await f.media.execute('stop');
    assert.equal(result.note, 'last keystroke');
    assert.deepEqual(f.requests.filter(request => request.type === 'note').map(request => request.content), ['last keystroke']);
    assert.ok(f.requests.findIndex(request => request.type === 'note') < f.requests.findIndex(request => request.type === 'stop'));
});


test('routing changes preserve the model input and session and survive pause and language switches', async t => {
    const f = await fixture(); t.after(() => f.media.execute('stop'));
    const before = await f.media.execute('start');
    const changed = await f.media.execute('set-audio-routing', { originalGain: 0, translatedGain: 0.4, monitorEnabled: false, ttsEnabled: false });
    assert.equal(changed.sessionId, before.sessionId);
    assert.equal(changed.ttsEnabled, false);
    f.captures[0].options.onFrame({ pcm: new Int16Array([14000, -7000]) });
    assert.deepEqual([...new Int16Array(f.sockets[0].frames[0])], [14000, -7000]);
    await f.media.execute('pause'); await f.media.execute('resume');
    const resumed = await f.media.execute('snapshot');
    assert.equal(resumed.audioRouting.originalGain, 0);
    assert.equal(resumed.audioRouting.translatedGain, 0.4);
    assert.equal(resumed.audioRouting.monitorEnabled, false);
    const otherLanguage = await f.media.execute('set-target', { targetLanguage: 'ja' });
    assert.equal(otherLanguage.ttsEnabled, false);
    assert.equal(otherLanguage.audioRouting.ttsEnabled, false);
    assert.equal(f.saved.at(-1).translatedGain, 0.4);
});

test('text-only languages do not erase the saved voice preference', async t => {
    const f = await fixture(); t.after(() => f.media.execute('stop'));
    await f.media.execute('start', { targetLanguage: 'yue' });
    const text = await f.media.execute('snapshot');
    assert.equal(text.ttsEnabled, false); assert.equal(text.audioRouting.ttsEnabled, true);
    const speech = await f.media.execute('set-target', { targetLanguage: 'en' });
    assert.equal(speech.ttsEnabled, true);
});

test('invalid settings and failed persistence keep the previous routing intact', async () => {
    const f = await fixture({ failSave: true });
    await assert.rejects(f.media.execute('set-audio-routing', { originalGain: '0' }), /invalid/);
    await assert.rejects(f.media.execute('set-audio-routing', { originalGain: 0 }), /Disk full/);
    assert.equal((await f.media.execute('snapshot')).audioRouting.originalGain, 1);
});

test('using the output capture endpoint as translation input is rejected without blocking a real microphone', async t => {
    const devices = { inputs: [{ deviceId: 'mic', label: 'Microphone', groupId: 'shared' }, { deviceId: 'virtual', label: 'CABLE Output', groupId: 'shared' }], outputs: [] };
    const f = await fixture({ devices, audioSettings: { virtualOutputEnabled: true, virtualRenderDeviceId: 'render', virtualCaptureDeviceId: 'virtual' } });
    t.after(() => f.media.execute('stop'));
    await assert.rejects(f.media.execute('start', { useSystemAudio: false, useMicAudio: true, deviceId: 'virtual' }), /重复翻译/);
    const running = await f.media.execute('start', { useSystemAudio: false, useMicAudio: true, deviceId: 'mic' });
    assert.equal(running.phase, 'running');
});

test('listening retains an explicitly selected speaker for manual virtual-output tests', async t => {
    const devices = {
        inputs: [{ deviceId: 'mic', label: 'Desk Microphone' }, { deviceId: 'capture', label: 'CABLE Output (VB-Audio Virtual Cable)' }],
        outputs: [{ deviceId: 'speakers', label: 'Desk Speakers' }],
    };
    const f = await fixture({ devices, mix: true, audioSettings: { virtualOutputEnabled: true, virtualRenderDeviceId: 'speakers', virtualRenderDeviceLabel: 'Desk Speakers', virtualCaptureDeviceId: 'capture', virtualCaptureDeviceLabel: 'CABLE Output (VB-Audio Virtual Cable)' } });
    t.after(() => f.media.execute('stop'));
    const snapshot = await f.media.execute('start', { useSystemAudio: false, useMicAudio: true, deviceId: 'mic' });
    assert.equal(snapshot.audioRouting.virtualOutputEnabled, true);
    assert.equal(snapshot.audioRouting.virtualOutputReady, true);
    assert.equal(f.bus.routing.virtualOutputEnabled, true);
    await f.media.execute('audio-routing-test', { target: 'virtual' });
    assert.deepEqual(f.bus.tested, { target: 'virtual' });
});

test('outgoing language preference leaves a listening session untouched and is used by a recreated owner', async t => {
    const f = await fixture({ devices: outgoingDevices(), mix: true });
    t.after(() => f.media.execute('stop'));
    const listening = await f.media.execute('start', { targetLanguage: 'zh' });
    const changed = await f.media.execute('set-audio-routing', { outgoingTargetLanguage: 'ja' });
    assert.equal(changed.sessionId, listening.sessionId);
    assert.equal(changed.config.targetLanguage, 'zh');
    assert.equal(changed.audioRouting.outgoingTargetLanguage, 'ja');
    assert.equal(f.sockets.length, 1);
    assert.equal(f.captures[0].stopped, false);
    await f.media.execute('stop');
    const reopened = await fixture({ devices: outgoingDevices(), mix: true, audioSettings: f.saved.at(-1) });
    t.after(() => reopened.media.execute('stop'));
    const outgoing = await reopened.media.execute('start', { mode: 'outgoing' });
    assert.equal(outgoing.config.targetLanguage, 'ja');
    assert.equal(outgoing.config.mode, 'outgoing');
    assert.equal(reopened.requests[0].target_language, 'ja');
});

test('outgoing start pins a physical microphone, binds only the DDTrans pair and sends translated audio', async t => {
    const monitor = { monitorEnabled: false, monitorVolume: 0.33, monitorMode: 'mix', monitorDeviceId: 'headphones', monitorDeviceLabel: 'Headphones' };
    const f = await fixture({ devices: outgoingDevices(), mix: true, audioSettings: { ...monitor, ttsEnabled: false, ttsVolume: 0, translatedGain: 0, virtualRenderDeviceId: 'speakers', originalGain: 0.9 } });
    t.after(() => f.media.execute('stop'));
    const started = await f.media.execute('start', { mode: 'outgoing', useSystemAudio: true, useMicAudio: false, audioEnabled: false });
    assert.equal(started.phase, 'running');
    assert.equal(started.config.useSystemAudio, false);
    assert.equal(started.config.useMicAudio, true);
    assert.equal(started.config.deviceId, 'mic');
    assert.equal(started.config.audioEnabled, true);
    assert.equal(started.config.targetLanguage, 'en');
    assert.equal(started.ttsEnabled, true);
    assert.equal(started.audioRouting.originalGain, 0);
    assert.equal(started.audioRouting.translatedGain, 1);
    assert.equal(started.audioRouting.ttsVolume, 0.8);
    assert.equal(started.audioRouting.virtualRenderDeviceId, 'dd-render');
    assert.equal(started.audioRouting.virtualCaptureDeviceId, 'dd-capture');
    assert.equal(started.audioRouting.virtualOutputEnabled, true);
    assert.equal(started.audioRouting.virtualOutputReady, true);
    for (const [key, value] of Object.entries(monitor)) assert.equal(started.audioRouting[key], value);
    const source = f.captures[0].options;
    assert.equal(source.deviceId, 'mic');
    assert.equal(source.useSystemAudio, false);
    assert.equal(source.useMicAudio, true);
    assert.equal(f.requests[0].audio_enabled, true);
    assert.equal(Object.hasOwn(f.requests[0], 'source_language'), false);
    source.onFrame({ pcm: new Int16Array([2000, -1000]) });
    assert.deepEqual([...new Int16Array(f.sockets[0].frames[0])], [2000, -1000]);
    f.sockets[0].receive(pcmAudio); await drain();
    assert.equal(f.players.length, 1);
    assert.equal(f.players[0].options.streamOutput, true);
    assert.equal(f.players[0].chunks.length, 1);
    assert.equal(f.bus.translated.source, 'translated');
    const stopped = await f.media.execute('stop', { mode: 'outgoing', sessionId: started.sessionId });
    assert.equal(stopped.phase, 'stopped');
    assert.equal(stopped.audioRouting.virtualOutputEnabled, false);
    assert.equal(stopped.segments.at(-1).target_text, '最后一句');
    assert.equal(f.captures[0].stopped, true);
    assert.equal(f.players[0].stopped, true);
});

test('outgoing requires one concrete DDTrans render and capture endpoint without a speaker fallback', async t => {
    const scenarios = [
        ['missing render', devices => { devices.outputs = devices.outputs.filter(device => device.deviceId !== 'dd-render'); }],
        ['missing capture', devices => { devices.inputs = devices.inputs.filter(device => device.deviceId !== 'dd-capture'); }],
        ['duplicate render', devices => devices.outputs.push({ deviceId: 'dd-render-2', label: 'DDTrans Virtual Input' })],
        ['duplicate capture', devices => devices.inputs.push({ deviceId: 'dd-capture-2', label: 'DDTrans Virtual Microphone' })],
        ['similar unrelated label', devices => { devices.outputs.find(device => device.deviceId === 'dd-render').label = 'Other DDTrans Virtual Input'; }],
        ['arbitrary suffix', devices => { devices.outputs.find(device => device.deviceId === 'dd-render').label = 'DDTrans Virtual Input (Other Audio Device)'; }],
        ['capture suffix with extra text', devices => { devices.inputs.find(device => device.deviceId === 'dd-capture').label = 'DDTrans Virtual Microphone (DDTrans Virtual Audio) Fake'; }],
        ['wrong render flow', devices => { devices.outputs.find(device => device.deviceId === 'dd-render').kind = 'audioinput'; }],
        ['wrong capture flow', devices => { devices.inputs.find(device => device.deviceId === 'dd-capture').kind = 'audiooutput'; }],
    ];
    for (const [name, mutate] of scenarios) await t.test(name, async () => {
        const devices = outgoingDevices(); mutate(devices);
        const f = await fixture({ devices, mix: true });
        await assert.rejects(f.media.execute('start', { mode: 'outgoing' }), /DDTrans/);
        const snapshot = await f.media.execute('snapshot');
        assert.equal(snapshot.phase, 'idle');
        assert.equal(snapshot.audioRouting.virtualOutputEnabled, false);
        assert.equal(snapshot.audioRouting.virtualRenderDeviceId, '');
        assert.equal(f.captures.length, 0);
        assert.equal(f.sockets.length, 0);
    });
});

test('outgoing recognizes Chromium endpoint suffixes and excludes default aliases from pair counts', async t => {
    const devices = outgoingDevices();
    devices.outputs.find(device => device.deviceId === 'dd-render').label = 'DDTrans Virtual Input (DDTrans Virtual Audio)';
    devices.inputs.find(device => device.deviceId === 'dd-capture').label = 'DDTrans Virtual Microphone (DDTrans Virtual Audio)';
    devices.outputs.find(device => device.deviceId === 'dd-render').kind = 'audiooutput';
    devices.inputs.find(device => device.deviceId === 'dd-capture').kind = 'audioinput';
    devices.inputs.push({ deviceId: 'communications', label: 'DDTrans Virtual Microphone' });
    devices.outputs.push({ deviceId: 'imposter', kind: 'audiooutput', label: 'DDTrans Virtual Input (Another Driver)' });
    const f = await fixture({ devices, mix: true }); t.after(() => f.media.execute('stop'));
    const snapshot = await f.media.execute('start', { mode: 'outgoing' });
    assert.equal(snapshot.audioRouting.virtualRenderDeviceId, 'dd-render');
    assert.equal(snapshot.audioRouting.virtualCaptureDeviceId, 'dd-capture');
});

test('outgoing supports a saved VB-CABLE pair when multiple known pairs are present', async t => {
    const devices = outgoingDevices();
    devices.outputs.push({ deviceId: 'cable-render', kind: 'audiooutput', label: 'CABLE Input (VB-Audio Virtual Cable)' });
    devices.inputs.push({ deviceId: 'vb-capture', kind: 'audioinput', label: 'DDTrans Virtual Microphone (VB-Audio Virtual Cable)' });
    const f = await fixture({ devices, mix: true, audioSettings: { virtualRenderDeviceId: 'cable-render', virtualRenderDeviceLabel: 'CABLE Input (VB-Audio Virtual Cable)', virtualCaptureDeviceId: 'vb-capture', virtualCaptureDeviceLabel: 'DDTrans Virtual Microphone (VB-Audio Virtual Cable)' } });
    t.after(() => f.media.execute('stop'));
    const snapshot = await f.media.execute('start', { mode: 'outgoing' });
    assert.equal(snapshot.audioRouting.virtualRenderDeviceId, 'cable-render');
    assert.equal(snapshot.audioRouting.virtualCaptureDeviceId, 'vb-capture');
    assert.equal(snapshot.audioRouting.virtualOutputReady, true);
});

test('outgoing rejects virtual, system mix, unknown and unresolvable default inputs before capture', async t => {
    for (const deviceId of ['dd-capture', 'cable', 'stereo-mix', 'communications', 'missing']) await t.test(deviceId, async () => {
        const f = await fixture({ devices: outgoingDevices(), mix: true });
        await assert.rejects(f.media.execute('start', { mode: 'outgoing', deviceId }), /真实麦克风/);
        assert.equal(f.captures.length, 0);
        assert.equal(f.sockets.length, 0);
    });
    await t.test('default points to virtual input with no physical microphone', async () => {
        const devices = outgoingDevices();
        devices.inputs = devices.inputs.filter(device => device.deviceId !== 'mic');
        devices.inputs[0].label = 'Default - DDTrans Virtual Microphone';
        const f = await fixture({ devices, mix: true });
        await assert.rejects(f.media.execute('start', { mode: 'outgoing' }), /真实麦克风/);
        assert.equal(f.captures.length, 0);
    });
    await t.test('several physical inputs without an identifiable default', async () => {
        const devices = outgoingDevices();
        devices.inputs[0].label = 'Default - DDTrans Virtual Microphone';
        devices.inputs.push({ deviceId: 'headset', label: 'Headset Microphone' });
        const f = await fixture({ devices, mix: true });
        await assert.rejects(f.media.execute('start', { mode: 'outgoing' }), /真实麦克风/);
        assert.equal(f.captures.length, 0);
    });
});

test('outgoing can use the only real microphone when Windows default is the virtual capture', async t => {
    const devices = outgoingDevices(); devices.inputs[0].label = 'Default - DDTrans Virtual Microphone';
    const f = await fixture({ devices, mix: true }); t.after(() => f.media.execute('stop'));
    const snapshot = await f.media.execute('start', { mode: 'outgoing' });
    assert.equal(snapshot.config.deviceId, 'mic');
});

test('outgoing start and stale controls never replace, stop or resume an unrelated listening session', async t => {
    for (const phase of ['running', 'paused']) await t.test(phase, async t => {
        const f = await fixture({ devices: outgoingDevices(), mix: true }); t.after(() => f.media.execute('stop'));
        await f.media.execute('start', { targetLanguage: 'zh' });
        if (phase === 'paused') await f.media.execute('pause');
        const before = await f.media.execute('snapshot');
        const savedCount = f.saved.length, requestCount = f.requests.length;
        await assert.rejects(f.media.execute('start', { mode: 'outgoing' }), /请先停止并保存/);
        await assert.rejects(f.media.execute('stop', { mode: 'outgoing', sessionId: before.sessionId }), /模式已改变/);
        await assert.rejects(f.media.execute('resume', { mode: 'outgoing', sessionId: before.sessionId }), /模式已改变/);
        const after = await f.media.execute('snapshot');
        assert.equal(after.sessionId, before.sessionId);
        assert.equal(after.phase, phase);
        assert.deepEqual(after.config, before.config);
        assert.deepEqual(after.audioRouting, before.audioRouting);
        assert.equal(f.saved.length, savedCount);
        assert.equal(f.requests.length, requestCount);
        assert.equal(f.captures.length, 1);
        assert.equal(f.captures[0].stopped, phase === 'paused');
    });
});

test('running outgoing rejects unsafe source and route changes while saving a future language without restarting', async t => {
    const f = await fixture({ devices: outgoingDevices(), mix: true }); t.after(() => f.media.execute('stop'));
    const started = await f.media.execute('start', { mode: 'outgoing' });
    await assert.rejects(f.media.execute('switch-source', { useSystemAudio: true }), /真实麦克风/);
    await assert.rejects(f.media.execute('switch-source', { deviceId: 'dd-capture' }), /真实麦克风/);
    await assert.rejects(f.media.execute('switch-source', { mode: 'listening' }), /先停止/);
    await assert.rejects(f.media.execute('set-audio-routing', { virtualRenderDeviceId: 'speakers' }), /固定使用/);
    await assert.rejects(f.media.execute('set-audio-routing', { virtualOutputEnabled: false }), /固定使用/);
    await assert.rejects(f.media.execute('set-target', { targetLanguage: 'yue' }), /译音播报/);
    await f.media.execute('set-audio-routing', { originalGain: 0.25, outgoingTargetLanguage: 'ja' });
    const repeated = await f.media.execute('start', { mode: 'outgoing' });
    assert.equal(repeated.sessionId, started.sessionId);
    assert.equal(repeated.audioRouting.originalGain, 0.25);
    assert.equal(repeated.config.targetLanguage, 'en');
    assert.equal(repeated.audioRouting.outgoingTargetLanguage, 'ja');
    assert.equal(f.sockets.length, 1);
    assert.equal(f.captures.length, 1);
    assert.equal(f.captures[0].stopped, false);
    await f.media.execute('stop');
    const next = await f.media.execute('start', { mode: 'outgoing' });
    assert.equal(next.config.targetLanguage, 'ja');
    assert.equal(next.audioRouting.originalGain, 0);
});

test('outgoing device loss pauses capture and rebinds the unique pair when devices return', async t => {
    const devices = outgoingDevices();
    const f = await fixture({ devices, mix: true }); t.after(() => f.media.execute('stop'));
    const started = await f.media.execute('start', { mode: 'outgoing' });
    devices.outputs = devices.outputs.filter(device => device.deviceId !== 'dd-render');
    await f.media.execute('enumerate-devices');
    const paused = await f.media.execute('snapshot');
    assert.equal(paused.phase, 'paused');
    assert.equal(paused.audioRouting.virtualRenderDeviceId, 'dd-render');
    assert.equal(f.captures[0].stopped, true);
    assert.equal(f.bus.original, null);
    await assert.rejects(f.media.execute('resume', { mode: 'outgoing', sessionId: started.sessionId }), /DDTrans/);
    assert.equal(f.captures.length, 1);
    devices.outputs.push({ deviceId: 'new-render', label: 'DDTrans Virtual Input' });
    devices.inputs.find(device => device.deviceId === 'dd-capture').deviceId = 'new-capture';
    await f.media.execute('enumerate-devices');
    const resumed = await f.media.execute('resume', { mode: 'outgoing', sessionId: started.sessionId });
    assert.equal(resumed.phase, 'running');
    assert.equal(resumed.sessionId, started.sessionId);
    assert.equal(resumed.audioRouting.virtualRenderDeviceId, 'new-render');
    assert.equal(resumed.audioRouting.virtualCaptureDeviceId, 'new-capture');
    assert.equal(f.captures[1].options.deviceId, 'mic');
});

test('outgoing resume keeps its physical microphone pinned when the default changes and rejects its disappearance', async t => {
    const devices = outgoingDevices();
    const f = await fixture({ devices, mix: true }); t.after(() => f.media.execute('stop'));
    const started = await f.media.execute('start', { mode: 'outgoing' });
    await f.media.execute('pause');
    devices.inputs[0].label = 'Default - DDTrans Virtual Microphone';
    await f.media.execute('resume');
    assert.equal(f.captures[1].options.deviceId, 'mic');
    await f.media.execute('pause');
    devices.inputs = devices.inputs.filter(device => device.deviceId !== 'mic');
    await assert.rejects(f.media.execute('resume'), /真实麦克风/);
    assert.equal(f.captures.length, 2);
    const snapshot = await f.media.execute('snapshot');
    assert.equal(snapshot.sessionId, started.sessionId);
    assert.equal(snapshot.phase, 'paused');
});

test('outgoing failures release resources and do not connect a model before output is ready', async t => {
    for (const [name, options, pattern] of [
        ['no mixer', { mix: false }, /音频发送服务/],
        ['persistence failure', { mix: true, failSave: true }, /Disk full/],
        ['render open failure', { mix: true, routeError: 'Cannot open DDTrans Virtual Input' }, /Cannot open/],
        ['text-only language', { mix: true }, /译音播报/],
    ]) await t.test(name, async () => {
        const f = await fixture({ devices: outgoingDevices(), ...options });
        await assert.rejects(f.media.execute('start', { mode: 'outgoing', ...(name === 'text-only language' ? { targetLanguage: 'yue' } : {}) }), pattern);
        assert.equal(f.sockets.length, 0);
        assert.ok(f.captures.every(capture => capture.stopped));
        assert.equal(f.bus.original, null);
    });
});

test('stale outgoing session identifiers cannot stop or resume a newer session', async t => {
    const f = await fixture({ devices: outgoingDevices(), mix: true }); t.after(() => f.media.execute('stop'));
    const old = await f.media.execute('start', { mode: 'outgoing' });
    await f.media.execute('stop');
    const current = await f.media.execute('start', { mode: 'outgoing' });
    await assert.rejects(f.media.execute('stop', { mode: 'outgoing', sessionId: old.sessionId }), /会话已改变/);
    await assert.rejects(f.media.execute('resume', { mode: 'outgoing', sessionId: old.sessionId }), /会话已改变/);
    assert.equal((await f.media.execute('snapshot')).sessionId, current.sessionId);
    assert.equal(f.captures.at(-1).stopped, false);
});

test('listening after a stopped or disconnected outgoing session never inherits its sending route', async t => {
    for (const finish of ['stop', 'disconnect']) await t.test(finish, async t => {
        const f = await fixture({ devices: outgoingDevices(), mix: true }); t.after(() => f.media.execute('stop'));
        await f.media.execute('start', { mode: 'outgoing' });
        if (finish === 'stop') await f.media.execute('stop');
        else { f.sockets[0].close(); await drain(); }
        const listening = await f.media.execute('start', { useSystemAudio: true, useMicAudio: false, targetLanguage: 'zh' });
        assert.equal(listening.config.mode, 'listening');
        assert.equal(listening.config.targetLanguage, 'zh');
        assert.equal(listening.audioRouting.virtualOutputEnabled, false);
        assert.equal(listening.audioRouting.virtualOutputReady, false);
        assert.equal(listening.audioRouting.outgoingTargetLanguage, 'en');
    });
});

test('outgoing original gain is isolated through pause, stop, listening and reopening the owner', async t => {
    const f = await fixture({ devices: outgoingDevices(), mix: true, audioSettings: { originalGain: 0.63 } });
    t.after(() => f.media.execute('stop'));
    const started = await f.media.execute('start', { mode: 'outgoing' });
    assert.equal(started.audioRouting.originalGain, 0);
    assert.equal(f.bus.routing.originalGain, 0);
    assert.equal(f.saved.at(-1).originalGain, 0.63);
    const adjusted = await f.media.execute('set-audio-routing', { originalGain: 0.22 });
    assert.equal(adjusted.audioRouting.originalGain, 0.22);
    assert.equal(adjusted.audioRouting.outgoingOriginalGain, 0.22);
    assert.equal(f.saved.at(-1).originalGain, 0.63);
    assert.equal(f.saved.at(-1).outgoingOriginalGain, 0.22);
    const reopened = await fixture({ devices: outgoingDevices(), mix: true, audioSettings: f.saved.at(-1) });
    t.after(() => reopened.media.execute('stop'));
    assert.equal((await reopened.media.execute('snapshot')).audioRouting.originalGain, 0.63);
    assert.equal(reopened.bus.routing.originalGain, 0.63);
    await f.media.execute('pause');
    const resumed = await f.media.execute('resume');
    assert.equal(resumed.audioRouting.originalGain, 0.22);
    assert.equal(f.bus.routing.originalGain, 0.22);
    const stopped = await f.media.execute('stop');
    assert.equal(stopped.audioRouting.originalGain, 0.63);
    assert.equal(f.bus.routing.originalGain, 0.63);
    assert.equal(f.saved.at(-1).originalGain, 0.63);
    const listening = await f.media.execute('start', { useSystemAudio: true, useMicAudio: false });
    assert.equal(listening.audioRouting.originalGain, 0.63);
    await f.media.execute('set-audio-routing', { originalGain: 0.47 });
    assert.equal(f.saved.at(-1).originalGain, 0.47);
    assert.equal(f.saved.at(-1).outgoingOriginalGain, 0.22);
});

test('outgoing output failures and disconnects retain the saved listening original gain', async t => {
    for (const originalGain of [0, 0.63, 1]) await t.test(String(originalGain), async t => {
        const failed = await fixture({ devices: outgoingDevices(), mix: true, routeError: 'Render unavailable', audioSettings: { originalGain } });
        await assert.rejects(failed.media.execute('start', { mode: 'outgoing' }), /Render unavailable/);
        assert.equal((await failed.media.execute('snapshot')).audioRouting.originalGain, originalGain);
        assert.equal(failed.saved.at(-1).originalGain, originalGain);
        const f = await fixture({ devices: outgoingDevices(), mix: true, audioSettings: { originalGain } });
        t.after(() => f.media.execute('stop'));
        await f.media.execute('start', { mode: 'outgoing' });
        await f.media.execute('set-audio-routing', { originalGain: 0.18 });
        f.sockets[0].close(); await drain();
        assert.equal((await f.media.execute('snapshot')).audioRouting.originalGain, originalGain);
        const listening = await f.media.execute('start', { useSystemAudio: true, useMicAudio: false });
        assert.equal(listening.audioRouting.originalGain, originalGain);
        assert.equal(f.bus.routing.originalGain, originalGain);
        assert.equal(f.saved.at(-1).originalGain, originalGain);
    });
});
