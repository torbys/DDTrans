import { AUDIO_OUTPUT_SAMPLE_RATE, DEFAULT_AUDIO_ROUTING, normalizeAudioRouting, validateAudioRoutingPatch } from './audio-routing-config.js';

export { AUDIO_OUTPUT_SAMPLE_RATE, DEFAULT_AUDIO_ROUTING, normalizeAudioRouting };

export function classifyAudioDevices(devices = []) {
    const clean = kind => devices.filter(device => device.kind === kind && device.deviceId && device.deviceId !== 'communications').map(device => ({
        deviceId: device.deviceId,
        groupId: device.groupId || '',
        label: device.label || '',
        kind,
        likelyVirtual: /virtual|vb[- ]?audio|cable|voicemeeter|blackhole|loopback|wave link|soundflower|ddtrans|虚拟/i.test(device.label || ''),
    }));
    const inputs = clean('audioinput'), outputs = clean('audiooutput');
    return { inputs, outputs, virtualInputs: inputs.filter(device => device.likelyVirtual), virtualOutputs: outputs.filter(device => device.likelyVirtual) };
}

export function resolveAudioDevice(devices, id, label) {
    if (!id || id === 'default') return { deviceId: id, label: '' };
    const exact = devices.find(device => device.deviceId === id);
    if (exact) return { deviceId: exact.deviceId, label: exact.label };
    const matches = label ? devices.filter(device => device.deviceId !== 'default' && device.label === label) : [];
    return matches.length === 1 ? { deviceId: matches[0].deviceId, label: matches[0].label } : { deviceId: id, label, missing: true };
}

