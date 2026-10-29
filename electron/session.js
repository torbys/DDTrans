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
  const gateway = gatewayFactory({ endpoint: config.endpoint, apiKey: config.apiKey, transport: options.transport || 'websocket', onEvent: event => assembler.accept(event), onFailure: error => { failure ||= error; emit({ type: 'error', message: error.message, code: error.code }); if (state !== 'starting') void stop({ interrupted: true }); } });

  async function start() {
    emitState();
    try {
      const accepted = await gateway.connect(request);
      store.updateSessionTelemetry(record.id, { accepted_config: accepted, metrics: { ...gateway.metrics } });
      state = 'running';
      emit({ type: 'ready', session_id: record.id, model: config.model, transport: 'websocket', accepted, metrics: { ...gateway.metrics } });
      emitState();
    } catch (error) {
      if (!failure) { failure = error; emit({ type: 'error', message: error.message, code: error.code }); }
      await stop({ interrupted: true });
      throw error;
    }
  }
  function sendAudio(data) {
    if (state !== 'running' && state !== 'pausing') return;
    const bytes = Buffer.from(data);
    if (!bytes.length || bytes.length % 2 || bytes.length > 64000) throw new Error('输入必须为不超过2秒的16-bit PCM帧');
    gateway.sendAudio(bytes);
    raw.append(bytes);
    inputBytes += bytes.length;
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
    state = 'stopping';
    emitState();
    stopping = (async () => {
      try { if (!failure) await gateway.finish(); } catch (error) { failure ||= error; }
      try {
        assembler.finalize();
        raw.close();
        for (const audio of tts.values()) audio.writer.close();
        const partial = assembler.rows().some(row => row.status !== 'final');
        const status = failure ? (inputBytes ? 'interrupted' : 'failed') : interrupted || partial ? 'interrupted' : 'completed';
        store.updateSessionTelemetry(record.id, { metrics: { ...gateway.metrics }, usage: [...usage.values()], event_counts: { ...assembler.counts } });
        const saved = store.finishSession(record.id, status, failure?.message || (partial ? '部分结果未完整返回，已保留收到的内容' : null));
        state = 'stopped';
        emit({ type: 'stopped', session_id: record.id, status: saved.status, partial, metrics: { ...gateway.metrics }, event_counts: { ...assembler.counts }, warnings });
        emitState();
        return saved;
      } finally { gateway.close(); }
    })();
    return stopping;
  }
  return { start, sendAudio, pause, resume, saveNote, stop, get id() { return record.id; }, get state() { return state; } };
}
module.exports = { createTranslationSession };
