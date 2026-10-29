const WebSocket = require('ws');
const { performance } = require('node:perf_hooks');

function createRealtimeGateway({ endpoint, apiKey, transport = 'websocket', onEvent = () => {}, onFailure = () => {} }) {
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
  let rejectConnect;
  let connectTimer;
  const metrics = {};
  const origin = performance.now();
  const elapsed = () => Math.round(performance.now() - origin);
  const send = (event) => {
    if (ws?.readyState !== WebSocket.OPEN) throw new Error('模型连接已断开');
    if (ws.bufferedAmount > 128 * 1024) throw new Error('模型发送队列超过4秒音频，已停止以避免延迟持续累积');
    ws.send(JSON.stringify(event));
  };
  function fail(error) {
    clearTimeout(connectTimer);
    clearTimeout(finishTimer);
    rejectConnect?.(error);
    rejectFinish?.(error);
    if (!closing) onFailure(error);
  }
  async function connect(session) {
    if (!apiKey) throw new Error('DASHSCOPE_API_KEY 未设置');
    return new Promise((resolve, reject) => {
      rejectConnect = reject;
      connectTimer = setTimeout(() => fail(new Error('模型会话配置超时')), 20000);
      ws = new WebSocket(endpoint, { headers: { Authorization: 'Bearer ' + apiKey }, handshakeTimeout: 15000, maxPayload: 8 * 1024 * 1024 });
      ws.on('open', () => {
        metrics.connect_ms = elapsed();
        heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 15000);
        heartbeat.unref();
      });
      ws.on('unexpected-response', (request, response) => { fail(new Error('模型握手失败：HTTP ' + response.statusCode)); ws.terminate(); });
      ws.on('error', fail);
      ws.on('close', (code, reason) => {
        clearInterval(heartbeat);
        if (!closing && !finished) fail(new Error('模型连接提前关闭：' + code + ' ' + reason.toString()));
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
            const error = new Error(details.message || '模型返回错误');
            error.code = details.code;
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
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    else if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
  }
  return { connect, sendAudio, finish, close, metrics };
}
module.exports = { createRealtimeGateway };
