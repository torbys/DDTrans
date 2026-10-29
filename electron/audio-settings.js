const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_AUDIO_ROUTING: DEFAULT_AUDIO_SETTINGS,
  normalizeAudioRouting: normalizeAudioSettings,
  validateAudioRoutingPatch,
} = require('../app/js/audio-routing-config.js');

function createAudioSettings({ userDataPath, fsImpl = fs, pathImpl = path } = {}) {
  if (typeof userDataPath !== 'string' || !userDataPath) throw new TypeError('userDataPath is required');
  const filePath = pathImpl.join(userDataPath, 'audio-settings.json');
  let cached;
  let writeSequence = 0;

  function read() {
    if (cached) return { ...cached };
    let content;
    try {
      content = fsImpl.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'EINVAL')) {
        cached = { ...DEFAULT_AUDIO_SETTINGS };
        return { ...cached };
      }
      throw new Error(`Unable to read audio settings at ${filePath}: ${error.message}`, { cause: error });
    }
    try {
      cached = normalizeAudioSettings(JSON.parse(content));
    } catch (_) {
      cached = { ...DEFAULT_AUDIO_SETTINGS };
    }
    return { ...cached };
  }

  function write(next) {
    const normalized = normalizeAudioSettings(next);
    let temporaryPath;
    try {
      fsImpl.mkdirSync(userDataPath, { recursive: true });
      temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${writeSequence++}.tmp`;
      fsImpl.writeFileSync(temporaryPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
      fsImpl.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (temporaryPath) {
        try {
          fsImpl.unlinkSync(temporaryPath);
        } catch (cleanupError) {
          if (!cleanupError || cleanupError.code !== 'ENOENT') {
            throw new Error(`Unable to save audio settings at ${filePath}: ${error.message}; temporary file cleanup failed: ${cleanupError.message}`, { cause: error });
          }
        }
      }
      throw new Error(`Unable to save audio settings at ${filePath}: ${error.message}`, { cause: error });
    }
    cached = normalized;
    return { ...cached };
  }

  return {
    path: filePath,
    get: read,
    update(patch = {}) {
      const validatedPatch = validateAudioRoutingPatch(patch);
      return write({ ...read(), ...validatedPatch });
    },
    replace(next = {}) {
      return write(validateAudioRoutingPatch(next));
    },
  };
}

module.exports = {
  DEFAULT_AUDIO_SETTINGS,
  normalizeAudioSettings,
  createAudioSettings,
};
