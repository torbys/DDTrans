const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, session, utilityProcess } = require('electron');
const os = require('node:os');
const path = require('node:path');

if (process.env.DDTRANS_TEST_USER_DATA) app.setPath('userData', process.env.DDTRANS_TEST_USER_DATA);

const MEDIA_COMMANDS = new Set(['start', 'pause', 'resume', 'stop', 'switch-source', 'set-tts', 'set-volume', 'set-target', 'save-note', 'snapshot']);
const HOST_TIMEOUT_MS = 40_000;
const HOST_READY_TIMEOUT_MS = 40_000;
const SHUTDOWN_HOST_TIMEOUT_MS = 80_000;

let backend;
let origin;
let mainWindow;
let manageWindow;
let mediaHost;
let hostReady = false;
let hostReadyWaiter;
let hostRequestId = 0;
let quitting = false;
let quitAllowed = false;
let shutdownPromise;
const hostPending = new Map();
const detailWindows = new Map();

function sameOrigin(url) {
  try { return Boolean(origin) && new URL(url).origin === origin; }
  catch { return false; }
}

function isMainFrame(webContents, frame) {
  return Boolean(frame && webContents && frame === webContents.mainFrame && sameOrigin(frame.url));
}

function trusted(event) {
  if (!isMainFrame(event.sender, event.senderFrame)) throw new Error('无效页面来源');
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window === mediaHost) throw new Error('无效页面来源');
  return window;
}

function isHostMessage(event) {
  return Boolean(mediaHost && !mediaHost.isDestroyed()
    && event.sender === mediaHost.webContents
    && isMainFrame(event.sender, event.senderFrame)
    && new URL(event.senderFrame.url).pathname === '/media-host.html');
}

function isTrustedWebContents(webContents) {
  return Boolean(webContents && sameOrigin(webContents.getURL()));
}

function isSystemCaptureFrame(frame) {
  if (!frame || frame.parent || !sameOrigin(frame.url)) return false;
  const pathname = new URL(frame.url).pathname;
  return pathname === '/media-host.html' || pathname === '/home.html';
}

function configureContents(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!sameOrigin(url)) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', (event, url) => { if (!sameOrigin(url)) event.preventDefault(); });
}

function windowPreferences({ backgroundThrottling = true } = {}) {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    preload: path.join(__dirname, 'preload.js'),
    autoplayPolicy: 'no-user-gesture-required',
    backgroundThrottling,
  };
}

function createWindow(page, { width = 1200, height = 800, minWidth = 1000, minHeight = 630 } = {}) {
  const window = new BrowserWindow({
    width, height, minWidth, minHeight, frame: false, show: false, backgroundColor: '#f5f6f8',
    webPreferences: windowPreferences(),
  });
  configureContents(window);
  window.once('ready-to-show', () => window.show());
  void window.loadURL(origin + '/' + page);
  return window;
}

function uiWindows() {
  return [mainWindow, manageWindow, ...detailWindows.values()].filter(window => window && !window.isDestroyed());
}

function visibleWindows() {
  return uiWindows().filter(window => window.isVisible());
}

function focusWindow(window) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}

function attachWindowLifecycle(window, kind, id) {
  window.on('close', event => {
    if (quitting) return;
    if (window === mainWindow || visibleWindows().filter(item => item !== window).length === 0) {
      event.preventDefault();
      void beginShutdown();
    }
  });
  window.on('closed', () => {
    if (kind === 'main') mainWindow = null;
    if (kind === 'manage') manageWindow = null;
    if (kind === 'detail') detailWindows.delete(id);
  });
}

function broadcast(channel, payload) {
  for (const window of uiWindows()) {
    try { window.webContents.send(channel, payload); }
    catch (error) { console.warn('向页面发送消息失败：' + error.message); }
  }
}

function rejectPendingHostRequests(error) {
  for (const { reject, timer } of hostPending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  hostPending.clear();
}

async function hostCommand(command, payload = {}, timeoutMs = HOST_TIMEOUT_MS) {
  if (!MEDIA_COMMANDS.has(command)) throw new Error('不支持的媒体命令');
  if (!mediaHost || mediaHost.isDestroyed() || !hostReady) throw new Error('媒体宿主尚未就绪');
  const requestId = String(++hostRequestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostPending.delete(requestId);
      reject(new Error('媒体宿主请求超时'));
    }, timeoutMs);
    hostPending.set(requestId, { resolve, reject, timer });
    try { mediaHost.webContents.send('media-host-command', { requestId, command, payload }); }
    catch (error) {
      clearTimeout(timer);
      hostPending.delete(requestId);
      reject(error);
    }
  });
}

