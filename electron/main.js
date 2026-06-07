const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');

// ========== 安全：API Key 只存在主进程内存中 ========
const API_KEY = process.env.DDTRANS_API_KEY || 'your-api-key-here';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1058,
    minHeight: 631,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // 禁用开发者工具（彻底关闭 DevTools API）
      devTools: false
    },
    frame: false,
    show: false
  });

  // 加载主页面（HTML 套壳方式不变）
  mainWindow.loadFile(path.join(__dirname, '../app/home.html'));

  // ========== 关键：拦截所有打开 DevTools 的快捷键 ==========
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // 屏蔽 F12
    if (input.key === 'F12') {
      event.preventDefault();
      return;
    }
    // 屏蔽 Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C
    if (input.control && input.shift && (
      input.key.toLowerCase() === 'i' ||
      input.key.toLowerCase() === 'j' ||
      input.key.toLowerCase() === 'c'
    )) {
      event.preventDefault();
      return;
    }
    // 屏蔽 macOS Cmd+Option+I / Cmd+Option+C / Cmd+Option+J
    if (input.meta && input.alt && (
      input.key.toLowerCase() === 'i' ||
      input.key.toLowerCase() === 'c' ||
      input.key.toLowerCase() === 'j'
    )) {
      event.preventDefault();
    }
  });

  // 右键菜单屏蔽"检查"（可选，更严格）
  mainWindow.webContents.on('context-menu', (e) => {
    e.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ========== IPC: 窗口控制 ==========
ipcMain.handle('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// ========== IPC: 系统音频采集（原有功能不变）==========
ipcMain.handle('get-system-audio-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }
  });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

ipcMain.handle('get-system-audio-stream', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    });
    if (sources.length === 0) throw new Error('未找到屏幕源');

    const primarySource = sources[0];
    return {
      success: true,
      sourceId: primarySource.id,
      sourceName: primarySource.name
    };
  } catch (err) {
    console.error('[Electron] 获取系统音频失败:', err);
    return { success: false, error: err.message };
  }
});

// ========== 新增：安全的 API Key 代理 ==========
// 前端不要直接调用外部 API，而是通过 IPC 让主进程代发请求
ipcMain.handle('api-request', async (event, { endpoint, body }) => {
  // 这里你可以用 Node.js 的 https/http 模块发请求
  // 或者把密钥拼进 header，前端永远看不到 key
  const options = {
    hostname: 'your-api-host.com',
    path: endpoint,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    }
  };
  
  // 示例：返回一个 Promise，实际项目中用 https.request 或 axios
  return new Promise((resolve, reject) => {
    // 这里替换为你的真实请求逻辑
    resolve({ success: true, message: '请求已由主进程代理发送' });
  });
});