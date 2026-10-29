const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, powerSaveBlocker, screen, session, utilityProcess } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { createOverlayPreferences } = require('./window-preferences.js');

if (process.env.DDTRANS_TEST_USER_DATA) app.setPath('userData', process.env.DDTRANS_TEST_USER_DATA);

const MEDIA_COMMANDS = new Set(['start', 'pause', 'resume', 'stop', 'switch-source', 'set-tts', 'set-volume', 'set-target', 'save-note', 'snapshot']);
const HOST_COMMANDS = new Set([...MEDIA_COMMANDS, 'prepare-overlay']);
const ACTIVATION_COMMANDS = new Set(['prepare-overlay', 'start', 'resume', 'switch-source', 'set-target']);
const HOST_TIMEOUT_MS = 40_000;
const HOST_READY_TIMEOUT_MS = 40_000;
const SHUTDOWN_HOST_TIMEOUT_MS = 80_000;
const OVERLAY_STANDARD_SIZE = { width: 680, height: 560, minWidth: 560, minHeight: 440 };
const OVERLAY_COMPACT_SIZE = { width: 620, height: 190, minWidth: 620, minHeight: 190 };
const OVERLAY_BALL_SIZE = { width: 72, height: 72, minWidth: 72, minHeight: 72 };

let backend;
let origin;
let mainWindow;
let manageWindow;
let mediaHost;
let overlayWindow;
let overlayPreferences;
let hostReady = false;
let hostReadyWaiter;
let hostRequestId = 0;
let powerSaveBlockerId;
let quitting = false;
let quitAllowed = false;
let shutdownPromise;
let overlayTransition;
let overlayClampTimer;
let overlayReturnPage = 'home.html';
let returningToMain = false;
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

function trustedOverlay(event) {
  const window = trusted(event);
  if (window !== overlayWindow) throw new Error('此操作仅限悬浮窗');
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
  window.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url)) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', (event, url) => {
    if (!sameOrigin(url)) event.preventDefault();
  });
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
  return [mainWindow, manageWindow, overlayWindow, ...detailWindows.values()]
    .filter(window => window && !window.isDestroyed());
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

function pageForWindow(window) {
  if (!window || window.isDestroyed()) return 'home.html';
  try {
    const url = new URL(window.webContents.getURL());
    if (!sameOrigin(url.href)) return 'home.html';
    const page = `${url.pathname.replace(/^\/+/, '')}${url.search}${url.hash}`;
    return page || 'home.html';
  } catch {
    return 'home.html';
  }
}

function attachVisibleWindowLifecycle(window) {
  window.on('close', event => {
    if (quitting) return;
    if (window === overlayWindow) {
      if (returningToMain) return;
      event.preventDefault();
      void returnToMain();
      return;
    }
    if (window === mainWindow || window === overlayWindow || visibleWindows().filter(item => item !== window).length === 0) {
      event.preventDefault();
      void beginShutdown();
    }
  });
}

function attachStandardWindowLifecycle(window, kind, id) {
  attachVisibleWindowLifecycle(window);
  window.on('closed', () => {
    if (kind === 'main') mainWindow = null;
    if (kind === 'manage') manageWindow = null;
    if (kind === 'detail') detailWindows.delete(id);
  });
}

function overlaySize() {
  const preferences = overlayPreferences.get();
  if (preferences.mode === 'ball') return OVERLAY_BALL_SIZE;
  return preferences.subtitlesVisible ? OVERLAY_STANDARD_SIZE : OVERLAY_COMPACT_SIZE;
}

function clampOverlayBounds(bounds) {
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const area = display.workArea;
  const clampAxis = (position, size, start, available) => {
    if (size > available) return start;
    return Math.min(Math.max(position, start), start + available - size);
  };
  return {
    ...bounds,
    x: Math.round(clampAxis(bounds.x, bounds.width, area.x, area.width)),
    y: Math.round(clampAxis(bounds.y, bounds.height, area.y, area.height)),
  };
}

function overlayBoundsForCurrentPreferences() {
  const size = overlaySize();
  const preferences = overlayPreferences.get();
  const position = overlayPreferences.getPosition(preferences.mode);
  const area = screen.getPrimaryDisplay().workArea;
  return clampOverlayBounds({
    x: Number.isFinite(position.x) ? position.x : preferences.mode === 'ball' ? area.x + area.width - size.width - 24 : area.x + Math.round((area.width - size.width) / 2),
    y: Number.isFinite(position.y) ? position.y : preferences.mode === 'ball' ? area.y + area.height - size.height - 24 : area.y + Math.round((area.height - size.height) / 2),
    width: size.width,
    height: size.height,
  });
}

function applyOverlayLayout() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const size = overlaySize();
  const bounds = overlayBoundsForCurrentPreferences();
  overlayWindow.setMinimumSize(size.minWidth, size.minHeight);
  overlayWindow.setMaximumSize(size.width === 72 ? 72 : 0, size.height === 72 ? 72 : 0);
  overlayWindow.setBounds(bounds);
  overlayPreferences.updatePosition(overlayPreferences.get().mode, bounds);
}