function disconnect(node) { try { node?.disconnect(); } catch (_) {} }
async function closeContext(context) { if (context && context.state !== 'closed') await context.close(); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createAudioMixBus({ routing = {}, onState = () => {}, onError = () => {} } = {}) {
    let config = normalizeAudioRouting(routing);
    let context, processor, originalGain, translatedGain, mixDestination, translatedDestination;
    let originalSource, translatedSource;
    let queue = Promise.resolve(), playbackAllowed = true, blockedReason = '', meterTimer;
    let levels = { original: 0, translated: 0, mix: 0, clippedSamples: 0 };
    let devices = { inputs: [], outputs: [] }, devicesKnown = false, lastTest = null;
    const routes = { monitor: null, virtual: null }, errors = { monitor: '', virtual: '' };
    const emit = () => onState(getSnapshot());
    function enqueue(action) {
        const operation = queue.then(action);
        queue = operation.catch(() => {});
        return operation;
    }
    function makeContext(sinkId = { type: 'none' }) {
        return new window.AudioContext({ sampleRate: AUDIO_OUTPUT_SAMPLE_RATE, latencyHint: 'interactive', sinkId });
    }
    async function initialize() {
        if (context) return;
        const next = makeContext();
        try {
            await next.audioWorklet.addModule(new URL('./mix-worklet.js', import.meta.url));
            processor = new AudioWorkletNode(next, 'ddtrans-mix', { numberOfInputs: 2, numberOfOutputs: 2, outputChannelCount: [1, 1], channelCount: 1, channelCountMode: 'explicit' });
            mixDestination = next.createMediaStreamDestination();
            translatedDestination = next.createMediaStreamDestination();
            for (const destination of [mixDestination, translatedDestination]) { destination.channelCount = 1; destination.channelCountMode = 'explicit'; }
            originalGain = next.createGain(); translatedGain = next.createGain();
            originalGain.channelCount = 1; originalGain.channelCountMode = 'explicit';
            translatedGain.channelCount = 1; translatedGain.channelCountMode = 'explicit';
            originalGain.connect(processor, 0, 0); translatedGain.connect(processor, 0, 1);
            processor.connect(mixDestination, 0); processor.connect(translatedDestination, 1);
            processor.port.onmessage = ({ data }) => { if (data?.type === 'level') levels = data.levels; };
            processor.onprocessorerror = () => { blockedReason = '混音处理已中断，请暂停后重新收音'; void enqueue(async () => { await closeGraph(); emit(); }).catch(onError); onError(new Error(blockedReason)); };
            context = next;
            applyGains();
            await next.resume();
            meterTimer = setInterval(emit, 500);
        } catch (error) { await closeContext(next); context = null; throw error; }
    }
    function applyGains() {
        if (!context) return;
        originalGain.gain.setTargetAtTime(config.originalGain, context.currentTime, 0.01);
        translatedGain.gain.setTargetAtTime(config.ttsEnabled && playbackAllowed ? config.translatedGain : 0, context.currentTime, 0.01);
    }
    async function closeRoute(kind) {
        const route = routes[kind]; routes[kind] = null;
        if (!route) return;
        route.context.onerror = null;
        disconnect(route.source); disconnect(route.gain);
        await closeContext(route.context);
    }
    async function syncRoute(kind) {
        const monitor = kind === 'monitor';
        const enabled = monitor ? config.monitorEnabled : config.virtualOutputEnabled;
        const deviceId = monitor ? config.monitorDeviceId : config.virtualRenderDeviceId;
        const mode = monitor ? config.monitorMode : 'mix';
        const route = routes[kind];
        if (!context || !enabled || !deviceId || blockedReason) { await closeRoute(kind); if (!enabled) errors[kind] = ''; return; }
        if (devicesKnown && !devices.outputs.some(device => device.deviceId === deviceId)) {
            await closeRoute(kind); errors[kind] = '设备已断开，请重新选择或连接设备'; return;
        }
        const monitorDevice = devices.outputs.find(device => device.deviceId === config.monitorDeviceId);
        const renderDevice = devices.outputs.find(device => device.deviceId === config.virtualRenderDeviceId);
        const sameOutput = config.monitorDeviceId === config.virtualRenderDeviceId || Boolean(config.monitorDeviceId === 'default' && monitorDevice?.label.replace(/^Default - /, '') === renderDevice?.label);
        if (monitor && config.virtualOutputEnabled && sameOutput) {
            await closeRoute(kind); errors.monitor = '监听与虚拟输出选中了同一个设备，请选择耳机作为监听设备或关闭监听'; return;
        }
        const volume = monitor ? config.monitorVolume : 1;
        if (route?.deviceId === deviceId && route.mode === mode) {
            route.gain.gain.setTargetAtTime(volume, route.context.currentTime, 0.01); return;
        }
        await closeRoute(kind);
        const next = makeContext();
        try {
            await next.setSinkId(deviceId === 'default' ? '' : deviceId);
            const source = next.createMediaStreamSource((mode === 'translated' ? translatedDestination : mixDestination).stream);
            const gain = next.createGain(); gain.gain.value = volume;
            source.connect(gain); gain.connect(next.destination);
            next.onerror = () => {
                if (routes[kind]?.context !== next) return;
                errors[kind] = '设备播放失败或已断开，请检查连接';
                void enqueue(async () => { if (routes[kind]?.context !== next) return; await closeRoute(kind); emit(); }).catch(onError);
            };
            await next.resume();
            routes[kind] = { context: next, source, gain, deviceId, mode };
            errors[kind] = '';
        } catch (error) {
            await closeContext(next);
            errors[kind] = `无法打开${monitor ? '监听' : '输出'}设备：${error.message}`;
            onError(new Error(errors[kind]));
        }
    }
    async function syncRoutes() { await Promise.all([syncRoute('monitor'), syncRoute('virtual')]); emit(); }
    async function connectStream(kind, stream) {
        if (!stream?.getAudioTracks().some(track => track.readyState !== 'ended')) throw new Error('音频流已结束');
        await initialize();
        const source = context.createMediaStreamSource(stream);
        if (kind === 'original') {
            disconnect(originalSource); originalSource = source; source.connect(originalGain);
        } else {
            disconnect(translatedSource); translatedSource = source; source.connect(translatedGain);
        }
        await syncRoutes();
    }
    async function closeGraph() {
        clearInterval(meterTimer); meterTimer = null;
        await Promise.all([closeRoute('monitor'), closeRoute('virtual')]);
        disconnect(originalSource); disconnect(translatedSource); disconnect(originalGain); disconnect(translatedGain);
        if (processor) { processor.onprocessorerror = null; processor.port.onmessage = null; processor.port.close(); disconnect(processor); }
        for (const destination of [mixDestination, translatedDestination]) destination?.stream.getTracks().forEach(track => track.stop());
        await closeContext(context);
        context = processor = originalGain = translatedGain = mixDestination = translatedDestination = originalSource = translatedSource = null;
        levels = { original: 0, translated: 0, mix: 0, clippedSamples: 0 };
    }
    async function testTone({ target = 'monitor', verifyCapture = false } = {}) {
        if (!['monitor', 'virtual'].includes(target)) throw new Error('请选择监听或虚拟输出测试');
        const outputId = target === 'virtual' ? config.virtualRenderDeviceId : config.monitorDeviceId;
        if (!outputId) throw new Error('请先选择输出设备');
        const render = devices.outputs.find(device => device.deviceId === outputId);
        const input = devices.inputs.find(device => device.deviceId === config.virtualCaptureDeviceId);
        if (verifyCapture && (!input || !render)) throw new Error('请先选择输出及配对输入，再检测连接');
        let testContext, stream, analyser, source, oscillator, gain;
        try {
            testContext = makeContext();
            await testContext.setSinkId(outputId === 'default' ? '' : outputId);
            await testContext.resume();
            if (verifyCapture) {
                stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: input.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
                analyser = testContext.createAnalyser(); analyser.fftSize = 2048;
                source = testContext.createMediaStreamSource(stream); source.connect(analyser);
            }
            oscillator = testContext.createOscillator(); oscillator.frequency.value = 997;
            gain = testContext.createGain(); gain.gain.value = 0.08;
            oscillator.connect(gain); gain.connect(testContext.destination); oscillator.start();
            let signal = 0;
            const samples = new Float32Array(2048);
            for (let i = 0; i < 8; i++) {
                await wait(100);
                if (!analyser) continue;
                analyser.getFloatTimeDomainData(samples);
                let real = 0, imaginary = 0;
                for (let j = 0; j < samples.length; j++) { const phase = 2 * Math.PI * 997 * j / testContext.sampleRate; real += samples[j] * Math.cos(phase); imaginary += samples[j] * Math.sin(phase); }
                signal = Math.max(signal, 2 * Math.hypot(real, imaginary) / samples.length);
            }
            lastTest = { target, outputDeviceId: outputId, captureDeviceId: verifyCapture ? input.deviceId : '', captureVerified: verifyCapture && signal > 0.005, signalAmplitude: verifyCapture ? signal : null, testedAt: Date.now() };
            if (verifyCapture && !lastTest.captureVerified) throw new Error('输出设备已打开，但配对输入未收到测试音，请检查虚拟设备的配对关系');
            return lastTest;
        } finally {
            try { oscillator?.stop(); } catch (_) {}
            disconnect(source); disconnect(oscillator); disconnect(gain);
            stream?.getTracks().forEach(track => track.stop());
            await closeContext(testContext); emit();
        }
    }
    function getSnapshot() {
        const activeRoutes = Object.values(routes).filter(Boolean);
        const latency = activeRoutes.length ? Math.max(...activeRoutes.map(route => (Number(route.context.baseLatency || 0) + Number(route.context.outputLatency || 0)) * 1000)) : null;
        const status = blockedReason ? 'blocked' : config.virtualOutputEnabled ? (!config.virtualRenderDeviceId ? 'needs-device' : errors.virtual ? 'error' : routes.virtual ? 'outputting' : 'waiting') : routes.monitor ? 'monitoring' : 'idle';
        const test = lastTest?.outputDeviceId === config.virtualRenderDeviceId && lastTest.captureDeviceId === config.virtualCaptureDeviceId ? lastTest : null;
        return { ...config, status, active: Boolean(context), monitorOutputReady: Boolean(routes.monitor), virtualOutputReady: Boolean(routes.virtual), monitorError: errors.monitor, virtualError: errors.virtual, error: blockedReason || errors.virtual || errors.monitor, levels: { ...levels }, estimatedLatencyMs: latency === null ? null : Math.round(latency), underruns: null, lastTest: test };
    }
    return {
        connectOriginalStream: stream => enqueue(() => connectStream('original', stream)),
        connectTranslatedStream: stream => enqueue(() => connectStream('translated', stream)),
        disconnectOriginalStream: () => enqueue(() => { disconnect(originalSource); originalSource = null; }),
        disconnectTranslatedStream: () => enqueue(() => { disconnect(translatedSource); translatedSource = null; }),
        setRouting: patch => {
            const validated = validateAudioRoutingPatch(patch);
            return enqueue(async () => { config = normalizeAudioRouting({ ...config, ...validated }); applyGains(); if (context) await syncRoutes(); else emit(); return getSnapshot(); });
        },
        setPlaybackAllowed: (allowed, reason = '') => enqueue(async () => { playbackAllowed = Boolean(allowed); blockedReason = reason; applyGains(); if (context) await syncRoutes(); }),
        updateDevices: report => enqueue(async () => { devices = report; devicesKnown = true; if (context) await syncRoutes(); return getSnapshot(); }),
        testTone: options => enqueue(() => testTone(options)),
        getOutputStream: () => mixDestination?.stream || null,
        stop: () => enqueue(async () => { await closeGraph(); emit(); }),
        getSnapshot,
    };
}
