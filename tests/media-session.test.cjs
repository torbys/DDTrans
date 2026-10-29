const test = require('node:test');
const assert = require('node:assert/strict');
const drain = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ systemAudio = true, failCapture = false } = {}) {
    const { createMediaSession } = await import('../app/js/media-session.js');
    const captures = [], players = [], sockets = [], requests = [];
    let captureFailure = failCapture;
    const media = createMediaSession({
        capabilities: { systemAudio },
        createCapture: async options => {
            if (captureFailure) { captureFailure = false; throw new Error('Permission denied'); }
            const capture = { options, stopped: false, paused: false, pause() { this.paused = true; }, resume() { this.paused = false; }, async stop() { this.stopped = true; } };
            captures.push(capture);
            return capture;
        },
        createPlayer: options => {
            const player = { options, chunks: [], stopped: false, volume: options.volume, append(bytes) { this.chunks.push(bytes); }, async stop() { this.stopped = true; }, setVolume(volume) { this.volume = volume; } };
            players.push(player);
            return player;
        },
        createSocket: () => {
            const socket = {
                readyState: 0,
                bufferedAmount: 0,
                frames: [],
                receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); },
                send(data) {
                    if (typeof data !== 'string') { this.frames.push(data); return; }
                    const request = JSON.parse(data);
                    requests.push(request);
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
    return { media, captures, players, sockets, requests };
}

const pcmAudio = { type: 'audio', audio: Buffer.from([1, 0, 2, 0]).toString('base64') };

test('media owner preserves final segments, direct TTS controls and capture frames', async t => {
    const f = await fixture();
    t.after(() => f.media.execute('stop'));
    await f.media.execute('start', { targetLanguage: 'zh', useSystemAudio: true, useMicAudio: false, audioEnabled: true });
    const ws = f.sockets[0];
    ws.receive({ type: 'segment', segment: { segment_key: 'first', sequence_order: 1, source_text: 'hello', target_text: '你好', status: 'final' } });
    ws.receive(pcmAudio);
    await drain();
    assert.equal(f.players.length, 1);
    await f.media.execute('set-volume', { volume: 0 });
    assert.equal(f.players[0].volume, 0);
    await f.media.execute('set-tts', { enabled: false });
    assert.equal(f.players[0].stopped, true);
    const pcm = new Int16Array([9, 1, 2, 9]).subarray(1, 3);
    f.captures[0].options.onFrame({ pcm });
    assert.deepEqual([...new Int16Array(ws.frames[0])], [1, 2]);
    const stopped = await f.media.execute('stop');
    assert.equal(stopped.phase, 'stopped');
    assert.equal(stopped.segments.at(-1).target_text, '最后一句');
});

test('target switch saves the old session and retains paused state', async t => {
    const f = await fixture();
    t.after(() => f.media.execute('stop'));
    const old = await f.media.execute('start', { targetLanguage: 'zh' });
    await f.media.execute('pause');
    const next = await f.media.execute('set-target', { targetLanguage: 'ja' });
    assert.notEqual(next.sessionId, old.sessionId);
    assert.equal(next.phase, 'paused');
    assert.deepEqual(next.segments, []);
    assert.deepEqual(f.requests.map(request => request.type), ['start', 'pause', 'stop', 'start', 'pause']);
});

test('capture failures leave a clean failed state and allow a new start', async t => {
    const f = await fixture({ failCapture: true });
    t.after(() => f.media.execute('stop'));
    await assert.rejects(f.media.execute('start'), /Permission denied/);
    assert.equal((await f.media.execute('snapshot')).phase, 'failed');
    const result = await f.media.execute('start');
    assert.equal(result.phase, 'running');
});

test('pause and resume release and rebuild capture while preserving the session', async t => {
    const f = await fixture();
    t.after(() => f.media.execute('stop'));
    const running = await f.media.execute('start');
    await f.media.execute('pause');
    assert.equal(f.captures[0].stopped, true);
    await f.media.execute('resume');
    assert.equal(f.captures.length, 2);
    assert.equal((await f.media.execute('snapshot')).sessionId, running.sessionId);
});

test('concurrent start and stop are serialized and lost connections release media', async t => {
    const f = await fixture();
    t.after(() => f.media.execute('stop'));
    const started = f.media.execute('start');
    const stopped = f.media.execute('stop');
    await started;
    assert.equal((await stopped).phase, 'stopped');
    await f.media.execute('start');
    f.sockets[1].receive(pcmAudio);
    f.sockets[1].close();
    assert.equal((await f.media.execute('snapshot')).phase, 'failed');
    await drain();
    assert.ok(f.captures.every(capture => capture.stopped));
    assert.ok(f.players.every(player => player.stopped));
});

test('stop flushes the final debounced note before model completion', async t => {
    const f = await fixture();
    t.after(() => f.media.execute('stop'));
    await f.media.execute('start');
    await f.media.execute('save-note', { content: 'first draft', defer: true });
    await f.media.execute('save-note', { content: 'last keystroke', defer: true });
    const result = await f.media.execute('stop');
    assert.equal(result.note, 'last keystroke');
    assert.deepEqual(f.requests.filter(request => request.type === 'note').map(request => request.content), ['last keystroke']);
});
