const fs = require('node:fs');
const path = require('node:path');

const LANGUAGES = new Set('zh en ja ko fr de es pt ru ar it id vi th tr hi ms nl ur nb sv da he fi pl is cs fil fa yue el af ast be bg bn bs ca ceb et gl gu hr hu jv kk kn ky lv mk ml mr pa ro sk sl sw tg az uk'.split(' '));
const TEXT_ONLY = new Set('yue el af ast be bg bn bs ca ceb et gl gu hr hu jv kk kn ky lv mk ml mr pa ro sk sl sw tg az uk'.split(' '));

function loadConfig(root = path.resolve(__dirname, '..')) {
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const model = 'qwen3.8-livetranslate-flash-realtime';
  const endpoint = process.env.QWEN_WS_URL;
  if (!endpoint) throw new Error('请在 .env 中配置 QWEN_WS_URL');
  const url = new URL(endpoint);
  if (url.protocol !== 'wss:' || url.searchParams.get('model') !== model) throw new Error('QWEN_WS_URL 必须为 qwen3.8 的 wss 实时地址');
  const port = Number(process.env.SERVER_PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('SERVER_PORT 必须是 0–65535');
  return { root, model, endpoint: url.href, apiKey: process.env.DASHSCOPE_API_KEY || '', port, dataDir: process.env.DDTRANS_DATA_DIR ? path.resolve(process.env.DDTRANS_DATA_DIR) : path.join(root, 'data') };
}

function buildSessionConfig(options = {}) {
  const language = options.target_language || 'zh';
  if (!LANGUAGES.has(language)) throw new Error('不支持的目标语言');
  const audioEnabled = Boolean(options.audio_enabled);
  if (audioEnabled && TEXT_ONLY.has(language)) throw new Error('该目标语言仅支持文字输出');
  const phrases = options.corpus?.phrases || {};
  if (!phrases || Array.isArray(phrases) || typeof phrases !== 'object' || Object.keys(phrases).length > 1000) throw new Error('热词必须是最多1000项的原文到译文映射');
  const corpus = {};
  for (const [source, target] of Object.entries(phrases)) {
    if (!source.trim() || typeof target !== 'string' || !target.trim() || source.length > 500 || target.length > 500) throw new Error('热词原文和译文不能为空，且每项最多500字');
    corpus[source.trim()] = target.trim();
  }
  const session = {
    output_modalities: audioEnabled ? ['text', 'audio'] : ['text'],
    audio: {
      input: { format: { type: 'pcm', sample_rate: 16000 }, turn_detection: { type: 'speaker_detection', threshold: 0.5, silence_duration_ms: 1000 } },
      output: { format: { type: 'pcm', sample_rate: 24000 }, voice: 'Tina' },
    },
    translation: { language, ...(Object.keys(corpus).length ? { corpus: { phrases: corpus } } : {}) },
  };
  return session;
}

function transportCapabilities() {
  return [
    { id: 'websocket', available: true, label: 'WebSocket' },
    { id: 'webrtc', available: false, label: 'WebRTC', reason: '尚未实现客户端媒体、鉴权与存储接入' },
    { id: 'aoq', available: false, label: 'AOQ', reason: '尚未验证 Windows/Electron SDK 接入' },
  ];
}
module.exports = { loadConfig, buildSessionConfig, transportCapabilities };
