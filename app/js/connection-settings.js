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
    return;
  }
  try {
    const settings = await api.getConnectionSettings();
    byId('endpoint').value = settings.endpoint;
    byId('keyHint').textContent = settings.hasKey ? '已保存 API Key；留空可保留当前 Key。' : '尚未配置 API Key；保存前必须输入。';
    status(settings.hasKey ? '连接已配置。' : '尚未配置 API Key，开始同传前请先保存。');
  } catch (error) {
    status(error.message, true);
  }
}

byId('connectionForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = byId('saveBtn');
  button.disabled = true;
  status('正在保存…');
  try {
    const result = await api.saveConnectionSettings({ endpoint: byId('endpoint').value.trim(), apiKey: byId('apiKey').value });
    byId('apiKey').value = '';
    byId('keyHint').textContent = result.hasKey ? '已保存 API Key；留空可保留当前 Key。' : '当前连接没有保存 API Key。';
    status('已保存，可开始同传。');
  } catch (error) {
    status(error.message, true);
  } finally {
    button.disabled = false;
  }
});

byId('minimizeBtn').addEventListener('click', () => void api?.minimizeWindow());
byId('closeBtn').addEventListener('click', () => void api?.closeWindow());
void initialize();
