const path = require('node:path');
const crypto = require('node:crypto');
const { buildSessionConfig } = require('./config');
const { createRealtimeGateway } = require('./gateway');
const { createSegmentAssembler } = require('./segments');
const { createPcmWriter } = require('./pcm-writer');

function createTranslationSession({ options, config, store, emit, gatewayFactory = createRealtimeGateway }) {
  if (options.transport && options.transport !== 'websocket') throw new Error('当前版本仅支持 WebSocket，其他协议尚未接入');
  const request = buildSessionConfig(options);
  const record = store.createSession({ name: (options.meeting_name || '同传 ' + new Date().toLocaleString('zh-CN')).trim().slice(0, 200), source_lang: 'auto', target_lang: request.translation.language, model: config.model, transport: options.transport || 'websocket', config: request });
  const directory = 'sessions/' + record.id;
  const rawPath = directory + '/source.wav';
  const raw = createPcmWriter(path.join(config.dataDir, 'media', rawPath), 16000);
  store.setSessionAudio(record.id, rawPath);
  const tts = new Map();
  let state = 'starting';
  let stopping;
  let failure;
  let noteId;
  let inputBytes = 0;
  let epoch = 0;
  let connectionOffset = 0;
  let reconnectAttempts = 0;
  let cancelRetry = () => {};
  let hadInterruption = false;
  const connections = [];
  const gaps = [];
  const usage = new Map();
  const warnings = [];
  const emitState = () => emit({ type: 'state', state, session_id: record.id });
  const assembler = createSegmentAssembler({
    audioEnabled: request.output_modalities.includes('audio'),
    onSegment(row) {
      const audio = tts.get(row.segment_key);
      if (audio && row.audio_done) audio.writer.close();
      const saved = store.upsertSegment(record.id, { ...row, raw_audio_path: rawPath, tts_audio_path: audio?.path || null, raw_duration_ms: row.start_ms != null && row.end_ms != null ? Math.max(0, row.end_ms - row.start_ms) : 0, tts_duration_ms: audio ? Math.round(audio.writer.durationMs) : 0 });
      emit({ type: 'segment', segment: saved });
    },
    onAudio(key, bytes) {
      if (!tts.has(key)) {
        const audioPath = directory + '/' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 20) + '.wav';
        tts.set(key, { path: audioPath, writer: createPcmWriter(path.join(config.dataDir, 'media', audioPath), 24000) });
        store.upsertSegment(record.id, { segment_key: key, tts_audio_path: audioPath });
      }
      tts.get(key).writer.append(bytes);
      emit({ type: 'audio', segment_key: key, audio: bytes.toString('base64'), sample_rate: 24000 });
    },
    onUsage(event) {
      usage.set(event.response_id, event);
      store.updateSessionTelemetry(record.id, { usage: [...usage.values()] });
      emit({ type: 'usage', ...event });
    },
    onWarning(message) { warnings.push(message); emit({ type: 'warning', message }); },
  });
  function reportFailure(error) {
    failure ||= error;
    error.reported = true;
    emit({ type: 'error', message: error.message, code: error.code });
  }
  function onFailure(error) {
    if (['stopping', 'stopped', 'reconnecting'].includes(state)) return;
    if (state !== 'starting' && error.retryable && reconnectAttempts < 2) {
      void recover(error);
      return;
    }
    reportFailure(error);
    if (state !== 'starting') void stop({ interrupted: true });
  }
  function makeGateway() {
    const currentEpoch = epoch;
    const prefix = id => id == null ? id : 'reconnect-' + currentEpoch + ':' + id;
    return gatewayFactory({
      endpoint: config.endpoint, apiKey: config.apiKey, transport: options.transport || 'websocket',
      connectTimeoutMs: currentEpoch ? 8000 : 20000,
      onFailure: error => { if (currentEpoch === epoch) onFailure(error); },
      onEvent(event) {
        if (currentEpoch !== epoch) return;
        if (!currentEpoch) { assembler.accept(event); return; }
        const next = { ...event };
        for (const key of ['event_id', 'item_id', 'previous_item_id', 'response_id']) if (next[key] != null) next[key] = prefix(next[key]);
        if (next.speaker_id != null) next.speaker_id = (currentEpoch + 1) + '-' + next.speaker_id;
        for (const key of ['audio_start_ms', 'audio_end_ms']) if (next[key] != null) next[key] += connectionOffset;
        if (next.item) next.item = { ...next.item, id: prefix(next.item.id) };
        if (next.response) next.response = { ...next.response, id: prefix(next.response.id), output: next.response.output?.map(item => ({ ...item, id: prefix(item.id) })) };
        assembler.accept(next);
      },
    });
  }
  let gateway = makeGateway();
  const metrics = () => ({ ...gateway.metrics, reconnect_attempts: reconnectAttempts, connections, gaps });
  function acceptedConnection(accepted) {
    connectionOffset = Math.round(inputBytes / 32);
    connections.push({ epoch, offset_ms: Math.round(inputBytes / 32), metrics: { ...gateway.metrics } });
    store.updateSessionTelemetry(record.id, { accepted_config: accepted, metrics: metrics() });
  }
  async function recover(error) {
    const resumeState = ['paused', 'pausing'].includes(state) ? 'paused' : 'running';
    hadInterruption = true;
    gateway.close();
    assembler.finalize();
    const gap = { start_ms: Math.round(inputBytes / 32), reason: error.code || 'network_error' };
    gaps.push(gap);
    state = 'reconnecting';
    emitState();
    let lastError = error;
    while (reconnectAttempts < 2 && state === 'reconnecting') {
      reconnectAttempts++;
      emit({ type: 'warning', message: '网络连接中断，正在重连（' + reconnectAttempts + '/2）。本地录音继续保存，这段声音不会补发。' });
      await new Promise(resolve => {
        const timer = setTimeout(resolve, reconnectAttempts === 1 ? 500 : 1500);
        cancelRetry = () => { clearTimeout(timer); resolve(); };
      });
      if (state !== 'reconnecting') break;
      epoch++;
      gateway = makeGateway();
      try {
        const accepted = await gateway.connect(request);
        if (state !== 'reconnecting') { gateway.close(); break; }
        gap.end_ms = Math.round(inputBytes / 32);
        acceptedConnection(accepted);
        state = resumeState;
        emitState();
        emit({ type: 'warning', message: '连接已恢复。中断前的字幕和录音已保存；说话人编号从本次连接重新识别。' });
        return;
      } catch (nextError) {
        lastError = nextError;
        gateway.close();
        if (!nextError.retryable) break;
      }
    }
    gap.end_ms = Math.round(inputBytes / 32);
    if (state === 'reconnecting') {
      reportFailure(lastError);
      await stop({ interrupted: true });
    }
  }

  async function start() {
    emitState();
    try {
      const accepted = await gateway.connect(request);
      acceptedConnection(accepted);
      state = 'running';
      emit({ type: 'ready', session_id: record.id, model: config.model, transport: 'websocket', accepted, metrics: { ...gateway.metrics } });
      emitState();
    } catch (error) {
      if (!failure) reportFailure(error);
      await stop({ interrupted: true });
      throw error;
    }
  }
  function sendAudio(data) {
    if (!['running', 'pausing', 'reconnecting'].includes(state)) return;
    const bytes = Buffer.from(data);
    if (!bytes.length || bytes.length % 2 || bytes.length > 64000) throw new Error('输入必须为不超过2秒的16-bit PCM帧');
    raw.append(bytes);
    inputBytes += bytes.length;
    if (state !== 'reconnecting') {
      try { gateway.sendAudio(bytes); }
      catch (error) { onFailure(error); }
    }
  }
  async function pause() {
    if (state !== 'running') throw new Error('当前会话不能暂停');
    state = 'pausing';
    emitState();
    for (let i = 0; i < 12 && state === 'pausing'; i++) {
      sendAudio(Buffer.alloc(3200));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (state !== 'pausing') return;
    state = 'paused';
    emitState();
  }
  function resume() {
    if (state !== 'paused') throw new Error('当前会话不能恢复');
    state = 'running';
    emitState();
  }
  function saveNote(content) {
    if (typeof content !== 'string' || content.length > 20000) throw new Error('笔记最多20000字');
    if (!content.trim()) {
      if (noteId) store.deleteNote(record.id, noteId);
      noteId = undefined;
    } else {
      noteId = store.saveNote(record.id, content, noteId).id;
    }
    emit({ type: 'note_saved', note_id: noteId || null });
  }
  function stop({ interrupted = false } = {}) {
    if (stopping) return stopping;
    const reconnecting = state === 'reconnecting';
    state = 'stopping';
    emitState();
    cancelRetry();
    if (reconnecting) gateway.close();
    stopping = (async () => {
      try { if (!failure && !reconnecting) await gateway.finish(); } catch (error) { failure ||= error; }
      try {
        assembler.finalize();
        raw.close();
        for (const audio of tts.values()) audio.writer.close();
        const partial = assembler.rows().some(row => row.status !== 'final');
        const status = failure ? (inputBytes ? 'interrupted' : 'failed') : interrupted || partial || hadInterruption ? 'interrupted' : 'completed';
        for (const gap of gaps) gap.end_ms ??= Math.round(inputBytes / 32);
        store.updateSessionTelemetry(record.id, { metrics: metrics(), usage: [...usage.values()], event_counts: { ...assembler.counts } });
        const saved = store.finishSession(record.id, status, failure?.message || (hadInterruption ? '网络曾中断，间断音频仅保存在本地，未送往模型翻译' : partial ? '部分结果未完整返回，已保留收到的内容' : null));
        state = 'stopped';
        emit({ type: 'stopped', session_id: record.id, status: saved.status, partial, error: failure?.message, code: failure?.code, metrics: metrics(), event_counts: { ...assembler.counts }, warnings });
        emitState();
        return saved;
      } finally { gateway.close(); }
    })();
    return stopping;
  }
  return { start, sendAudio, pause, resume, saveNote, stop, get id() { return record.id; }, get state() { return state; } };
}
module.exports = { createTranslationSession };
