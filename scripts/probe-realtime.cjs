const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const WebSocket = require('ws');

function readPcm16(file) {
  const wav = fs.readFileSync(file);
  if (wav.toString('ascii', 0, 4) !== 'RIFF') return wav;
  let offset = 12;
  let format;
  while (offset + 8 <= wav.length) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (tag === 'fmt ') format = { codec: wav.readUInt16LE(offset + 8), channels: wav.readUInt16LE(offset + 10), sampleRate: wav.readUInt32LE(offset + 12), bits: wav.readUInt16LE(offset + 22) };
    if (tag === 'data') {
      if (!format || format.codec !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16) throw new Error('测试音频须为16kHz、单声道、16-bit PCM WAV');
      return wav.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV缺少data块');
}

function redact(event) {
  const value = structuredClone(event);
  for (const key of ['audio', 'delta']) {
    if (typeof value[key] === 'string' && (key === 'audio' || value.type === 'response.audio.delta')) {
      const bytes = Buffer.from(value[key], 'base64');
      value[key] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    }
  }
  return value;
}

async function runProbe({ url, apiKey, session, pcm = Buffer.alloc(0), logFile, timeoutMs = 60000 }) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const events = [];
  const result = { endpoint: url, requested: session, timings_ms: {}, counts: {}, speakers: [], source: [], translation: [], errors: [], input_bytes: pcm.length, output_audio_bytes: 0 };
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + apiKey }, handshakeTimeout: 15000 });
  let sendTask;
  let configured = false;
  let finished = false;
  const log = (direction, event) => events.push({ at_ms: elapsed(), direction, event: redact(event) });
  const send = (event) => { log('send', event); ws.send(JSON.stringify(event)); };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('probe timeout')); ws.terminate(); }, timeoutMs);
      const cleanup = () => clearTimeout(timer);
      ws.on('open', () => { result.timings_ms.connected = elapsed(); });
      ws.on('error', (error) => { cleanup(); reject(error); });
      ws.on('unexpected-response', (req, response) => { cleanup(); reject(new Error('HTTP ' + response.statusCode)); });
      ws.on('close', (code, reason) => {
        result.close = { code, reason: reason.toString() };
        if (!finished) { cleanup(); reject(new Error('closed before session.finished: ' + code + ' ' + reason)); }
      });
      ws.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        log('recv', event);
        result.counts[event.type] = (result.counts[event.type] || 0) + 1;
        if (event.type === 'session.created') {
          result.created = event.session;
          result.timings_ms.created = elapsed();
          send({ type: 'session.update', session });
        } else if (event.type === 'session.updated' && !configured) {
          configured = true;
          result.updated = event.session;
          result.timings_ms.configured = elapsed();
          sendTask = (async () => {
            const audioStart = performance.now();
            for (let offset = 0; offset < pcm.length; offset += 3200) {
              if (ws.readyState !== WebSocket.OPEN) return;
              send({ type: 'input_audio_buffer.append', audio: pcm.subarray(offset, offset + 3200).toString('base64') });
              const delay = audioStart + (offset + 3200) / 32 - performance.now();
              if (delay > 0) await new Promise(r => setTimeout(r, delay));
            }
            if (ws.readyState === WebSocket.OPEN) send({ type: 'session.finish' });
          })().catch(reject);
        } else if (event.type === 'input_audio_buffer.speech_started') {
          if (event.speaker_id !== undefined && !result.speakers.includes(event.speaker_id)) result.speakers.push(event.speaker_id);
        } else if (event.type === 'conversation.item.input_audio_transcription.delta') {
          result.timings_ms.first_source ??= elapsed();
        } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
          result.source.push({ item_id: event.item_id, transcript: event.transcript, language: event.language });
        } else if (['response.text.delta', 'response.audio_transcript.delta'].includes(event.type)) {
          result.timings_ms.first_translation ??= elapsed();
        } else if (['response.text.done', 'response.audio_transcript.done'].includes(event.type)) {
          result.translation.push({ item_id: event.item_id, text: event.text ?? event.transcript });
        } else if (event.type === 'response.audio.delta') {
          result.timings_ms.first_audio ??= elapsed();
          result.output_audio_bytes += Buffer.from(event.delta, 'base64').length;
        } else if (event.type === 'error') {
          result.errors.push(event.error || event);
          if (!configured) { finished = true; cleanup(); ws.close(); resolve(); }
        } else if (event.type === 'session.finished') {
          result.timings_ms.finished = elapsed();
          finished = true;
          cleanup();
          ws.close();
          resolve();
        }
      });
    });
    if (sendTask) await sendTask;
  } catch (error) {
    result.failure = error.message;
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    result.duration_ms = elapsed();
    if (logFile) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, JSON.stringify({ result, events }, null, 2));
    }
  }
  return result;
}

module.exports = { runProbe, readPcm16, redact };

if (require.main === module) {
  process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
  const argv = process.argv.slice(2);
  const value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const session = value('--config') ? JSON.parse(fs.readFileSync(value('--config'), 'utf8')) : { output_modalities: argv.includes('--audio-output') ? ['text', 'audio'] : ['text'], translation: { language: value('--target') || 'zh' }, audio: { input: { turn_detection: { type: 'speaker_detection' } } } };
  runProbe({ url: process.env.QWEN_WS_URL, apiKey: process.env.DASHSCOPE_API_KEY, session, pcm: value('--input') ? readPcm16(value('--input')) : Buffer.alloc(0), logFile: value('--out') || path.resolve(__dirname, '..', 'data', 'probes', 'latest.json') }).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.failure || result.errors.length) process.exitCode = 1;
  });
}
