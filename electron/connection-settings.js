const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_ENDPOINT, validateEndpoint } = require('./config');

function validateApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('请输入 API Key');
  const value = apiKey.trim();
  if (value.length > 1024 || /[\r\n\u0000]/.test(value)) throw new Error('API Key 格式无效');
  return value;
}

function createConnectionSettings({ userDataPath, safeStorage, fileSystem = fs } = {}) {
  if (!userDataPath) throw new Error('未提供用户数据目录');
  const file = path.join(userDataPath, 'connection-settings.json');

  function encryption() {
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('Windows 凭据保护不可用，无法保存 API Key');
    return safeStorage;
  }

  function readRaw() {
    if (!fileSystem.existsSync(file)) return {};
    try {
      const value = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('设置文件格式无效');
      return value;
    } catch (error) {
      throw new Error('无法读取连接设置：' + error.message);
    }
  }

  function read() {
    const value = readRaw();
    const endpoint = value.endpoint ? validateEndpoint(value.endpoint) : DEFAULT_ENDPOINT;
    const encryptedApiKey = typeof value.encryptedApiKey === 'string' ? value.encryptedApiKey : '';
    return { endpoint, encryptedApiKey };
  }

  function getSecret() {
    const value = read();
    if (!value.encryptedApiKey) return '';
    try { return validateApiKey(encryption().decryptString(Buffer.from(value.encryptedApiKey, 'base64'))); }
    catch (error) {
      if (error.message.startsWith('Windows 凭据保护') || error.message.startsWith('API Key')) throw error;
      throw new Error('无法解密已保存的 API Key：' + error.message);
    }
  }

  function get() {
    const value = read();
    encryption();
    if (value.encryptedApiKey) getSecret();
    return { endpoint: value.endpoint, hasKey: Boolean(value.encryptedApiKey) };
  }

  function prepareSave({ endpoint, apiKey } = {}) {
    const nextEndpoint = validateEndpoint(endpoint);
    const previous = read();
    let key = apiKey;
    if (key === '' || key === undefined) key = previous.encryptedApiKey ? getSecret() : undefined;
    if (key !== undefined && key !== null) key = validateApiKey(key);
    const next = { endpoint: nextEndpoint };
    if (key) next.encryptedApiKey = encryption().encryptString(key).toString('base64');
    const temporary = file + '.tmp';
    fileSystem.mkdirSync(userDataPath, { recursive: true });
    try {
      fileSystem.writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      try { fileSystem.rmSync(temporary, { force: true }); } catch (_) {}
      throw error;
    }
    let finished = false;
    const result = { endpoint: nextEndpoint, hasKey: Boolean(next.encryptedApiKey) };
    return {
      ...result,
      commit() {
        if (finished) throw new Error('连接设置保存事务已结束');
        try {
          fileSystem.renameSync(temporary, file);
          finished = true;
          return result;
        } catch (error) {
          try { fileSystem.rmSync(temporary, { force: true }); } catch (_) {}
          finished = true;
          throw error;
        }
      },
      cleanup() {
        if (finished) return;
        finished = true;
        try { fileSystem.rmSync(temporary, { force: true }); } catch (_) {}
      },
    };
  }

  function save(input) {
    const staged = prepareSave(input);
    try { return staged.commit(); }
    finally { staged.cleanup(); }
  }

  return { file, get, getSecret, prepareSave, save };
}

module.exports = { createConnectionSettings, validateApiKey };
