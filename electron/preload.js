const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: process.versions,

  // 获取系统音频源（通过 desktopCapturer）
  getSystemAudioSources: () => ipcRenderer.invoke('get-system-audio-sources'),

  // 获取系统音频流（捕获整个屏幕的音频）
  getSystemAudioStream: () => ipcRenderer.invoke('get-system-audio-stream'),
});
