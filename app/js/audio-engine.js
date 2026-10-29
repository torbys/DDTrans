const DEFAULT_SAMPLE_RATE = 24000;
const MAX_BUFFER_SECONDS = 10;
const SCHEDULE_AHEAD_SECONDS = 0.25;
const START_DELAY_SECONDS = 0.02;
const MAX_CHUNK_SECONDS = 0.1;

export function createPcmPlayer({
    sampleRate = DEFAULT_SAMPLE_RATE,
    onState = () => {},
    onError = () => {},
    outputDeviceId = 'default',
    volume = 1,
    streamOutput = false,
} = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        throw new TypeError('sampleRate must be a positive number');
    }

    let context = null;
    let outputGain = null;
    let outputDestination = null;
    let outputVolume = Math.max(0, Math.min(1, volume));
    let deviceId = outputDeviceId;
    let paused = false;
    let stopped = false;
    let generation = 0;
    let nextStartTime = 0;
    let queuedSamples = 0;
    let queue = [];
    const scheduled = new Set();

    function reportError(error) {
        console.error('[AudioPlayer]', error);
        try {
            onError(error);
        } catch (callbackError) {
            console.error('[AudioPlayer] Error callback failed', callbackError);
        }
    }

    function reportState(state) {
        onState(state);
    }

    function createContext() {
        if (context && context.state !== 'closed') return context;
        const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextConstructor) throw new Error('AudioContext is not supported');
        const options = { sampleRate, latencyHint: 'interactive' };
        if (streamOutput) options.sinkId = { type: 'none' };
        if (!streamOutput && deviceId && deviceId !== 'default') options.sinkId = deviceId;
        context = new AudioContextConstructor(options);
        outputGain = context.createGain();
        outputGain.gain.value = outputVolume;
        if (streamOutput) {
            outputDestination = context.createMediaStreamDestination();
            outputGain.connect(outputDestination);
        } else {
            outputGain.connect(context.destination);
        }
        context.onstatechange = () => {
            if (!stopped && !paused && context && context.state === 'suspended') {
                reportState('paused');
            }
        };
        return context;
    }

    function getRemainingScheduledSamples(now = context ? context.currentTime : 0) {
        let samples = 0;
        for (const entry of scheduled) {
            const played = Math.max(0, Math.min(entry.samples.length, Math.floor((now - entry.startTime) * sampleRate)));
            samples += entry.samples.length - played;
        }
        return samples;
    }

    function getBufferedSamples() {
        return queuedSamples + getRemainingScheduledSamples();
    }

    function decodePcm(pcmBytes) {
        let bytes;
        if (pcmBytes instanceof ArrayBuffer) {
            bytes = new Uint8Array(pcmBytes);
        } else if (pcmBytes instanceof Uint8Array) {
            bytes = pcmBytes;
        } else {
            throw new TypeError('pcmBytes must be an ArrayBuffer or Uint8Array');
        }

        if (bytes.byteLength % 2 !== 0) {
            throw new RangeError('PCM payload must contain complete 16-bit samples');
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const samples = new Int16Array(bytes.byteLength / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
        return samples;
    }

    function schedule() {
        if (paused || stopped || queue.length === 0) return;

        try {
            const audioContext = createContext();
            if (audioContext.state === 'suspended') {
                audioContext.resume().catch(reportError);
            }

            const now = audioContext.currentTime;
            if (nextStartTime < now + START_DELAY_SECONDS) {
                nextStartTime = now + START_DELAY_SECONDS;
            }

            while (queue.length > 0 && nextStartTime < now + SCHEDULE_AHEAD_SECONDS) {
                const samples = queue[0];
                scheduleChunk(samples, nextStartTime, generation);
                queue.shift();
                queuedSamples -= samples.length;
                nextStartTime += samples.length / sampleRate;
            }

            if (scheduled.size > 0) reportState('playing');
        } catch (error) {
            reportError(error);
            throw error;
        }
    }

    function scheduleChunk(samples, startTime, sourceGeneration) {
        const audioContext = createContext();
        const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
        const channel = buffer.getChannelData(0);
        for (let index = 0; index < samples.length; index += 1) {
            channel[index] = samples[index] / 0x8000;
        }

        const source = audioContext.createBufferSource();
        const entry = { source, samples, startTime };
        source.buffer = buffer;
        source.connect(outputGain);
        source.onended = () => {
            scheduled.delete(entry);
            try { source.disconnect(); } catch (_) {}
            if (stopped || paused || sourceGeneration !== generation) return;
            if (scheduled.size === 0 && queue.length === 0) reportState('idle');
            try {
                schedule();
            } catch (_) {}
        };
        scheduled.add(entry);
        source.start(startTime);
    }

    function cancelScheduled(keepRemainder) {
        const now = context ? context.currentTime : 0;
        const remainder = [];

        for (const entry of [...scheduled].sort((left, right) => left.startTime - right.startTime)) {
            if (keepRemainder) {
                const played = Math.max(0, Math.min(entry.samples.length, Math.floor((now - entry.startTime) * sampleRate)));
                if (played < entry.samples.length) remainder.push(entry.samples.subarray(played));
            }
            try { entry.source.stop(); } catch (_) {}
            try { entry.source.disconnect(); } catch (_) {}
        }
        scheduled.clear();
        return remainder;
    }

    function append(pcmBytes) {
        if (stopped) {
            const error = new Error('Audio player has been stopped');
            reportError(error);
            throw error;
        }

        let samples;
        try {
            samples = decodePcm(pcmBytes);
        } catch (error) {
            reportError(error);
            throw error;
        }
        if (samples.length === 0) return;

        if (getBufferedSamples() + samples.length > sampleRate * MAX_BUFFER_SECONDS) {
            const error = new Error(`Audio buffer exceeds ${MAX_BUFFER_SECONDS} seconds`);
            error.code = 'AUDIO_BUFFER_OVERFLOW';
            reportError(error);
            throw error;
        }

        const chunkSamples = Math.max(1, Math.floor(sampleRate * MAX_CHUNK_SECONDS));
        for (let offset = 0; offset < samples.length; offset += chunkSamples) {
            const chunk = samples.subarray(offset, Math.min(offset + chunkSamples, samples.length));
            queue.push(chunk);
            queuedSamples += chunk.length;
        }
        schedule();
    }

    async function pause() {
        if (stopped || paused) return;
        paused = true;
        generation += 1;
        const remainder = cancelScheduled(true);
        queue = [...remainder, ...queue];
        queuedSamples = queue.reduce((total, samples) => total + samples.length, 0);
        nextStartTime = 0;
        if (context && context.state === 'running') await context.suspend();
        reportState('paused');
    }

    async function resume() {
        if (stopped || !paused) return;
        paused = false;
        const audioContext = createContext();
        if (audioContext.state === 'suspended') await audioContext.resume();
        schedule();
        if (queue.length === 0 && scheduled.size === 0) reportState('idle');
    }

    async function stop() {
        if (stopped) return;
        stopped = true;
        paused = false;
        generation += 1;
        cancelScheduled(false);
        queue = [];
        queuedSamples = 0;
        nextStartTime = 0;
        const audioContext = context;
        context = null;
        outputGain?.disconnect(); outputGain = null;
        outputDestination = null;
        if (audioContext && audioContext.state !== 'closed') await audioContext.close();
        reportState('stopped');
    }

    async function setOutputDevice(id) {
        if (typeof id !== 'string' || !id) throw new TypeError('output device id must be a non-empty string');
        deviceId = id;
        if (!context || context.state === 'closed') return;
        if (typeof context.setSinkId !== 'function') {
            const error = new Error('Output device selection is not supported in this runtime');
            reportError(error);
            throw error;
        }
        try {
            await context.setSinkId(deviceId);
        } catch (error) {
            reportError(error);
            throw error;
        }
    }

    function setVolume(value) {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('volume must be between 0 and 1');
        outputVolume = value;
        if (outputGain && context) outputGain.gain.setTargetAtTime(value, context.currentTime, 0.015);
    }

    function getOutputStream() {
        createContext();
        return outputDestination?.stream || null;
    }

    function getDiagnostics() { return { bufferedMs: Math.round(getBufferedSamples() * 1000 / sampleRate), maxBufferedMs: MAX_BUFFER_SECONDS * 1000 }; }

    return { append, pause, resume, stop, setOutputDevice, setVolume, getOutputStream, getDiagnostics };
}
