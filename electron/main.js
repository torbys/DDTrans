const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');

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
      preload: path.join(__dirname, 'preload.js')
    },
    frame: false,
    show: false
  });

  // 加载主页面
  mainWindow.loadFile(path.join(__dirname, '../app/home.html'));

  // 打开开发者工具（开发模式）
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ============ IPC: 窗口控制 ============

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

// ============ IPC: 系统音频采集 ============

// 获取可用的音频源列表
ipcMain.handle('get-system-audio-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name
  }));
});

// 获取系统音频流（通过捕获屏幕实现）
ipcMain.handle('get-system-audio-stream', async () => {
  try {
    // 获取主屏幕源
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    });

    if (sources.length === 0) {
      throw new Error('未找到屏幕源');
    }

    const primarySource = sources[0];
    console.log('[Electron] 捕获屏幕源:', primarySource.name, primarySource.id);

    // 构造 constraints，只请求音频
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: primarySource.id
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: primarySource.id,
          minWidth: 1,
          maxWidth: 1,
          minHeight: 1,
          maxHeight: 1
        }
      }
    };

    // 使用 navigator.mediaDevices.getUserMedia（在 main 进程中需要通过 webContents 执行，
    // 但 Electron 的 desktopCapturer 可以直接配合 getUserMedia 使用）
    // 这里返回 source id，让前端自己调用 getUserMedia
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
