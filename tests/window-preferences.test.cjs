const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createOverlayPreferences, normalizePreferences } = require('../electron/window-preferences.js');

test('normalizes persisted overlay preferences and retains independent mode positions', () => {
  assert.deepEqual(normalizePreferences({ mode: 'unknown', opacity: 9, subtitlesVisible: 'yes', positions: { standard: { x: 10.4, y: null } } }), {
    mode: 'standard', opacity: 1, subtitlesVisible: true,
    positions: {
      standard: { x: 10, y: undefined },
      ball: { x: undefined, y: undefined },
    },
  });
  assert.equal(normalizePreferences({ mode: 'ball', opacity: 0.1, subtitlesVisible: false }).opacity, 0.5);
});

test('persists separate standard and ball positions', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ddtrans-overlay-preferences-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const first = createOverlayPreferences({ userDataPath });
  assert.deepEqual(first.update({ mode: 'ball', opacity: 0.7, subtitlesVisible: false }), {
    mode: 'ball', opacity: 0.7, subtitlesVisible: false,
  });
  first.updatePosition('standard', { x: 42.6, y: -30.2 });
  first.updatePosition('ball', { x: 780.1, y: 22.7 });
  const second = createOverlayPreferences({ userDataPath });
  assert.deepEqual(second.get(), { mode: 'ball', opacity: 0.7, subtitlesVisible: false });
  assert.deepEqual(second.getPosition('standard'), { x: 43, y: -30 });
  assert.deepEqual(second.getPosition('ball'), { x: 780, y: 23 });
});
