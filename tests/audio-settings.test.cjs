const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_AUDIO_SETTINGS,
  normalizeAudioSettings,
  createAudioSettings,
} = require('../electron/audio-settings.js');
const {
  AUDIO_OUTPUT_SAMPLE_RATE,
  DEFAULT_AUDIO_ROUTING,
  OUTGOING_LANGUAGES,
  validateAudioRoutingPatch,
} = require('../app/js/audio-routing-config.js');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ddtrans-audio-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('audio routing defaults are shared and disk normalization retains only valid values', () => {
  assert.strictEqual(DEFAULT_AUDIO_SETTINGS, DEFAULT_AUDIO_ROUTING);
  assert.equal(AUDIO_OUTPUT_SAMPLE_RATE, 48000);
  const settings = normalizeAudioSettings({
    originalGain: 0.25,
    translatedGain: Number.NaN,
    ttsEnabled: 'false',
    monitorMode: 'mix',
    monitorDeviceLabel: 'Desk speakers',
    sampleRate: 16000,
    channelCount: 2,
  });
  assert.equal(settings.originalGain, 0.25);
  assert.equal(settings.translatedGain, DEFAULT_AUDIO_SETTINGS.translatedGain);
  assert.equal(settings.ttsEnabled, DEFAULT_AUDIO_SETTINGS.ttsEnabled);
  assert.equal(settings.monitorMode, 'mix');
  assert.equal(settings.monitorDeviceLabel, 'Desk speakers');
  assert.equal(settings.sampleRate, 48000);
  assert.equal(settings.channelCount, 1);
});

test('invalid runtime types are rejected without changing stored settings', t => {
  const directory = temporaryDirectory(t);
  const store = createAudioSettings({ userDataPath: directory });
  const saved = store.update({ originalGain: 0.25, ttsEnabled: false });
  const before = fs.readFileSync(store.path, 'utf8');

  assert.throws(() => store.update({ ttsEnabled: 'false' }), /invalid audio routing value for ttsEnabled/);
  assert.equal(fs.readFileSync(store.path, 'utf8'), before);
  assert.deepEqual(store.get(), saved);
});

test('corrupt audio settings recover to defaults without removing the source file', t => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'audio-settings.json');
  fs.writeFileSync(filePath, '{broken', 'utf8');

  const store = createAudioSettings({ userDataPath: directory });
  assert.deepEqual(store.get(), DEFAULT_AUDIO_SETTINGS);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
});

test('unexpected audio settings read errors identify the settings path', t => {
  const directory = temporaryDirectory(t);
  const failingFs = {
    ...fs,
    readFileSync() {
      const error = new Error('simulated read failure');
      error.code = 'EACCES';
      throw error;
    },
  };
  const store = createAudioSettings({ userDataPath: directory, fsImpl: failingFs });

  assert.throws(() => store.get(), new RegExp(`Unable to read audio settings at ${store.path.replaceAll('\\', '\\\\')}`));
});

test('multiple saves survive reopening the audio settings store', t => {
  const directory = temporaryDirectory(t);
  const store = createAudioSettings({ userDataPath: directory });
  store.update({ originalGain: 0.25, monitorMode: 'mix' });
  const saved = store.update({ monitorDeviceId: 'speaker-1', monitorDeviceLabel: 'Desk speakers' });

  const reopened = createAudioSettings({ userDataPath: directory });
  assert.deepEqual(reopened.get(), saved);
});

test('failed atomic writes leave cache and original file intact and clean their temporary file', t => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'audio-settings.json');
  const original = JSON.stringify({ ...DEFAULT_AUDIO_SETTINGS, originalGain: 0.25 }, null, 2) + '\n';
  fs.writeFileSync(filePath, original, 'utf8');
  const failingFs = {
    ...fs,
    renameSync() {
      const error = new Error('simulated rename failure');
      error.code = 'EACCES';
      throw error;
    },
  };
  const store = createAudioSettings({ userDataPath: directory, fsImpl: failingFs });
  const cached = store.get();

  assert.throws(() => store.update({ originalGain: 0.75 }), /Unable to save audio settings/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  assert.deepEqual(store.get(), cached);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
});

test('unknown audio routing fields are rejected before storage', t => {
  const directory = temporaryDirectory(t);
  const store = createAudioSettings({ userDataPath: directory });

  assert.throws(() => validateAudioRoutingPatch({ unexpected: true }), /unknown audio routing field/);
  assert.throws(() => store.replace({ unexpected: true }), /unknown audio routing field/);
  assert.equal(fs.existsSync(store.path), false);
});

test('outgoing target language is saved independently and survives reopening', t => {
  const directory = temporaryDirectory(t);
  const store = createAudioSettings({ userDataPath: directory });
  assert.equal(store.get().outgoingTargetLanguage, 'en');
  store.update({ outgoingTargetLanguage: 'ja' });
  store.update({ originalGain: 0, monitorVolume: 0.4 });
  const reopened = createAudioSettings({ userDataPath: directory }).get();
  assert.equal(reopened.outgoingTargetLanguage, 'ja');
  assert.equal(reopened.monitorVolume, 0.4);
  assert.equal(reopened.originalGain, 0);
});

test('outgoing language accepts only supported spoken output and rejects invalid values atomically', t => {
  const directory = temporaryDirectory(t);
  const store = createAudioSettings({ userDataPath: directory });
  store.update({ outgoingTargetLanguage: 'fr' });
  const before = fs.readFileSync(store.path, 'utf8');
  for (const value of ['yue', 'invalid', '', null, 1, {}, 'EN']) {
    assert.throws(() => store.update({ outgoingTargetLanguage: value }), /invalid audio routing value for outgoingTargetLanguage/);
    assert.equal(fs.readFileSync(store.path, 'utf8'), before);
    assert.equal(normalizeAudioSettings({ outgoingTargetLanguage: value }).outgoingTargetLanguage, 'en');
  }
  assert.ok(OUTGOING_LANGUAGES.some(language => language.code === 'en'));
  assert.ok(!OUTGOING_LANGUAGES.some(language => language.code === 'yue'));
});

test('listening and outgoing original gains persist independently with strict validation', t => {
  const directory = temporaryDirectory(t);
  const store = createAudioSettings({ userDataPath: directory });
  store.update({ originalGain: 0.63, outgoingOriginalGain: 0.2 });
  const reopened = createAudioSettings({ userDataPath: directory });
  assert.equal(reopened.get().originalGain, 0.63);
  assert.equal(reopened.get().outgoingOriginalGain, 0.2);
  for (const value of [-1, 1.1, Number.NaN, '0', null]) {
    assert.throws(() => reopened.update({ outgoingOriginalGain: value }), /invalid audio routing value for outgoingOriginalGain/);
  }
  assert.equal(reopened.get().originalGain, 0.63);
  assert.equal(reopened.get().outgoingOriginalGain, 0.2);
});
