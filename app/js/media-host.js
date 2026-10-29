import { createMediaSession } from './media-session.js';
import { createAudioCapture } from './audio-capture.js';
import { createPcmPlayer } from './audio-engine.js';

const bridge = window.electronAPI;
const url = new URL('/ws/translate', location.href);
url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

const media = createMediaSession({
    createCapture: createAudioCapture,
    createPlayer: createPcmPlayer,
    createSocket: () => new WebSocket(url),
    capabilities: bridge.mediaCapabilities,
    publish: event => bridge.publishMediaEvent(event),
    loadHotwords: () => {
        try { return JSON.parse(localStorage.getItem('ddtrans.hotwords') || '[]'); }
        catch { return []; }
    },
});

bridge.onHostCommand(async ({ requestId, command, payload }) => {
    try { bridge.hostResult({ requestId, snapshot: await media.execute(command, payload) }); }
    catch (error) { bridge.hostResult({ requestId, error: error.message }); }
});

bridge.hostReady();