function finishHostReady(event) {
  if (!isHostMessage(event) || hostReady) return;
  hostReady = true;
  hostReadyWaiter?.resolve();
  hostReadyWaiter = undefined;
}

async function createMediaHost() {
  const window = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: windowPreferences({ backgroundThrottling: false }),
  });
  mediaHost = window;
  configureContents(window);
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting && hostReady) void handleMediaHostFailure('媒体宿主已崩溃：' + details.reason);
  });
  window.on('closed', () => {
    const wasReady = hostReady;
    if (mediaHost === window) mediaHost = null;
    hostReady = false;
    rejectPendingHostRequests(new Error('媒体宿主已关闭'));
    if (hostReadyWaiter) {
      hostReadyWaiter.reject(new Error('媒体宿主在启动前关闭'));
      hostReadyWaiter = undefined;
    }
    if (!quitting && wasReady) void handleMediaHostFailure('媒体宿主已关闭');
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('媒体宿主启动超时')), HOST_READY_TIMEOUT_MS);
    hostReadyWaiter = {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: error => { clearTimeout(timer); reject(error); },
    };
    window.loadURL(origin + '/media-host.html').catch(error => {
      if (hostReadyWaiter) {
        hostReadyWaiter = undefined;
        clearTimeout(timer);
        reject(error);
      }
    });
  }).catch(error => {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  });
}

async function startBackend() {
  return new Promise((resolve, reject) => {
    let started = false;
    backend = utilityProcess.fork(path.join(__dirname, 'service.js'), [], { serviceName: 'DDtrans Gateway', stdio: 'pipe' });
    const timeout = setTimeout(() => reject(new Error('同传后台启动超时')), 20_000);
    backend.stdout?.on('data', chunk => process.stdout.write(chunk));
    backend.stderr?.on('data', chunk => process.stderr.write(chunk));
    backend.on('message', message => {
      if (message.type === 'ready' && !started) {
        started = true;
        clearTimeout(timeout);
        origin = message.origin;
        console.log('DDtrans ready: ' + origin);
        resolve();
      }
      if (message.type === 'error' && !started) {
        clearTimeout(timeout);
        reject(new Error(message.message));
      }
    });
    backend.on('exit', code => {
      clearTimeout(timeout);
      if (!quitting) {
        const message = '同传后台已退出：' + code;
        if (started) {
          dialog.showErrorBox('同传后台已退出', '请重新打开应用。已写入的字幕和音频会保留。');
          void beginShutdown({ skipHostStop: true });
        } else reject(new Error(message));
      }
    });
  });
}

async function stopBackend() {
  const activeBackend = backend;
  if (!activeBackend?.pid) return;
  await new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      activeBackend.removeListener('message', onMessage);
      resolve();
    };
    const timer = setTimeout(() => { activeBackend.kill(); finish(); }, 35_000);
    const onMessage = message => {
      if (message.type === 'stopped') {
        activeBackend.kill();
        finish();
      }
    };
    activeBackend.once('exit', finish);
    activeBackend.on('message', onMessage);
    try { activeBackend.postMessage({ type: 'shutdown' }); }
    catch { finish(); }
  });
}

async function handleMediaHostFailure(message) {
  if (quitting) return;
  dialog.showErrorBox('媒体宿主已停止', message + '。同传已结束，已收到的内容会由后台保存。');
  await beginShutdown({ skipHostStop: true });
}

function destroyWindows() {
  for (const window of [mainWindow, manageWindow, ...detailWindows.values(), mediaHost]) {
    if (window && !window.isDestroyed()) window.destroy();
  }
  mainWindow = null;
  manageWindow = null;
  mediaHost = null;
  detailWindows.clear();
}

function beginShutdown({ skipHostStop = false } = {}) {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = (async () => {
    if (!skipHostStop && hostReady) {
      try { await hostCommand('stop', {}, SHUTDOWN_HOST_TIMEOUT_MS); }
      catch (error) { console.warn('停止媒体宿主失败：' + error.message); }
    }
    await stopBackend();
    destroyWindows();
  })().finally(() => {
    quitAllowed = true;
    app.quit();
  });
  return shutdownPromise;
}

