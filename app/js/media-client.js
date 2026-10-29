let local;
const listeners = new Set();

async function browserSession() {
    if (!local) {
        local = Promise.all([import('./media-session.js'), import('./audio-capture.js'), import('./audio-engine.js')])
            .then(([session, capture, player]) => session.createMediaSession({
                createCapture: capture.createAudioCapture,
                createPlayer: player.createPcmPlayer,
                createSocket: () => new WebSocket(new URL('/ws/translate', location.href).href.replace(/^http/, 'ws')),
                capabilities: { systemAudio: true },
                publish: event => listeners.forEach(listener => listener(event)),
            }));
    }
    return local;
}

export async function mediaCommand(command, payload = {}) {
    if (window.electronAPI) return window.electronAPI.mediaCommand(command, payload);
    return (await browserSession()).execute(command, payload);
}

export async function getMediaSnapshot() {
    if (window.electronAPI) return window.electronAPI.getMediaSnapshot();
    return mediaCommand('snapshot');
}

export function onMediaEvent(callback) {
    if (window.electronAPI) return window.electronAPI.onMediaEvent(callback);
    listeners.add(callback);
    return () => listeners.delete(callback);
}