function broadcast(channel, payload) {
  for (const window of uiWindows()) {
    try { window.webContents.send(channel, payload); }
    catch (error) { console.warn('向页面发送消息失败：' + error.message); }
  }
}

function broadcastOverlayPreferences() {
  broadcast('overlay-preferences', overlayPreferences.get());
}

function rememberOverlayPosition(mode) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const bounds = clampOverlayBounds(overlayWindow.getBounds());
  const current = overlayWindow.getBounds();
  if (bounds.x !== current.x || bounds.y !== current.y) overlayWindow.setPosition(bounds.x, bounds.y);
  overlayPreferences.updatePosition(mode, bounds);
}

function scheduleOverlayClamp() {
  clearTimeout(overlayClampTimer);
  overlayClampTimer = setTimeout(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    rememberOverlayPosition(overlayPreferences.get().mode);
  }, 180);
}

function updatePowerSaveBlocker(snapshot) {
  const shouldBlock = snapshot?.phase === 'running';
  if (shouldBlock && powerSaveBlockerId === undefined) powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!shouldBlock && powerSaveBlockerId !== undefined) {
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = undefined;
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
  if (!HOST_COMMANDS.has(command)) return Promise.reject(new Error('不支持的媒体命令'));
  if (!mediaHost || mediaHost.isDestroyed() || !hostReady) return Promise.reject(new Error('媒体宿主尚未就绪'));
  const host = mediaHost;
  if (ACTIVATION_COMMANDS.has(command)) {
    await host.webContents.executeJavaScript('void 0', true);
    if (mediaHost !== host || host.isDestroyed() || !hostReady) throw new Error('媒体宿主已关闭');
  }
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

function createOverlayWindow() {
  const bounds = overlayBoundsForCurrentPreferences();
  const window = new BrowserWindow({
    ...bounds,
    minWidth: overlaySize().minWidth,
    minHeight: overlaySize().minHeight,
    frame: false,
    transparent: true,
    thickFrame: false,
    alwaysOnTop: true,
    movable: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: windowPreferences({ backgroundThrottling: false }),
  });
  overlayWindow = window;
  configureContents(window);
  attachVisibleWindowLifecycle(window);
  window.on('move', scheduleOverlayClamp);
  window.on('closed', () => {
    clearTimeout(overlayClampTimer);
    if (overlayWindow === window) overlayWindow = null;
    returningToMain = false;
  });
  return new Promise((resolve, reject) => {
    window.once('ready-to-show', () => { window.show(); resolve(window); });
    window.loadURL(origin + '/overlay.html').catch(error => {
      if (!window.isDestroyed()) window.destroy();
      reject(error);
    });
  });
}

async function enterOverlay(options = {}) {
  if (overlayTransition) await overlayTransition;
  if (returningToMain && overlayWindow && !overlayWindow.isDestroyed()) await new Promise(resolve => overlayWindow.once('closed', resolve));
  if (focusWindow(overlayWindow)) return overlayPreferences.get();
  overlayTransition = (async () => {
    try { await hostCommand('prepare-overlay', options); }
    catch (error) {
      if (/NotAllowedError|无法采集电脑声音|麦克风.*权限/i.test(error.message)) dialog.showErrorBox('无法开启收音', error.message + '。请检查 Windows 的麦克风隐私设置和音频设备，然后重试。');
      throw error;
    }
    overlayPreferences.update({ mode: 'standard' });
    overlayReturnPage = pageForWindow(mainWindow);
    await createOverlayWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      const previousMainWindow = mainWindow;
      previousMainWindow.destroy();
      if (mainWindow === previousMainWindow) mainWindow = null;
    }
    return overlayPreferences.get();
  })().finally(() => { overlayTransition = undefined; });
  return overlayTransition;
}

async function returnToMain() {
  if (overlayTransition) await overlayTransition;
  if (!overlayWindow || overlayWindow.isDestroyed()) { focusWindow(mainWindow); return true; }
  overlayTransition = (async () => {
    rememberOverlayPosition(overlayPreferences?.get().mode);
    const closeOverlay = () => {
      const currentOverlay = overlayWindow;
      if (!currentOverlay || currentOverlay.isDestroyed()) return;
      returningToMain = true;
      setImmediate(() => { if (!currentOverlay.isDestroyed()) currentOverlay.close(); });
    };
    if (focusWindow(mainWindow)) {
      closeOverlay();
      return true;
    }

    const page = overlayReturnPage || 'home.html';
    const restoredMainWindow = createWindow(page);
    mainWindow = restoredMainWindow;
    attachStandardWindowLifecycle(restoredMainWindow, 'main');
    focusWindow(restoredMainWindow);
    closeOverlay();
    overlayReturnPage = 'home.html';
    return true;
  })().finally(() => {
    overlayTransition = undefined;
  });
  return overlayTransition;
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
  for (const window of [mainWindow, manageWindow, overlayWindow, ...detailWindows.values(), mediaHost]) {
    if (window && !window.isDestroyed()) window.destroy();
  }
  mainWindow = null;
  manageWindow = null;
  overlayWindow = null;
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
    rememberOverlayPosition(overlayPreferences?.get().mode);
    updatePowerSaveBlocker();
    await stopBackend();
    destroyWindows();
  })().finally(() => {
    quitAllowed = true;
    app.quit();
  });
  return shutdownPromise;
}