function windowsBuildNumber() {
  const build = Number(os.release().split('.').pop());
  return Number.isSafeInteger(build) ? build : 0;
}

function mediaCapabilities() {
  const windows = process.platform === 'win32';
  return { systemAudio: windows, isolatedTts: windows && windowsBuildNumber() >= 20348 };
}

function setupSessionPolicies() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const captureAllowed = permission !== 'display-capture' || isSystemCaptureFrame(webContents.mainFrame);
    callback(isTrustedWebContents(webContents) && captureAllowed && ['media', 'display-capture', 'speaker-selection'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const captureAllowed = permission !== 'display-capture' || isSystemCaptureFrame(webContents.mainFrame);
    return Boolean(isTrustedWebContents(webContents) && captureAllowed && ['media', 'display-capture', 'speaker-selection'].includes(permission));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!isSystemCaptureFrame(request.frame)) return callback({});
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      callback(sources.length ? { video: sources[0], audio: 'loopback' } : {});
    } catch (error) {
      console.error('系统声采集失败：' + error.message);
      callback({});
    }
  });
}

ipcMain.on('media-host-ready', event => finishHostReady(event));
ipcMain.on('media-host-result', (event, result) => {
  if (!isHostMessage(event) || !result || typeof result.requestId !== 'string') return;
  const pending = hostPending.get(result.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  hostPending.delete(result.requestId);
  if (result.error) pending.reject(new Error(String(result.error)));
  else pending.resolve(result.snapshot);
});
ipcMain.on('media-host-event', (event, mediaEvent) => {
  if (isHostMessage(event) && mediaEvent && typeof mediaEvent.type === 'string') broadcast('media-event', mediaEvent);
});

ipcMain.handle('media-command', async (event, command, payload = {}) => {
  trusted(event);
  if (!MEDIA_COMMANDS.has(command)) throw new Error('不支持的媒体命令');
  return hostCommand(command, payload);
});
ipcMain.handle('get-media-snapshot', event => { trusted(event); return hostCommand('snapshot'); });
ipcMain.handle('copy-text', async (event, text) => {
  trusted(event);
  if (typeof text !== 'string') throw new Error('复制内容必须是文本');
  await clipboard.writeText(text);
});
ipcMain.on('get-media-capabilities', event => {
  if (!isHostMessage(event)) trusted(event);
  event.returnValue = mediaCapabilities();
});
ipcMain.handle('window-minimize', event => trusted(event).minimize());
ipcMain.handle('window-maximize', event => {
  const window = trusted(event);
  if (window.isMaximized()) window.unmaximize(); else window.maximize();
});
ipcMain.handle('window-close', event => trusted(event).close());
ipcMain.handle('open-manage-window', event => {
  trusted(event);
  if (focusWindow(manageWindow)) return;
  manageWindow = createWindow('manage.html', { width: 1000, height: 700, minWidth: 760, minHeight: 500 });
  attachWindowLifecycle(manageWindow, 'manage');
});
ipcMain.handle('open-detail-window', (event, sessionId) => {
  trusted(event);
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('无效会议ID');
  if (focusWindow(detailWindows.get(id))) return;
  const window = createWindow('detail.html?id=' + id, { width: 1100, height: 750, minWidth: 800, minHeight: 500 });
  detailWindows.set(id, window);
  attachWindowLifecycle(window, 'detail', id);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => focusWindow(mainWindow));
  app.whenReady().then(async () => {
    await startBackend();
    setupSessionPolicies();
    await createMediaHost();
    mainWindow = createWindow('home.html');
    attachWindowLifecycle(mainWindow, 'main');
  }).catch(async error => {
    dialog.showErrorBox('启动失败', error.message);
    quitting = true;
    await stopBackend();
    if (mediaHost && !mediaHost.isDestroyed()) mediaHost.destroy();
    quitAllowed = true;
    app.quit();
  });
  app.on('window-all-closed', () => { if (!quitting && visibleWindows().length === 0) void beginShutdown(); });
  app.on('before-quit', event => {
    if (quitAllowed) return;
    event.preventDefault();
    void beginShutdown();
  });
}
