import { LANG_DATA, TEXT_ONLY_LANGS } from './config.js';

export const AUDIO_OUTPUT_SAMPLE_RATE = 48000;
export const OUTGOING_LANGUAGES = Object.freeze(LANG_DATA.filter(language => !TEXT_ONLY_LANGS.includes(language.code)));
const outgoingLanguages = new Set(OUTGOING_LANGUAGES.map(language => language.code));

export const DEFAULT_AUDIO_ROUTING = Object.freeze({
  originalGain: 1,
  outgoingOriginalGain: 0,
  translatedGain: 1,
  ttsEnabled: true,
  ttsVolume: 0.8,
  monitorEnabled: true,
  monitorVolume: 0.8,
  monitorDeviceId: 'default',
  monitorMode: 'translated',
  monitorDeviceLabel: '',
  virtualOutputEnabled: false,
  virtualRenderDeviceId: '',
  virtualRenderDeviceLabel: '',
  virtualCaptureDeviceId: '',
  virtualCaptureDeviceLabel: '',
  outgoingTargetLanguage: 'en',
  sampleRate: AUDIO_OUTPUT_SAMPLE_RATE,
  channelCount: 1,
});

const AUDIO_ROUTING_FIELDS = Object.keys(DEFAULT_AUDIO_ROUTING);
const AUDIO_ROUTING_FIELD_SET = new Set(AUDIO_ROUTING_FIELDS);
const VOLUME_FIELDS = new Set(['originalGain', 'outgoingOriginalGain', 'translatedGain', 'ttsVolume', 'monitorVolume']);
const BOOLEAN_FIELDS = new Set(['ttsEnabled', 'monitorEnabled', 'virtualOutputEnabled']);
const TEXT_FIELDS = new Set([
  'monitorDeviceId',
  'monitorDeviceLabel',
  'virtualRenderDeviceId',
  'virtualRenderDeviceLabel',
  'virtualCaptureDeviceId',
  'virtualCaptureDeviceLabel',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnitNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isText(value) {
  return typeof value === 'string' && value.length <= 500;
}

function isValidField(name, value) {
  if (VOLUME_FIELDS.has(name)) return isUnitNumber(value);
  if (BOOLEAN_FIELDS.has(name)) return typeof value === 'boolean';
  if (TEXT_FIELDS.has(name)) return isText(value);
  if (name === 'monitorMode') return value === 'translated' || value === 'mix';
  if (name === 'outgoingTargetLanguage') return outgoingLanguages.has(value);
  if (name === 'sampleRate') return value === AUDIO_OUTPUT_SAMPLE_RATE;
  if (name === 'channelCount') return value === 1;
  return false;
}

export function normalizeAudioRouting(input = {}) {
  const source = isObject(input) ? input : {};
  const normalized = {};
  for (const name of AUDIO_ROUTING_FIELDS) {
    const value = source[name];
    normalized[name] = isValidField(name, value) ? value : DEFAULT_AUDIO_ROUTING[name];
  }
  return normalized;
}

export function validateAudioRoutingPatch(patch) {
  if (!isObject(patch)) throw new TypeError('audio routing patch must be an object');
  for (const name of Reflect.ownKeys(patch)) {
    if (typeof name !== 'string' || !AUDIO_ROUTING_FIELD_SET.has(name)) {
      throw new RangeError(`unknown audio routing field: ${String(name)}`);
    }
    if (!isValidField(name, patch[name])) {
      throw new TypeError(`invalid audio routing value for ${name}`);
    }
  }
  return { ...patch };
}
