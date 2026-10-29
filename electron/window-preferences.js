const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PREFERENCES = Object.freeze({
  mode: 'standard',
  opacity: 0.85,
  subtitlesVisible: true,
  positions: {
    standard: { x: undefined, y: undefined },
    ball: { x: undefined, y: undefined },
  },
});

function normalizePosition(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    x: Number.isFinite(input.x) ? Math.round(input.x) : undefined,
    y: Number.isFinite(input.y) ? Math.round(input.y) : undefined,
  };
}

function normalizePreferences(value) {
  const input = value && typeof value === 'object' ? value : {};
  const positions = input.positions && typeof input.positions === 'object' ? input.positions : {};
  return {
    mode: input.mode === 'ball' ? 'ball' : 'standard',
    opacity: Number.isFinite(input.opacity) ? Math.min(1, Math.max(0.5, input.opacity)) : DEFAULT_PREFERENCES.opacity,
    subtitlesVisible: typeof input.subtitlesVisible === 'boolean' ? input.subtitlesVisible : DEFAULT_PREFERENCES.subtitlesVisible,
    positions: {
      standard: normalizePosition(positions.standard),
      ball: normalizePosition(positions.ball),
    },
  };
}

function publicPreferences(preferences) {
  return {
    mode: preferences.mode,
    opacity: preferences.opacity,
    subtitlesVisible: preferences.subtitlesVisible,
  };
}

function createOverlayPreferences({ userDataPath }) {
  const filePath = path.join(userDataPath, 'overlay-preferences.json');
  let preferences = { ...DEFAULT_PREFERENCES };

  try {
    preferences = normalizePreferences(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('无法读取悬浮窗偏好，将使用默认值：' + error.message);
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(preferences, null, 2), 'utf8');
  }

  return {
    get: () => publicPreferences(preferences),
    getPosition: mode => ({ ...preferences.positions[mode === 'ball' ? 'ball' : 'standard'] }),
    update(patch) {
      preferences = normalizePreferences({ ...preferences, ...patch });
      save();
      return publicPreferences(preferences);
    },
    updatePosition(mode, { x, y }) {
      const key = mode === 'ball' ? 'ball' : 'standard';
      preferences = normalizePreferences({
        ...preferences,
        positions: { ...preferences.positions, [key]: { x, y } },
      });
      save();
    },
  };
}

module.exports = { DEFAULT_PREFERENCES, createOverlayPreferences, normalizePreferences };
