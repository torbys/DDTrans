const fs = require('node:fs');
const path = require('node:path');

const LANGUAGES = new Set('zh en ja ko fr de es pt ru ar it id vi th tr hi ms nl ur nb sv da he fi pl is cs fil fa yue el af ast be bg bn bs ca ceb et gl gu hr hu jv kk kn ky lv mk ml mr pa ro sk sl sw tg az uk'.split(' '));
const TEXT_ONLY = new Set('yue el af ast be bg bn bs ca ceb et gl gu hr hu jv kk kn ky lv mk ml mr pa ro sk sl sw tg az uk'.split(' '));
const MODEL = 'qwen3.8-livetranslate-flash-realtime';
const DEFAULT_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=' + MODEL;

function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.trim()) throw new Error('请输入 Qwen 3.8 实时 WSS 地址');
  let url;
  try { url = new URL(endpoint.trim()); }
  catch { throw new Error('QWEN_WS_URL 必须是有效的 WSS 地址'); }
  if (url.protocol === 'https:' && ['/compatible-mode/v1', '/compatible-mode/v1/', '/api-ws/v1/realtime'].includes(url.pathname)) {
    url.protocol = 'wss:';
    url.pathname = '/api-ws/v1/realtime';
    if (!url.searchParams.has('model')) url.searchParams.set('model', MODEL);
  }
  if (url.protocol !== 'wss:' || url.searchParams.get('model') !== MODEL) throw new Error('QWEN_WS_URL 必须为 qwen3.8 的 wss 实时地址');
  if (url.username || url.password || url.hash) throw new Error('连接地址不能包含用户名、密码或片段');
  return url.href;
}

function loadConfig(options = {}) {
  if (typeof options === 'string') options = { root: options };
  const root = options.root || path.resolve(__dirname, '..');
  const envFile = path.join(root, '.env');
  if (options.loadEnv !== false && fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const env = options.env || process.env;
  const endpoint = validateEndpoint(options.endpoint ?? env.QWEN_WS_URL ?? DEFAULT_ENDPOINT);
  const port = Number(options.port ?? env.SERVER_PORT ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('SERVER_PORT 必须是 0–65535');
  return {
    root,
    model: MODEL,
    endpoint,
    apiKey: options.apiKey ?? env.DASHSCOPE_API_KEY ?? '',
    port,
    dataDir: options.dataDir ? path.resolve(options.dataDir) : env.DDTRANS_DATA_DIR ? path.resolve(env.DDTRANS_DATA_DIR) : path.join(root, 'data'),
  };
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
    { id: 'webrtc', available: false, label: 'WebRTC', reason: '真实探针已验证；产品录音、落库与重连尚未接入' },
    { id: 'aoq', available: false, label: 'AOQ', reason: '官方 Electron SDK 1.4.0 已实测；尾段完整性尚未通过验收' },
  ];
}
module.exports = { MODEL, DEFAULT_ENDPOINT, validateEndpoint, loadConfig, buildSessionConfig, transportCapabilities };
