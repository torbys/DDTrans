const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadConfig, MODEL } = require('../electron/config.js');
const { createConnectionSettings, validateApiKey } = require('../electron/connection-settings.js');

const endpoint = 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=' + MODEL;

function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from('protected:' + value),
    decryptString: value => {
      const encoded = Buffer.from(value).toString();
      if (!encoded.startsWith('protected:')) throw new Error('bad ciphertext');
      return encoded.slice('protected:'.length);
    },
  };
}

function temporarySettings(t, safeStorage = fakeSafeStorage()) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ddtrans-connection-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return createConnectionSettings({ userDataPath, safeStorage });
}

test('persists only an encrypted API key in user data', t => {
  const settings = temporarySettings(t);
  assert.deepEqual(settings.save({ endpoint, apiKey: 'sk-private-value' }), { endpoint: endpoint + '', hasKey: true });
  const raw = fs.readFileSync(settings.file, 'utf8');
  assert.doesNotMatch(raw, /sk-private-value/);
  assert.match(raw, /encryptedApiKey/);
  assert.deepEqual(settings.get(), { endpoint: endpoint + '', hasKey: true });
  assert.equal(settings.getSecret(), 'sk-private-value');
});

test('blank or omitted API key retains the saved encrypted key', t => {
  const settings = temporarySettings(t);
  settings.save({ endpoint, apiKey: 'sk-existing' });
  const updatedEndpoint = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=' + MODEL;
  assert.deepEqual(settings.save({ endpoint: updatedEndpoint, apiKey: '' }), { endpoint: updatedEndpoint, hasKey: true });
  assert.deepEqual(settings.save({ endpoint, apiKey: undefined }), { endpoint: endpoint + '', hasKey: true });
  assert.equal(settings.getSecret(), 'sk-existing');
});

test('a failed staged commit leaves the previous profile intact', t => {
  const settings = temporarySettings(t);
  settings.save({ endpoint, apiKey: 'sk-previous' });
  const failingFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') return () => { throw new Error('simulated rename failure'); };
      return target[property];
    },
  });
  const failing = createConnectionSettings({ userDataPath: path.dirname(settings.file), safeStorage: fakeSafeStorage(), fileSystem: failingFileSystem });
  const staged = failing.prepareSave({ endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=' + MODEL, apiKey: 'sk-next' });
  assert.throws(() => staged.commit(), /simulated rename failure/);
  assert.deepEqual(settings.get(), { endpoint: endpoint + '', hasKey: true });
  assert.equal(settings.getSecret(), 'sk-previous');
  assert.equal(fs.existsSync(settings.file + '.tmp'), false);
});

test('rejects invalid endpoint, invalid API key, and unavailable Windows credential protection', t => {
  const settings = temporarySettings(t);
  assert.throws(() => settings.save({ endpoint: 'https://example.test', apiKey: 'sk-test' }), /qwen3\.8/);
  assert.throws(() => validateApiKey(''), /请输入 API Key/);
  assert.throws(() => validateApiKey('line\nbreak'), /格式无效/);
  const unavailable = temporarySettings(t, fakeSafeStorage({ available: false }));
  assert.throws(() => unavailable.get(), /Windows 凭据保护不可用/);
  assert.throws(() => unavailable.save({ endpoint, apiKey: 'sk-test' }), /Windows 凭据保护不可用/);
});

test('packaged runtime config can use a writable userData data directory without an env file', t => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ddtrans-user-data-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const originalEndpoint = process.env.QWEN_WS_URL, originalKey = process.env.DASHSCOPE_API_KEY;
  process.env.QWEN_WS_URL = 'wss://source.example/api-ws/v1/realtime?model=' + MODEL;
  process.env.DASHSCOPE_API_KEY = 'source-environment-key';
  t.after(() => {
    if (originalEndpoint === undefined) delete process.env.QWEN_WS_URL; else process.env.QWEN_WS_URL = originalEndpoint;
    if (originalKey === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = originalKey;
  });
  const dataDir = path.join(userDataPath, 'data');
  const config = loadConfig({ root: path.join(userDataPath, 'app.asar'), dataDir, env: { SERVER_PORT: '0' }, loadEnv: false });
  assert.equal(config.dataDir, dataDir);
  assert.equal(config.endpoint, 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=' + MODEL);
  assert.equal(config.apiKey, '');
});
