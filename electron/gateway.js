const WebSocket = require('ws');
const { performance } = require('node:perf_hooks');
const { connectionError } = require('./connection-errors');

function createRealtimeGateway({ endpoint, apiKey, transport = 'websocket', connectTimeoutMs = 20000, onEvent = () => {}, onFailure = () => {} }) {
  if (transport !== 'websocket') throw new Error('当前已实现的传输方式为 WebSocket');
  let ws;
  let connected = false;
  let closing = false;
  let finished = false;
  let finishing;
  let resolveFinish;
  let rejectFinish;
  let finishTimer;
  let heartbeat;
  let lastPong = Date.now();
  let rejectConnect;
  let connectTimer;
  let failure;
  const metrics = {};
  const origin = performance.now();
  const elapsed = () => Math.round(performance.now() - origin);
  const send = (event) => {
    if (ws?.readyState !== WebSocket.OPEN) throw new Error('模型连接已断开');
    if (ws.bufferedAmount > 128 * 1024) throw new Error('模型发送队列超过4秒音频，已停止以避免延迟持续累积');
    ws.send(JSON.stringify(event));
  };
  function fail(error) {
    if (failure || closing || finished) return;
    failure = error;
    connected = false;
    clearTimeout(connectTimer);
    clearTimeout(finishTimer);
    clearInterval(heartbeat);
    rejectConnect?.(error);
    rejectFinish?.(error);
    ws?.terminate();
    onFailure(error);
  }
  async function connect(session) {
    if (!apiKey) throw new Error('未配置 API Key，请打开翻译服务配置后保存');
    return new Promise((resolve, reject) => {
      rejectConnect = reject;
      connectTimer = setTimeout(() => fail(connectionError({ code: 'connection_timeout', message: '模型连接或会话配置超时' })), connectTimeoutMs);
      ws = new WebSocket(endpoint, { headers: { Authorization: 'Bearer ' + apiKey }, handshakeTimeout: Math.min(15000, connectTimeoutMs), maxPayload: 8 * 1024 * 1024 });
      ws.on('open', () => {
        metrics.connect_ms = elapsed();
        lastPong = Date.now();
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > 30000) fail(connectionError({ message: '模型网络心跳超时' }));
          else if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 15000);
        heartbeat.unref();
      });
      ws.on('pong', () => { lastPong = Date.now(); });
      ws.on('unexpected-response', (request, response) => {
        response.resume();
        fail(connectionError({ status: response.statusCode, requestId: response.headers['x-request-id'] || response.headers['x-dashscope-request-id'] }));
      });
      ws.on('error', error => fail(connectionError({ message: error.message.replaceAll(apiKey, '[redacted]') })));
      ws.on('close', (code, reason) => {
        clearInterval(heartbeat);
        if (!closing && !finished) fail(connectionError({ code: [1000, 1008, 1009].includes(code) ? 'session_closed' : 'network_error', message: '模型连接已关闭（' + code + '）' }));
      });
      ws.on('message', raw => {
        try {
          const event = JSON.parse(raw.toString());
          if (event.type === 'session.created') send({ type: 'session.update', session });
          if (event.type === 'session.updated' && !connected) {
            const accepted = event.session;
            if (accepted?.model !== 'qwen3.8-livetranslate-flash-realtime') throw new Error('返回的模型版本与请求不一致');
            if (JSON.stringify(accepted.output_modalities) !== JSON.stringify(session.output_modalities)) throw new Error('服务端未接受请求的输出模态');
            if (accepted.translation?.language !== session.translation.language) throw new Error('服务端未接受目标语言');
            const requestedTurn = session.audio.input.turn_detection;
            if (requestedTurn && Object.entries(requestedTurn).some(([key, value]) => accepted.audio?.input?.turn_detection?.[key] !== value)) throw new Error('服务端未接受说话人分段配置');
            const phrases = session.translation.corpus?.phrases;
            if (phrases && Object.entries(phrases).some(([key, value]) => accepted.translation.corpus?.phrases?.[key] !== value)) throw new Error('服务端未接受热词配置');
            const input = accepted.audio?.input?.format;
            const output = accepted.audio?.output?.format;
            if (input?.sample_rate !== 16000 || output?.sample_rate !== 24000 || input.type !== 'pcm' || output.type !== 'pcm') throw new Error('服务端音频格式与采集/播放设置不一致');
            connected = true;
            metrics.configure_ms = elapsed();
            clearTimeout(connectTimer);
            rejectConnect = null;
            resolve(accepted);
          }
          if (event.type === 'error') {
            const details = event.error || event;
            const error = connectionError({ code: details.code || 'model_error', message: String(details.message || '模型返回错误').replaceAll(apiKey, '[redacted]') });
            onEvent(event);
            fail(error);
            return;
          }
          if (event.type === 'conversation.item.input_audio_transcription.delta') metrics.first_source_ms ??= elapsed();
          if (['response.text.delta', 'response.audio_transcript.delta'].includes(event.type)) metrics.first_translation_ms ??= elapsed();
          if (event.type === 'response.audio.delta') metrics.first_audio_ms ??= elapsed();
          onEvent(event);
          if (event.type === 'session.finished') {
            finished = true;
            metrics.finish_ms = elapsed();
            clearTimeout(finishTimer);
            resolveFinish?.();
          }
        } catch (error) { fail(error); }
      });
    });
  }
  function sendAudio(pcm) {
    if (!connected || finishing) throw new Error('模型会话未处于采集状态');
    send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') });
  }
  function finish() {
    if (failure) return Promise.reject(failure);
    if (finishing) return finishing;
    if (finished) return Promise.resolve();
    finishing = new Promise((resolve, reject) => {
      resolveFinish = resolve;
      rejectFinish = reject;
      finishTimer = setTimeout(() => fail(new Error('等待模型尾段完成超时，已保留已收到的数据')), 30000);
      try { send({ type: 'session.finish' }); } catch (error) { fail(error); }
    });
    return finishing;
  }
  function close() {
    closing = true;
    clearTimeout(connectTimer);
    clearTimeout(finishTimer);
    clearInterval(heartbeat);
    const cancelled = new Error('模型连接已取消');
    rejectConnect?.(cancelled);
    rejectFinish?.(cancelled);
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    else if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
  }
  return { connect, sendAudio, finish, close, metrics };
}
async function testRealtimeConnection(config) {
  const { buildSessionConfig } = require('./config');
  const gateway = createRealtimeGateway(config);
  try {
    const accepted = await gateway.connect(buildSessionConfig({ target_language: 'en' }));
    return { model: accepted.model, metrics: { ...gateway.metrics } };
  } finally { gateway.close(); }
}
module.exports = { createRealtimeGateway, testRealtimeConnection };
