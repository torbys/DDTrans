export const CAPTURE_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 48000;
const FRAME_DURATION_MS = 20;
const FRAME_SAMPLES = CAPTURE_SAMPLE_RATE * FRAME_DURATION_MS / 1000;
const WORKLET_MODULE_TIMEOUT_MS = 10000;

function stopTracks(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
        try { track.stop(); } catch (_) {}
    }
}

function disconnect(node) {
    if (!node) return;
    try { node.disconnect(); } catch (_) {}
}

function createAudioContext() {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) throw new Error('AudioContext is not supported');
    return new AudioContextConstructor({ sampleRate: OUTPUT_SAMPLE_RATE });
}

function withTimeout(promise, timeoutMs, message) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function getMicConstraints(deviceId) {
    const audio = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
    };
    if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
    return { audio };
}

export async function getSystemAudioStreamOnly() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        throw new Error('当前环境不支持系统音频采集');
    }

    let stream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            audio: { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            video: true,
        });
    }
    catch (error) { throw new Error('无法采集电脑声音（' + error.name + '）：' + error.message); }
    if (stream.getAudioTracks().length === 0) {
        stopTracks(stream);
        throw new Error('未获取到系统音频轨道，请在系统共享选择器中启用共享音频');
    }

    for (const track of stream.getVideoTracks()) track.stop();

    return stream;
}

export async function getMicAudioStream(deviceId = 'default') {
    const stream = await navigator.mediaDevices.getUserMedia(getMicConstraints(deviceId));
    if (stream.getAudioTracks().length === 0) {
        stopTracks(stream);
        throw new Error('未获取到麦克风音频轨道');
    }
    return stream;
}

export async function createAudioCapture({
    useSystemAudio,
    useMicAudio,
    deviceId,
    initiallyPaused = false,
    onFrame = () => {},
    onLevel = () => {},
    onError = () => {},
} = {}) {
    if (!useSystemAudio && !useMicAudio) {
        throw new Error('请至少选择一个音频源');
    }

    let systemStream = null;
    let micStream = null;
    let mixedStream = null;
    let context = null;
    let workletNode = null;
    let silentGain = null;
    let destination = null;
    const sources = [];
    const gains = [];
    const outputGains = [];
    let paused = initiallyPaused;
    let stopped = false;
    let failureNotified = false;

    function notifyError(error) {
        if (stopped || failureNotified) return;
        failureNotified = true;
        console.error('[AudioCapture]', error);
        try {
            onError(error);
        } catch (callbackError) {
            console.error('[AudioCapture] Error callback failed', callbackError);
        }
    }

    async function stop() {
        if (stopped) return;
        stopped = true;
        if (workletNode) workletNode.port.onmessage = null;
        disconnect(workletNode);
        disconnect(silentGain);
        disconnect(destination);
        for (const gain of gains) disconnect(gain);
        for (const source of sources) disconnect(source);
        stopTracks(mixedStream);
        stopTracks(systemStream);
        stopTracks(micStream);
        if (context && context.state !== 'closed') await context.close();
        mixedStream = null;
        systemStream = null;
        micStream = null;
        context = null;
        workletNode = null;
        silentGain = null;
        destination = null;
    }

    try {
        if (useSystemAudio) systemStream = await getSystemAudioStreamOnly();
        if (useMicAudio) micStream = await getMicAudioStream(deviceId || 'default');

        context = createAudioContext();
        await withTimeout(
            context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url)),
            WORKLET_MODULE_TIMEOUT_MS,
            `AudioWorklet 模块加载超时（${WORKLET_MODULE_TIMEOUT_MS / 1000}s）`,
        );
        await context.resume();
        if (context.sampleRate !== CAPTURE_SAMPLE_RATE) {
            console.info(`[AudioCapture] AudioContext 使用 ${context.sampleRate}Hz，Worklet 将重采样到 ${CAPTURE_SAMPLE_RATE}Hz`);
        }

        destination = context.createMediaStreamDestination();
        workletNode = new AudioWorkletNode(context, 'pcm-capture-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
                inputSampleRate: context.sampleRate,
                targetSampleRate: CAPTURE_SAMPLE_RATE,
                frameSamples: FRAME_SAMPLES,
            },
        });
        silentGain = context.createGain();
        silentGain.gain.value = 0;
        workletNode.port.postMessage({ type: 'pause', paused });
        workletNode.connect(silentGain);
        silentGain.connect(context.destination);

        const inputStreams = [systemStream, micStream].filter(Boolean);
        const modelInputGain = inputStreams.length > 1 ? 1 / inputStreams.length : 1;
        for (const stream of inputStreams) {
            if (!stream) continue;
            const source = context.createMediaStreamSource(stream);
            const modelGain = context.createGain();
            modelGain.gain.value = modelInputGain;
            const outputGain = context.createGain();
            outputGain.gain.value = paused ? 0 : 1;
            source.connect(modelGain);
            source.connect(outputGain);
            modelGain.connect(workletNode);
            outputGain.connect(destination);
            sources.push(source);
            gains.push(modelGain, outputGain);
            outputGains.push(outputGain);
        }

        mixedStream = destination.stream;
        for (const stream of inputStreams) {
            for (const track of stream.getAudioTracks()) {
                track.addEventListener('ended', () => {
                    notifyError(new Error(`音频输入已结束: ${track.label || track.id}`));
                }, { once: true });
            }
        }
        workletNode.port.onmessage = (event) => {
            const data = event.data;
            if (stopped || !data || data.type !== 'pcm') return;
            const pcm = new Int16Array(data.pcm);
            const frame = {
                pcm,
                sampleOffset: data.sampleOffset,
                timeMs: data.sampleOffset * 1000 / CAPTURE_SAMPLE_RATE,
                sampleRate: CAPTURE_SAMPLE_RATE,
            };
            onLevel(data.level);
            if (!paused) onFrame(frame);
        };
        workletNode.onprocessorerror = () => {
            notifyError(new Error('AudioWorklet processor failed'));
        };
    } catch (error) {
        await stop();
        throw error;
    }

    function pause() {
        if (stopped || paused) return;
        paused = true;
        for (const gain of outputGains) gain.gain.setValueAtTime(0, context.currentTime);
        workletNode.port.postMessage({ type: 'pause', paused: true });
    }

    function resume() {
        if (stopped || !paused) return;
        paused = false;
        for (const gain of outputGains) gain.gain.setValueAtTime(1, context.currentTime);
        workletNode.port.postMessage({ type: 'pause', paused: false });
    }

    function start() {
        resume();
    }

    return {
        start,
        pause,
        resume,
        stop,
        stream: mixedStream,
        sampleRate: CAPTURE_SAMPLE_RATE,
        isolatedSystemAudio: !useSystemAudio || systemStream?.getAudioTracks()[0]?.getSettings().restrictOwnAudio === true,
    };
}
