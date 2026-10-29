const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const WebSocket = require('ws');
const { startService } = require('../electron/service.js');

const ROOT = path.resolve(__dirname, '..');
const MODEL = 'qwen3.8-livetranslate-flash-realtime';

function makeGatewayFactory({ deferFinish = false } = {}) {
  const gateways = [];
  const factory = ({ onEvent }) => {
    let resolveFinish;
    const gateway = {
      metrics: { connect_ms: 1 },
      sentAudio: [],
      async connect() { return { model: MODEL }; },
      sendAudio(data) { gateway.sentAudio.push(Buffer.from(data)); },
      finish() {
        if (!deferFinish) {
          onEvent({ type: 'session.finished' });
          return Promise.resolve();
        }
        return new Promise(resolve => { resolveFinish = resolve; });
      },
      complete() {
        onEvent({ type: 'session.finished' });
        resolveFinish?.();
      },
      close() {},
      emit(event) { onEvent(event); },
    };
    gateways.push(gateway);
    return gateway;
  };
  return { factory, gateways };
}

async function startTemporaryService(t, gatewayOptions) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddtrans-service-'));
  const gateways = makeGatewayFactory(gatewayOptions);
  const service = await startService({ root: ROOT, dataDir, port: 0, model: MODEL, endpoint: 'wss://unused', apiKey: 'test' }, { gatewayFactory: gateways.factory });
  t.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { service, dataDir, ...gateways };
}

async function openClient(origin) {
  const ws = new WebSocket(origin.replace('http', 'ws') + '/ws/translate', { origin });
  const messages = [];
  const waiters = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  await once(ws, 'open');
  return {
    ws,
    messages,
    waitFor(predicate, timeout = 1500) {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error('Timed out waiting for service event'));
          }, timeout),
        };
        waiters.push(waiter);
      });
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      ws.close();
      await once(ws, 'close');
    },
  };
}

function sendJson(client, message) {
  client.ws.send(JSON.stringify(message));
}

