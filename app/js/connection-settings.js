const api = window.electronAPI;
const byId = id => document.getElementById(id);
const status = (message, error = false) => {
  const node = byId('connectionStatus');
  node.textContent = message;
  node.dataset.error = String(error);
};

async function initialize() {
  if (!api) {
    status('请通过 DDTrans 桌面应用打开此页面。', true);
    byId('saveBtn').disabled = true;
    byId('testBtn').disabled = true;
    return;
  }
  try {
    const settings = await api.getConnectionSettings();
    byId('endpoint').value = settings.endpoint;
    byId('keyHint').textContent = settings.hasKey ? '已保存 API Key；留空可保留当前 Key。' : '尚未配置 API Key；保存前必须输入。';
    status(settings.hasKey ? (settings.source === 'environment' ? '开发模式：当前使用项目 .env 配置。' : '安装版：当前使用本机保存的配置，与项目 .env 独立。') : '尚未配置 API Key，开始同传前请先保存。');
  } catch (error) {
    status(error.message, true);
  }
}

byId('connectionForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = byId('saveBtn');
  button.disabled = true;
  byId('testBtn').disabled = true;
  status('正在验证连接并保存…');
  try {
    await api.testConnectionSettings({ endpoint: byId('endpoint').value.trim(), apiKey: byId('apiKey').value });
    const result = await api.saveConnectionSettings({ endpoint: byId('endpoint').value.trim(), apiKey: byId('apiKey').value });
    byId('apiKey').value = '';
    byId('keyHint').textContent = result.hasKey ? '已保存 API Key；留空可保留当前 Key。' : '当前连接没有保存 API Key。';
    byId('endpoint').value = result.endpoint;
    status('连接验证成功，配置已保存。');
  } catch (error) {
    status(error.message, true);
  } finally {
    button.disabled = false;
    byId('testBtn').disabled = false;
  }
});

byId('testBtn').addEventListener('click', async () => {
  const button = byId('testBtn');
  button.disabled = byId('saveBtn').disabled = true;
  status('正在验证 API Key 和模型配置…');
  try {
    const result = await api.testConnectionSettings({ endpoint: byId('endpoint').value.trim(), apiKey: byId('apiKey').value });
    status('连接成功，Qwen 3.8 已接受配置，耗时 ' + result.metrics.configure_ms + ' ms。修改过配置后请保存。');
  } catch (error) { status(error.message, true); }
  finally { button.disabled = byId('saveBtn').disabled = false; }
});

byId('minimizeBtn').addEventListener('click', () => void api?.minimizeWindow());
byId('closeBtn').addEventListener('click', () => void api?.closeWindow());
void initialize();
