const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');

const { WebSocketServer } = require('ws');
const { createRealtimeGateway } = require('../electron/gateway.js');

const MODEL = 'qwen3.8-livetranslate-flash-realtime';

function requestedSession() {
  return {
    output_modalities: ['text'],
    audio: {
      input: { format: { type: 'pcm', sample_rate: 16000 }, turn_detection: { type: 'speaker_detection', threshold: 0.5, silence_duration_ms: 1000 } },
      output: { format: { type: 'pcm', sample_rate: 24000 } },
    },
    translation: { language: 'en', corpus: { phrases: { '测试': 'test' } } },
  };
}

function acceptedSession(session, model = MODEL) {
  return { ...session, model };
}

async function localServer(t, onConnection) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.on('connection', onConnection);
  return `ws://127.0.0.1:${server.address().port}`;
}

test('configures only the qwen 3.8 model and finish waits for session.finished', async (t) => {
  let serverSocket;
  let update;
  const endpoint = await localServer(t, socket => {
    serverSocket = socket;
    socket.send(JSON.stringify({ type: 'session.created' }));
    socket.once('message', raw => {
      update = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ type: 'session.updated', session: acceptedSession(update.session) }));
    });
  });
  const gateway = createRealtimeGateway({ endpoint, apiKey: 'test' });
  const session = requestedSession();

  const accepted = await gateway.connect(session);
  assert.deepEqual(update, { type: 'session.update', session });
  assert.equal(accepted.model, MODEL);

  let settled = false;
  const finishing = gateway.finish().then(() => { settled = true; });
  await once(serverSocket, 'message').then(([raw]) => assert.deepEqual(JSON.parse(raw.toString()), { type: 'session.finish' }));
  serverSocket.send(JSON.stringify({ type: 'response.done', response: { id: 'tail', status: 'completed' } }));
  serverSocket.send(JSON.stringify({ type: 'conversation.item.created', item: { id: 'tail' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  serverSocket.send(JSON.stringify({ type: 'session.finished' }));
  await finishing;
  gateway.close();
});

test('rejects nested server errors and rejects a session updated with another model', async (t) => {
  let connections = 0;
  const endpoint = await localServer(t, socket => {
    connections += 1;
    if (connections === 1) {
      socket.send(JSON.stringify({ type: 'error', error: { code: 'bad_request', message: 'nested model error' } }));
      return;
    }
    socket.send(JSON.stringify({ type: 'session.created' }));
    socket.once('message', raw => {
      const update = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ type: 'session.updated', session: acceptedSession(update.session, 'qwen3.7-livetranslate') }));
    });
  });

  const failures = [];
  const nestedError = createRealtimeGateway({ endpoint, apiKey: 'test', onFailure: error => failures.push(error) });
  await assert.rejects(nestedError.connect(requestedSession()), /nested model error/);
  assert.equal(failures[0].code, 'bad_request');
  nestedError.close();

  const wrongModel = createRealtimeGateway({ endpoint, apiKey: 'test' });
  await assert.rejects(wrongModel.connect(requestedSession()), /模型版本与请求不一致/);
  wrongModel.close();
});

test('rejects echoed requests when output, language, segmentation, or hotwords were ignored', async (t) => {
  const cases = [
    { change: session => { session.output_modalities = ['text', 'audio']; }, error: /输出模态/ },
    { change: session => { session.translation.language = 'zh'; }, error: /目标语言/ },
    { change: session => { session.audio.input.turn_detection.type = 'server_vad'; }, error: /说话人分段/ },
    { change: session => { session.translation.corpus.phrases = {}; }, error: /热词/ },
  ];
  let index = 0;
  const endpoint = await localServer(t, socket => {
    const current = cases[index++];
    socket.send(JSON.stringify({ type: 'session.created' }));
    socket.once('message', raw => {
      const session = acceptedSession(JSON.parse(raw).session);
      current.change(session);
      socket.send(JSON.stringify({ type: 'session.updated', session }));
    });
  });
  for (const current of cases) {
    const gateway = createRealtimeGateway({ endpoint, apiKey: 'test' });
    try { await assert.rejects(gateway.connect(requestedSession()), current.error); }
    finally { gateway.close(); }
  }
});