function windowsBuildNumber() {
  const release = os.release();
  const build = Number(release.split('.').pop());
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
  if (result.snapshot) updatePowerSaveBlocker(result.snapshot);
  if (result.error) pending.reject(new Error(String(result.error)));
  else pending.resolve(result.snapshot);
});
ipcMain.on('media-host-event', (event, mediaEvent) => {
  if (!isHostMessage(event) || !mediaEvent || typeof mediaEvent.type !== 'string') return;
  if (mediaEvent.type === 'snapshot') updatePowerSaveBlocker(mediaEvent.snapshot);
  broadcast('media-event', mediaEvent);
});

ipcMain.handle('media-command', async (event, command, payload = {}) => {
  trusted(event);
  if (!MEDIA_COMMANDS.has(command)) throw new Error('不支持的媒体命令');
  return hostCommand(command, payload);
});
ipcMain.handle('get-media-snapshot', event => {
  trusted(event);
  return hostCommand('snapshot');
});
ipcMain.handle('enter-overlay', (event, options = {}) => {
  trusted(event);
  return enterOverlay(options);
});
ipcMain.handle('get-overlay-preferences', event => {
  trusted(event);
  return overlayPreferences.get();
});
ipcMain.handle('update-overlay-preferences', (event, patch) => {
  trustedOverlay(event);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效悬浮窗偏好');
  const next = {};
  for (const key of ['mode', 'opacity', 'subtitlesVisible']) if (key in patch) next[key] = patch[key];
  const previous = overlayPreferences.get();
  if (next.mode && next.mode !== previous.mode) rememberOverlayPosition(previous.mode);
  const preferences = overlayPreferences.update(next);
  applyOverlayLayout();
  broadcastOverlayPreferences();
  return preferences;
});
ipcMain.handle('set-overlay-mode', (event, mode) => {
  trustedOverlay(event);
  if (!['standard', 'ball'].includes(mode)) throw new Error('无效悬浮窗模式');
  const previous = overlayPreferences.get();
  if (mode !== previous.mode) rememberOverlayPosition(previous.mode);
  const preferences = overlayPreferences.update({ mode });
  applyOverlayLayout();
  broadcastOverlayPreferences();
  return preferences;
});
ipcMain.handle('move-overlay', (event, movement) => {
  const window = trustedOverlay(event);
  if (!movement || !Number.isFinite(movement.deltaX) || !Number.isFinite(movement.deltaY)) throw new Error('无效移动距离');
  const bounds = window.getBounds();
  const next = clampOverlayBounds({ ...bounds, x: bounds.x + movement.deltaX, y: bounds.y + movement.deltaY });
  window.setPosition(next.x, next.y);
  scheduleOverlayClamp();
});
ipcMain.handle('exit-overlay', event => {
  trustedOverlay(event);
  return beginShutdown();
});
ipcMain.handle('return-to-main', event => {
  trustedOverlay(event);
  return returnToMain();
});
ipcMain.handle('copy-text', async (event, text) => {
  trusted(event);
  if (typeof text !== 'string') throw new Error('复制内容必须是文本');
  await clipboard.writeText(text);
  const accepted = await clipboard.readText();
  if (accepted.replaceAll(String.fromCharCode(13), '') !== text.replaceAll(String.fromCharCode(13), '')) {
    throw new Error('系统剪贴板未接受写入，请检查剪贴板权限或占用程序');
  }
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
  attachStandardWindowLifecycle(manageWindow, 'manage');
});
ipcMain.handle('open-detail-window', (event, sessionId) => {
  trusted(event);
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('无效会议ID');
  if (focusWindow(detailWindows.get(id))) return;
  const window = createWindow('detail.html?id=' + id, { width: 1100, height: 750, minWidth: 800, minHeight: 500 });
  detailWindows.set(id, window);
  attachStandardWindowLifecycle(window, 'detail', id);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { focusWindow(overlayWindow) || focusWindow(mainWindow); });
  app.whenReady().then(async () => {
    overlayPreferences = createOverlayPreferences({ userDataPath: app.getPath('userData') });
    await startBackend();
    setupSessionPolicies();
    await createMediaHost();
    mainWindow = createWindow('home.html');
    attachStandardWindowLifecycle(mainWindow, 'main');
    const reflowOverlay = () => applyOverlayLayout();
    screen.on('display-added', reflowOverlay);
    screen.on('display-removed', reflowOverlay);
    screen.on('display-metrics-changed', reflowOverlay);
  }).catch(async error => {
    dialog.showErrorBox('启动失败', error.message);
    quitting = true;
    await stopBackend();
    if (mediaHost && !mediaHost.isDestroyed()) mediaHost.destroy();
    quitAllowed = true;
    app.quit();
  });
  app.on('window-all-closed', () => {
    if (!quitting && visibleWindows().length === 0) void beginShutdown();
  });
  app.on('before-quit', event => {
    if (quitAllowed) return;
    event.preventDefault();
    void beginShutdown();
  });
}
