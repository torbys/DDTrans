const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch(error => {
    throw new Error(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
  });
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('回调必须是函数');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

if (location.pathname === '/media-host.html') {
  contextBridge.exposeInMainWorld('electronAPI', {
    mediaCapabilities: ipcRenderer.sendSync('get-media-capabilities'),
    onHostCommand: callback => subscribe('media-host-command', callback),
    hostResult: result => ipcRenderer.send('media-host-result', result),
    publishMediaEvent: mediaEvent => ipcRenderer.send('media-host-event', mediaEvent),
    hostReady: () => ipcRenderer.send('media-host-ready'),
  });
} else {
  contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    mediaCapabilities: ipcRenderer.sendSync('get-media-capabilities'),
    minimizeWindow: () => invoke('window-minimize'),
    maximizeWindow: () => invoke('window-maximize'),
    closeWindow: () => invoke('window-close'),
    openManageWindow: () => invoke('open-manage-window'),
    openDetailWindow: sessionId => invoke('open-detail-window', sessionId),
    mediaCommand: (command, payload = {}) => invoke('media-command', command, payload),
    getMediaSnapshot: () => invoke('get-media-snapshot'),
    onMediaEvent: callback => subscribe('media-event', callback),
    enterOverlay: (options = {}) => invoke('enter-overlay', options),
    getOverlayPreferences: () => invoke('get-overlay-preferences'),
    updateOverlayPreferences: patch => invoke('update-overlay-preferences', patch),
    onOverlayPreferences: callback => subscribe('overlay-preferences', callback),
    setOverlayMode: mode => invoke('set-overlay-mode', mode),
    moveOverlay: ({ deltaX, deltaY }) => invoke('move-overlay', { deltaX, deltaY }),
    returnToMain: () => invoke('return-to-main'),
    exitOverlay: () => invoke('exit-overlay'),
    copyText: text => invoke('copy-text', text),
  });
}
