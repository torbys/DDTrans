const test = require('node:test');
const assert = require('node:assert/strict');
const drain = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ isolated = true, systemAudio = true, failCapture = false, audioSettings = {}, failSave = false, devices } = {}) {
    const { createMediaSession } = await import('../app/js/media-session.js');
    const events = [], captures = [], players = [], sockets = [], requests = [], saved = [];
    let captureFailure = failCapture;
    const media = createMediaSession({
        capabilities: { systemAudio, isolatedTts: isolated },
        audioSettings,
        saveAudioSettings: async next => { if (failSave) throw new Error('Disk full'); saved.push({ ...next }); },
        ...(devices ? { enumerateDevices: async () => devices } : {}),
        publish: event => events.push(event),
        createCapture: async options => {
            if (captureFailure) { captureFailure = false; throw new Error('Permission denied'); }
            const capture = { options, stopped: false, paused: false, isolatedSystemAudio: isolated,
                pause() { this.paused = true; }, resume() { this.paused = false; }, async stop() { this.stopped = true; } };
            captures.push(capture); return capture;
        },
        createPlayer: options => {
            const player = { options, chunks: [], stopped: false, volume: options.volume,
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
    return { media, events, captures, players, sockets, requests, saved };
}
const pcmAudio = { type: 'audio', audio: Buffer.from([1, 0, 2, 0]).toString('base64'), sample_rate: 24000 };

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