async function waitFor(check, timeout = 1500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

test('serves health and session notes, rejects cross-origin requests, and protects active sessions', async (t) => {
  const { service } = await startTemporaryService(t);
  const health = await fetch(service.origin + '/api/health').then(response => response.json());
  assert.deepEqual(health, { ready: true, model: MODEL, active_sessions: 0 });

  const client = await openClient(service.origin);
  t.after(() => client.close());
  sendJson(client, { type: 'start', meeting_name: 'unsupported', transport: 'webrtc' });
  await client.waitFor(message => message.type === 'error' && message.message.includes('WebSocket'));
  assert.equal(service.store.listSessions({}).total, 0);
  sendJson(client, { type: 'start', meeting_name: 'active', target_language: 'en' });
  const ready = await client.waitFor(message => message.type === 'ready');
  const sessionId = ready.session_id;

  const blocked = await fetch(service.origin + `/api/sessions/${sessionId}`, { method: 'DELETE' });
  assert.equal(blocked.status, 409);
  const crossOrigin = await fetch(service.origin + '/api/health', { headers: { Origin: 'https://other.example' } });
  assert.equal(crossOrigin.status, 403);

  sendJson(client, { type: 'note', content: 'first note' });
  await client.waitFor(message => message.type === 'note_saved');
  const notes = await fetch(service.origin + `/api/sessions/${sessionId}/notes`).then(response => response.json());
  assert.equal(notes.notes[0].content, 'first note');
});

test('persists a fully associated source/target tail and readable WAV files only after model finish', async (t) => {
  const { service, gateways, dataDir } = await startTemporaryService(t, { deferFinish: true });
  const client = await openClient(service.origin);
  t.after(() => client.close());
  sendJson(client, { type: 'start', meeting_name: 'recording', target_language: 'en', audio_enabled: true });
  const ready = await client.waitFor(message => message.type === 'ready');
  const gateway = await waitFor(() => gateways[0]);

  client.ws.send(Buffer.from([1, 0, 2, 0]));
  await waitFor(() => gateway.sentAudio.length === 1);
  gateway.emit({ type: 'input_audio_buffer.speech_started', item_id: 'source-1', audio_start_ms: 0, speaker_id: 'speaker-7' });
  gateway.emit({ type: 'response.output_item.added', response_id: 'response-1', item: { id: 'target-1' } });
  gateway.emit({ type: 'conversation.item.created', previous_item_id: 'source-1', item: { id: 'target-1', type: 'message' } });
  gateway.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source-1', transcript: 'source text' });
  gateway.emit({ type: 'response.audio_transcript.done', response_id: 'response-1', item_id: 'target-1', transcript: 'target text' });
  gateway.emit({ type: 'response.audio.delta', response_id: 'response-1', item_id: 'target-1', delta: Buffer.from([3, 0]).toString('base64') });
  gateway.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed', output: [{ id: 'target-1', content: [{ type: 'audio', transcript: 'target text' }] }] } });
  gateway.emit({ type: 'response.audio.done', response_id: 'response-1', item_id: 'target-1' });

  sendJson(client, { type: 'stop' });
  await client.waitFor(message => message.type === 'state' && message.state === 'stopping');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.messages.some(message => message.type === 'stopped'), false);
  gateway.complete();
  const stopped = await client.waitFor(message => message.type === 'stopped');
  assert.equal(stopped.status, 'completed');

  const detail = await fetch(service.origin + `/api/sessions/${ready.session_id}`).then(response => response.json());
  assert.equal(detail.session.status, 'completed');
  assert.equal(JSON.parse(detail.session.accepted_config_json).model, MODEL);
  assert.deepEqual(JSON.parse(detail.session.metrics_json), { connect_ms: 1 });
  assert.deepEqual(JSON.parse(detail.session.usage_json), [{ response_id: 'response-1', status: 'completed', usage: {} }]);
  assert.equal(JSON.parse(detail.session.event_counts_json)['session.finished'], 1);
  assert.equal(detail.segments.length, 1);
  assert.equal(detail.segments[0].source_item_id, 'source-1');
  assert.equal(detail.segments[0].translation_item_id, 'target-1');
  assert.equal(detail.segments[0].speaker_id, 'speaker-7');
  assert.equal(detail.segments[0].status, 'final');

  const sourceWav = Buffer.from(await fetch(service.origin + `/api/sessions/${ready.session_id}/audio`).then(response => response.arrayBuffer()));
  const targetWav = Buffer.from(await fetch(service.origin + `/api/audio/${detail.segments[0].id}?type=tts`).then(response => response.arrayBuffer()));
  assert.equal(sourceWav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(targetWav.subarray(0, 4).toString(), 'RIFF');
  assert.ok(fs.existsSync(path.join(dataDir, 'media', 'sessions', String(ready.session_id), 'source.wav')));
});

test('disconnect saves an interrupted session and keeps parallel session records isolated', async (t) => {
  const { service, gateways } = await startTemporaryService(t);
  const first = await openClient(service.origin);
  const second = await openClient(service.origin);
  t.after(() => first.close());
  t.after(() => second.close());

  sendJson(first, { type: 'start', meeting_name: 'first', target_language: 'en' });
  sendJson(second, { type: 'start', meeting_name: 'second', target_language: 'en' });
  const [firstReady, secondReady] = await Promise.all([
    first.waitFor(message => message.type === 'ready'),
    second.waitFor(message => message.type === 'ready'),
  ]);
  const [firstGateway, secondGateway] = await waitFor(() => gateways.length === 2 && gateways);
  firstGateway.emit({ type: 'input_audio_buffer.speech_started', item_id: 'source-first' });
  firstGateway.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source-first', transcript: 'only first' });
  secondGateway.emit({ type: 'input_audio_buffer.speech_started', item_id: 'source-second' });
  secondGateway.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source-second', transcript: 'only second' });

  await first.close();
  await waitFor(() => service.store.getSession(firstReady.session_id)?.status === 'interrupted');
  const firstRows = service.store.getSegments(firstReady.session_id);
  const secondRows = service.store.getSegments(secondReady.session_id);
  assert.equal(firstRows[0].source_text, 'only first');
  assert.equal(firstRows[0].status, 'interrupted');
  assert.equal(secondRows[0].source_text, 'only second');
  assert.equal(secondRows[0].session_id, secondReady.session_id);
  assert.equal(secondRows.some(row => row.source_text === 'only first'), false);
});
