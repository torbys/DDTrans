import { createMediaSession } from './media-session.js';
import { createAudioCapture } from './audio-capture.js';
import { createPcmPlayer } from './audio-engine.js';
import { createAudioMixBus, classifyAudioDevices } from './audio-mix-bus.js';

const bridge = window.electronAPI;
const url = new URL('/ws/translate', location.href);
url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const media = createMediaSession({
    createCapture: createAudioCapture,
    createPlayer: createPcmPlayer,
    createMixBus: createAudioMixBus,
    createSocket: () => new WebSocket(url),
    capabilities: bridge.mediaCapabilities,
    audioSettings: bridge.audioSettings,
    saveAudioSettings: settings => bridge.saveAudioSettings(settings),
    enumerateDevices: async () => {
        if (!navigator.mediaDevices?.enumerateDevices) throw new Error('当前环境不支持设备枚举');
        const report = classifyAudioDevices(await navigator.mediaDevices.enumerateDevices());
        try { report.permission = (await navigator.permissions.query({ name: 'microphone' })).state; }
        catch { report.permission = 'unknown'; }
        return report;
    },
    requestAudioPermission: async () => {
        if (!navigator.mediaDevices?.getUserMedia) return { granted: false, message: '当前环境不支持麦克风权限申请' };
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            return { granted: true, message: '麦克风权限已获得' };
        } catch (error) {
            return { granted: false, message: '麦克风权限申请失败：' + error.message };
        } finally {
            stream?.getTracks().forEach(track => track.stop());
        }
    },
    publish: event => bridge.publishMediaEvent(event),
    loadHotwords: async () => {
        const response = await fetch('/api/hotwords');
        if (!response.ok) throw new Error('无法读取热词配置');
        return response.json();
    },
});
bridge.onHostCommand(async ({ requestId, command, payload }) => {
    try { bridge.hostResult({ requestId, snapshot: await media.execute(command, payload) }); }
    catch (error) { bridge.hostResult({ requestId, error: error.message }); }
});
navigator.mediaDevices.addEventListener('devicechange', () => {
    void media.execute('enumerate-devices').catch(error => bridge.publishMediaEvent({ type: 'feedback', message: '音频设备更新失败：' + error.message, kind: 'error' }));
});
await media.execute('enumerate-devices');
bridge.hostReady();
