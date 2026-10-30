const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../electron/store');
const { createTranslationSession } = require('../electron/session');
const { connectionError } = require('../electron/connection-errors');
const { validateEndpoint, MODEL } = require('../electron/config');

function fixture(t, failConnections = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddtrans-recovery-'));
  const store = createStore({ dbPath: path.join(dataDir, 'translation.db'), mediaDir: path.join(dataDir, 'media') });
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const gateways = [], events = [];
  const session = createTranslationSession({
    options: { meeting_name: 'recovery', target_language: 'en' },
    config: { dataDir, model: MODEL, endpoint: 'wss://test.invalid', apiKey: 'test' },
    store, emit: event => events.push(event),
    gatewayFactory({ onEvent, onFailure }) {
      const index = gateways.length;
      const gateway = { metrics: {}, sent: [], closed: false,
        async connect() { if (failConnections[index]) throw failConnections[index]; return { model: MODEL }; },
        sendAudio(data) { gateway.sent.push(Buffer.from(data)); },
        async finish() { onEvent({ type: 'session.finished' }); },
        close() { gateway.closed = true; }, emit: onEvent, fail: onFailure,
      };
      gateways.push(gateway); return gateway;
    },
  });
  return { session, store, gateways, events, dataDir };
}
async function until(check, timeout = 3500) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('Recovery did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('normalizes a workspace Base URL without changing the selected model', () => {
  assert.equal(validateEndpoint('https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'), 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=' + MODEL);
  assert.throws(() => validateEndpoint('https://workspace.test/compatible-mode/v1?model=another-model'), /qwen3.8/);
  assert.throws(() => validateEndpoint('wss://secret:password@workspace.test/realtime?model=' + MODEL), /用户名/);
});


test('reconnect preserves one record, saves gap audio, and isolates repeated provider IDs and timestamps', async t => {
  const f = fixture(t);
  await f.session.start();
  f.session.sendAudio(Buffer.alloc(3200, 1));
  f.gateways[0].emit({ type: 'input_audio_buffer.speech_started', item_id: 'same-id', audio_start_ms: 0, speaker_id: '0' });
  f.gateways[0].emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'same-id', delta: 'before' });
  f.gateways[0].fail(connectionError({ message: 'network interrupted' }));
  assert.equal(f.session.state, 'reconnecting');
  f.session.sendAudio(Buffer.alloc(3200, 2));
  await until(() => f.gateways.length === 2 && f.session.state === 'running');
  const next = f.gateways[1];
  assert.equal(next.sent.length, 0, 'Gap audio must not be replayed');
  f.session.sendAudio(Buffer.alloc(3200, 3));
  next.emit({ type: 'input_audio_buffer.speech_started', item_id: 'same-id', audio_start_ms: 0, speaker_id: '0' });
  next.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'same-id', transcript: 'after' });
  next.emit({ type: 'conversation.item.created', previous_item_id: 'same-id', item: { id: 'target' } });
  next.emit({ type: 'response.text.done', item_id: 'target', response_id: 'response', text: 'translated' });
  next.emit({ type: 'response.done', response: { id: 'response', status: 'completed' } });
  const saved = await f.session.stop();
  const rows = f.store.getSegments(f.session.id);
  assert.equal(saved.status, 'interrupted');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.source_text), ['before', 'after']);
  assert.deepEqual(rows.map(row => row.status), ['interrupted', 'final']);
  assert.equal(rows[1].start_ms, 200);
  assert.notEqual(rows[0].speaker_id, rows[1].speaker_id);
  assert.equal(next.sent.length, 1);
  const metrics = JSON.parse(f.store.getSession(f.session.id).metrics_json);
  assert.deepEqual(metrics.gaps, [{ start_ms: 100, end_ms: 200, reason: 'network_error' }]);
  assert.equal(metrics.reconnect_attempts, 1);
  assert.equal(fs.statSync(path.join(f.dataDir, 'media', 'sessions', String(f.session.id), 'source.wav')).size, 44 + 9600);
});

test('authentication failures terminate once and never reconnect', async t => {
  const f = fixture(t, [connectionError({ status: 401 })]);
  await assert.rejects(f.session.start(), /API Key 验证失败/);
  assert.equal(f.gateways.length, 1);
  assert.equal(f.events.filter(event => event.type === 'error').length, 1);
  assert.equal(f.store.getSession(f.session.id).status, 'failed');
  assert.equal(f.events.find(event => event.type === 'stopped').code, 'authentication_failed');
});

test('stop cancels a scheduled reconnect and completes without waiting for a new connection', async t => {
  const f = fixture(t);
  await f.session.start();
  f.gateways[0].fail(connectionError());
  const start = Date.now();
  await f.session.stop();
  assert.ok(Date.now() - start < 200);
  assert.equal(f.session.state, 'stopped');
  assert.equal(f.gateways.length, 1);
});

test('transient failures use at most two retries and keep a readable interrupted record', async t => {
  const f = fixture(t, [null, connectionError(), connectionError()]);
  await f.session.start();
  f.session.sendAudio(Buffer.alloc(3200));
  f.gateways[0].fail(connectionError());
  await until(() => f.session.state === 'stopped');
  assert.equal(f.gateways.length, 3);
  assert.equal(f.events.filter(event => event.type === 'error').length, 1);
  assert.equal(f.store.getSession(f.session.id).status, 'interrupted');
});
