import { LANG_DATA, TEXT_ONLY_LANGS } from './config.js';
import { DEFAULT_AUDIO_ROUTING, normalizeAudioRouting, validateAudioRoutingPatch } from './audio-routing-config.js';
import { resolveAudioDevice, resolveDDTransVirtualPair, resolveOutgoingMicrophone } from './audio-mix-bus.js';

const activePhases = new Set(['starting', 'running', 'pausing', 'paused', 'stopping']);
const languages = new Set(LANG_DATA.map(language => language.code));

export function createMediaSession({ createCapture, createPlayer, createSocket, createMixBus = null, publish = () => {}, capabilities = {}, audioSettings = {}, saveAudioSettings = async () => {}, enumerateDevices = null, requestAudioPermission = null, loadHotwords = () => [], now = Date.now }) {
    let phase = 'idle', sessionId = null, capture = null, player = null, socket = null;
    let queue = Promise.resolve(), stopping = null, clock = null, accumulatedMs = 0, activeStart = 0;
    let ttsEnabled = true, ttsVolume = 0.8, note = '', noteTimer = null, noteDirty = false, lastLevel = 0;
    let audioRouting = normalizeAudioRouting(audioSettings), mixBus = null;
    ttsVolume = audioRouting.ttsVolume;
    ttsEnabled = audioRouting.ttsEnabled;
    let playbackGeneration = 0, playbackQueue = Promise.resolve(), releasing = Promise.resolve(), pendingAudioBytes = 0;
    let deviceReport = { inputs: [], outputs: [] };
    let feedback = { message: '准备就绪', kind: 'info' };
    let config = { mode: 'listening', meetingName: '', targetLanguage: 'zh', useSystemAudio: true, useMicAudio: false, deviceId: 'default', audioEnabled: true, hotwords: [] };
    let mediaCapabilities = { systemAudio: false, isolatedTts: false, ...capabilities };
    const segments = new Map(), waiters = new Set();
    const elapsed = () => accumulatedMs + (phase === 'running' ? now() - activeStart : 0);
    const sortedSegments = () => [...segments.values()].sort((a, b) => a.sequence_order - b.sequence_order);
    function currentRouting(next = audioRouting) {
        return { ...next, originalGain: config.mode === 'outgoing' && activePhases.has(phase) ? next.outgoingOriginalGain : next.originalGain };
    }
    function audioRoutingSnapshot() {
        return { ...audioRouting, ...(mixBus?.getSnapshot?.() || {}), originalGain: currentRouting().originalGain, bufferedMs: player?.getDiagnostics?.().bufferedMs ?? 0, maxBufferedMs: player?.getDiagnostics?.().maxBufferedMs ?? 10000 };
    }
    function snapshot(includeSegments = true) {
        return { phase, sessionId, config: { ...config }, ttsEnabled, ttsVolume, audioRouting: audioRoutingSnapshot(), elapsedMs: elapsed(), note, feedback: { ...feedback }, capabilities: { ...mediaCapabilities }, ...(includeSegments ? { segments: sortedSegments() } : {}) };
    }
    const broadcast = () => publish({ type: 'snapshot', snapshot: snapshot(false) });
    function inform(message, kind = 'info') { feedback = { message, kind }; publish({ type: 'feedback', ...feedback }); }
    if (createMixBus) mixBus = createMixBus({
        routing: audioRouting,
        onState: state => publish({ type: 'audio-routing', audioRouting: { ...state, originalGain: currentRouting().originalGain, bufferedMs: player?.getDiagnostics?.().bufferedMs ?? 0, maxBufferedMs: 10000 } }),
        onError: error => inform('音频输出：' + error.message, 'warning'),
    });
    async function refreshDevices() {
        if (!enumerateDevices) return deviceReport;
        deviceReport = await enumerateDevices();
        const patch = {};
        const outgoing = config.mode === 'outgoing' && activePhases.has(phase);
        const pair = outgoing ? resolveDDTransVirtualPair(deviceReport) : null;
        if (outgoing && !pair.available) await mixBus?.setPlaybackAllowed(false, pair.message);
        for (const [idKey, labelKey, devices] of [
            ['monitorDeviceId', 'monitorDeviceLabel', deviceReport.outputs],
            ['virtualRenderDeviceId', 'virtualRenderDeviceLabel', deviceReport.outputs],
            ['virtualCaptureDeviceId', 'virtualCaptureDeviceLabel', deviceReport.inputs],
        ]) {
            if (outgoing && idKey.startsWith('virtual')) continue;
            const resolved = resolveAudioDevice(devices, audioRouting[idKey], audioRouting[labelKey]);
            if (!resolved.missing) { patch[idKey] = resolved.deviceId; patch[labelKey] = resolved.label; }
        }
        if (pair?.available) Object.assign(patch, {
            virtualRenderDeviceId: pair.render.deviceId, virtualRenderDeviceLabel: pair.render.label,
            virtualCaptureDeviceId: pair.capture.deviceId, virtualCaptureDeviceLabel: pair.capture.label,
        });
        const next = normalizeAudioRouting({ ...audioRouting, ...patch });
        if (JSON.stringify(next) !== JSON.stringify(audioRouting)) { await saveAudioSettings(next); audioRouting = next; await mixBus?.setRouting(currentRouting()); }
        await mixBus?.updateDevices(deviceReport);
        publish({ type: 'audio-devices', devices: deviceReport });
        if (outgoing && !pair.available && phase === 'running') {
            await pause();
            inform('DDTrans 虚拟麦克风不可用，已暂停发言翻译。请恢复设备后继续。', 'warning');
        }
        return deviceReport;
    }
    function checkInputLoop(nextConfig, routing) {
        if (!nextConfig.useMicAudio || !routing.virtualOutputEnabled || !routing.virtualCaptureDeviceId) return;
        const selected = deviceReport.inputs.find(device => device.deviceId === nextConfig.deviceId);
        const virtual = deviceReport.inputs.find(device => device.deviceId === routing.virtualCaptureDeviceId);
        if (nextConfig.deviceId === routing.virtualCaptureDeviceId || (nextConfig.deviceId === 'default' && selected?.label.replace(/^Default - /, '') === virtual?.label)) throw new Error('同传输入选中了正在输出的虚拟麦克风，请改选真实麦克风，避免重复翻译');
    }
    async function applyAudioRouting(patch, inputConfig = config) {
        const validated = validateAudioRoutingPatch(patch);
        if (config.mode === 'outgoing' && activePhases.has(phase) && Object.hasOwn(validated, 'originalGain')) {
            validated.outgoingOriginalGain = validated.originalGain;
            delete validated.originalGain;
        }
        const next = normalizeAudioRouting({ ...audioRouting, ...validated });
        if (config.mode === 'outgoing' && activePhases.has(phase) && Object.keys(validated).some(key => key.startsWith('virtual'))) {
            const pair = resolveDDTransVirtualPair(deviceReport);
            if (!pair.available || !next.virtualOutputEnabled || next.virtualRenderDeviceId !== pair.render.deviceId || next.virtualCaptureDeviceId !== pair.capture.deviceId) throw new Error('发言翻译固定使用 DDTrans 虚拟麦克风。请先停止发言翻译，再更改输出设备。');
        }
        checkInputLoop(inputConfig, next);
        await saveAudioSettings(next);
        audioRouting = next; ttsVolume = next.ttsVolume;
        ttsEnabled = next.ttsEnabled && !TEXT_ONLY_LANGS.includes(config.targetLanguage) && (!activePhases.has(phase) || config.audioEnabled);
        player?.setVolume(ttsVolume);
        await mixBus?.setRouting(currentRouting());
        if (!ttsEnabled) await releasePlayer();
        broadcast();
    }
    function setPhase(next) {
        if (phase === next) return;
        if (phase === 'running') accumulatedMs += now() - activeStart;
        if (next === 'running') activeStart = now();
        phase = next;
        if (phase === 'running' && !clock) clock = setInterval(() => publish({ type: 'clock', elapsedMs: elapsed() }), 500);
        if (phase !== 'running') { clearInterval(clock); clock = null; publish({ type: 'clock', elapsedMs: elapsed() }); }
        broadcast();
    }
    function waitFor(check, timeoutMs = 40000) {
        let entry;
        const promise = new Promise((resolve, reject) => {
            entry = { check, resolve, reject };
            entry.timer = setTimeout(() => { waiters.delete(entry); reject(new Error('等待服务端确认超时，请查看会议记录')); }, timeoutMs);
            waiters.add(entry);
        });
        // A send failure can occur before the command begins awaiting the reply.
        promise.catch(() => {});
        return promise;
    }
    function notify(message) {
        for (const entry of [...waiters]) {
            if (entry.check(message)) { clearTimeout(entry.timer); waiters.delete(entry); entry.resolve(message); }
            else if (message.closed || message.type === 'error' && phase === 'starting') {
                clearTimeout(entry.timer); waiters.delete(entry); entry.reject(new Error(message.message));
            }
        }
    }
    function send(message) {
        if (socket?.readyState !== 1) throw new Error('本地连接已断开');
        socket.send(JSON.stringify(message));
    }
    async function releaseCapture() {
        const old = capture; capture = null;
        await mixBus?.disconnectOriginalStream(); await old?.stop();
        publish({ type: 'level', level: 0 });
    }
    async function releasePlayer() {
        playbackGeneration++;
        const old = player; player = null;
        await mixBus?.disconnectTranslatedStream(); await old?.stop();
    }
    function releaseMedia() {
        releasing = releasing.then(async () => { await releaseCapture(); await releasePlayer(); await mixBus?.stop(); });
        return releasing;
    }
    function canPlay() { return config.audioEnabled && ttsEnabled && (!config.useSystemAudio || mediaCapabilities.isolatedTts); }
    async function ensurePlayer() {
        if (!canPlay() || player) return;
        player = createPlayer({ sampleRate: 24000, volume: ttsVolume, streamOutput: Boolean(mixBus), onError(error) {
            inform('译音播放已停止：' + error.message + '。译音仍会保存到记录。', 'error');
            ttsEnabled = false; void releasePlayer(); broadcast();
        } });
        const stream = player.getOutputStream?.();
        if (stream) await mixBus?.connectTranslatedStream(stream);
    }
    async function makeCapture() {
        if (config.mode === 'outgoing') {
            const source = resolveOutgoingMicrophone(deviceReport, config.deviceId);
            if (!source.available) throw new Error(source.message);
            const pair = resolveDDTransVirtualPair(deviceReport);
            if (!pair.available) throw new Error(pair.message);
            if (audioRouting.virtualRenderDeviceId !== pair.render.deviceId || audioRouting.virtualCaptureDeviceId !== pair.capture.deviceId || !audioRouting.virtualOutputEnabled) throw new Error('DDTrans 虚拟麦克风配对已改变，请停止后重新开始发言翻译。');
            await mixBus.setRouting(currentRouting());
        }
        const current = await createCapture({
            useSystemAudio: config.useSystemAudio, useMicAudio: config.useMicAudio, deviceId: config.deviceId, initiallyPaused: true,
            onFrame({ pcm }) {
                if (phase !== 'running' || socket?.readyState !== 1) return;
                if (socket.bufferedAmount > 64000) {
                    capture?.pause();
                    inform('音频发送积压超过2秒，正在结束并保存。', 'error');
                    void execute('stop').catch(error => inform(error.message, 'error')); return;
                }
                socket.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
            },
            onLevel(level) {
                if (now() - lastLevel < 100) return;
                lastLevel = now(); publish({ type: 'level', level: phase === 'running' ? level : 0 });
            },
            onError(error) {
                const message = '收音已停止：' + error.message;
                inform(message, 'error');
                if (phase === 'starting') { notify({ type: 'error', message }); socket?.close(); }
                else if (activePhases.has(phase)) void execute('stop').then(() => inform(message + '。已收到的内容已保存。', 'error')).catch(error => inform(error.message, 'error'));
            },
        });
        if (config.useSystemAudio) mediaCapabilities.isolatedTts = Boolean(capabilities.isolatedTts && current.isolatedSystemAudio);
        try {
            await mixBus?.setPlaybackAllowed(!config.useSystemAudio || mediaCapabilities.isolatedTts, config.useSystemAudio && !mediaCapabilities.isolatedTts ? '当前系统无法排除本应用声音，已暂停监听及虚拟输出以免重复采集' : '');
            if (current.stream) await mixBus?.connectOriginalStream(current.stream);
            if (config.mode === 'outgoing' && !mixBus.getSnapshot().virtualOutputReady) throw new Error(mixBus.getSnapshot().virtualError || '无法打开 DDTrans Virtual Input，发言翻译尚未启动。');
            return current;
        } catch (error) { await current.stop(); throw error; }
    }
    function handleMessage(message) {
        if (message.type === 'ready') sessionId = message.session_id;
        if (message.type === 'state') setPhase(message.state);
        if (message.type === 'segment') {
            const previous = segments.get(message.segment.segment_key);
            const segment = { ...previous, ...message.segment };
            segments.set(segment.segment_key, segment); publish({ type: 'segment', segment });
        }
        if (message.type === 'audio' && phase === 'running' && canPlay()) {
            const generation = playbackGeneration;
            const bytes = Uint8Array.from(atob(message.audio), char => char.charCodeAt(0));
            if (pendingAudioBytes + bytes.byteLength > 480000) {
                ttsEnabled = false; void releasePlayer();
                inform('译音待播超过 10 秒，已停止播报。字幕和译音记录仍会保存，可手动重新开启。', 'warning'); broadcast(); return;
            }
            pendingAudioBytes += bytes.byteLength;
            playbackQueue = playbackQueue.then(async () => {
                if (generation !== playbackGeneration || phase !== 'running' || !canPlay()) return;
                await ensurePlayer();
                if (generation === playbackGeneration && phase === 'running' && canPlay()) player?.append(bytes);
            }).catch(error => { inform('译音播放失败：' + error.message, 'error'); void releasePlayer(); }).finally(() => { pendingAudioBytes -= bytes.byteLength; });
        }
        if (message.type === 'stopped') {
            void releaseMedia().catch(error => inform(error.message, 'error')); setPhase('stopped');
            inform(message.status === 'completed' ? '本次同传已完整保存。' : '已保存收到的内容，部分结果未完整返回；请查看记录。', message.status === 'completed' ? 'success' : 'warning');
        }
        if (message.type === 'error' || message.type === 'warning') inform(message.message, message.type);
        notify(message);
    }
    function normalizeOptions(options) {
        const next = { ...config, ...options };
        if (!['listening', 'outgoing'].includes(next.mode)) throw new Error('不支持的同传模式');
        if (!languages.has(next.targetLanguage)) throw new Error('请选择支持的目标语言');
        next.useSystemAudio = Boolean(next.useSystemAudio); next.useMicAudio = Boolean(next.useMicAudio);
        if (next.mode === 'outgoing') {
            if (next.useSystemAudio || !next.useMicAudio) throw new Error('发言翻译只能使用真实麦克风，不能采集系统音频。');
            if (TEXT_ONLY_LANGS.includes(next.targetLanguage)) throw new Error('发言翻译请选择支持译音播报的目标语言');
            next.audioEnabled = true;
        }
        if (!next.useSystemAudio && !next.useMicAudio) throw new Error('请选择至少一个输入声源');
        if (next.useSystemAudio && !mediaCapabilities.systemAudio) throw new Error('当前系统不支持桌面音频采集，请使用麦克风');
        next.audioEnabled = Boolean(next.audioEnabled) && !TEXT_ONLY_LANGS.includes(next.targetLanguage);
        next.meetingName = String(next.meetingName || '悬浮同传 ' + new Date().toLocaleString('zh-CN')).trim().slice(0, 200);
        if (!Array.isArray(next.hotwords)) next.hotwords = [];
        next.hotwords = next.hotwords.filter(word => typeof word?.source === 'string' && typeof word?.target === 'string').slice(0, 1000);
        return next;
    }
    async function start(options = {}) {
        const mode = options.mode ?? 'listening';
        if (activePhases.has(phase)) {
            if (mode !== config.mode) throw new Error('请先停止并保存当前同传，再切换发言翻译或收听同传。');
            return;
        }
        await releasing;
        await refreshDevices();
        let nextConfig;
        if (mode === 'outgoing') {
            const pair = resolveDDTransVirtualPair(deviceReport);
            if (!pair.available) throw new Error(pair.message);
            const source = resolveOutgoingMicrophone(deviceReport, options.deviceId || 'default');
            if (!source.available) throw new Error(source.message);
            if (!mixBus) throw new Error('音频发送服务尚未就绪，无法启动发言翻译。');
            nextConfig = normalizeOptions({
                ...options, mode, targetLanguage: options.targetLanguage ?? audioRouting.outgoingTargetLanguage,
                useSystemAudio: false, useMicAudio: true, deviceId: source.microphone.deviceId, audioEnabled: true,
                meetingName: options.meetingName || '发言翻译 ' + new Date().toLocaleString('zh-CN'),
                hotwords: options.hotwords || loadHotwords(),
            });
            await applyAudioRouting({
                outgoingOriginalGain: 0, translatedGain: audioRouting.translatedGain || DEFAULT_AUDIO_ROUTING.translatedGain,
                ttsEnabled: true, ttsVolume: audioRouting.ttsVolume || DEFAULT_AUDIO_ROUTING.ttsVolume,
                virtualOutputEnabled: true,
                virtualRenderDeviceId: pair.render.deviceId, virtualRenderDeviceLabel: pair.render.label,
                virtualCaptureDeviceId: pair.capture.deviceId, virtualCaptureDeviceLabel: pair.capture.label,
            }, nextConfig);
        } else {
            nextConfig = normalizeOptions({ ...options, mode });
            if (config.mode === 'outgoing' && audioRouting.virtualOutputEnabled) await applyAudioRouting({ virtualOutputEnabled: false }, nextConfig);
        }
        checkInputLoop(nextConfig, audioRouting);
        config = nextConfig;
        clearTimeout(noteTimer); noteDirty = false;
        stopping = null; sessionId = null; segments.clear(); note = ''; accumulatedMs = 0;
        ttsEnabled = config.audioEnabled && audioRouting.ttsEnabled;
        setPhase('starting'); publish({ type: 'snapshot', snapshot: snapshot() });
        inform('正在准备音频并连接 Qwen 3.8…');
        try {
            capture = await makeCapture(); capture.pause();
            const ws = createSocket(); socket = ws;
            const ready = waitFor(message => message.type === 'ready', 25000);
            ws.onopen = () => {
                try { send({ type: 'start', meeting_name: config.meetingName, target_language: config.targetLanguage, audio_enabled: config.audioEnabled, transport: 'websocket', corpus: { phrases: Object.fromEntries(config.hotwords.map(word => [word.source, word.target])) } }); }
                catch (error) { notify({ type: 'error', message: error.message, closed: true }); }
            };
            ws.onmessage = event => {
                if (socket !== ws) return;
                try { handleMessage(JSON.parse(event.data)); }
                catch (error) { inform(error.message, 'error'); }
            };
            ws.onerror = () => notify({ type: 'error', message: '无法连接同传后台', closed: true });
            ws.onclose = () => {
                if (socket !== ws) return;
                socket = null;
                notify({ type: 'error', message: '本地连接已关闭', closed: true });
                if (activePhases.has(phase)) {
                    void releaseMedia().catch(error => inform(error.message, 'error')); setPhase('failed');
                    inform('连接已中断。后台会保存已收到的结果，请在历史记录中查看。', 'error');
                }
            };
            await ready; setPhase('running'); capture?.resume();
            inform(config.mode === 'outgoing' ? '发言翻译中。请在会议或游戏中选择 DDTrans Virtual Microphone。' : config.useSystemAudio && !mediaCapabilities.isolatedTts && config.audioEnabled ? '当前系统无法隔离译音，译音保存后可在记录中回放。' : '同传中，原文、译文和录音持续保存。', config.useSystemAudio && !mediaCapabilities.isolatedTts && config.audioEnabled ? 'warning' : 'info');
        } catch (error) {
            await releaseMedia();
            const old = socket; socket = null; old?.close(); setPhase('failed'); inform(error.message, 'error');
            throw error;
        }
    }
    async function pause() {
        if (phase !== 'running') return;
        setPhase('pausing'); await releaseMedia();
        const paused = waitFor(message => message.type === 'state' && message.state === 'paused', 10000);
        send({ type: 'pause' }); await paused;
        inform('已关闭收音，尾段仍会补齐并保存。');
    }
    async function resume() {
        if (phase !== 'paused') return;
        try {
            if (config.mode === 'outgoing') await refreshDevices();
            capture = await makeCapture(); capture.pause();
            const resumed = waitFor(message => message.type === 'state' && message.state === 'running', 10000);
            send({ type: 'resume' }); await resumed; capture.resume(); inform('已恢复同传。');
        } catch (error) { await releaseMedia(); throw error; }
    }
    async function stop() {
        if (stopping) return stopping;
        if (!activePhases.has(phase)) { await releaseMedia(); return; }
        stopping = (async () => {
            clearTimeout(noteTimer);
            setPhase('stopping'); inform('正在接收尾段并保存，请稍候…');
            await releaseCapture(); await releasePlayer();
            try { await persistNote(); }
            catch (error) { inform('笔记确认失败：' + error.message + '。正在保存同传内容。', 'warning'); }
            try {
                const stopped = waitFor(message => message.type === 'stopped');
                send({ type: 'stop' }); await stopped;
            } catch (error) { notify({ type: 'error', message: error.message, closed: true }); setPhase('failed'); inform(error.message, 'error'); throw error; }
            finally {
                const old = socket; socket = null; old?.close(); await releaseMedia();
                if (config.mode === 'outgoing' && audioRouting.virtualOutputEnabled) await applyAudioRouting({ virtualOutputEnabled: false });
            }
        })();
        return stopping;
    }
    async function switchSource(options) {
        const previous = config;
        const next = normalizeOptions({ ...config, ...options });
        if (next.mode !== config.mode && activePhases.has(phase)) throw new Error('请先停止当前同传，再切换模式。');
        if (next.mode === 'outgoing') {
            const source = resolveOutgoingMicrophone(deviceReport, next.deviceId);
            if (!source.available) throw new Error(source.message);
            next.deviceId = source.microphone.deviceId;
        }
        checkInputLoop(next, audioRouting);
        if (!['running', 'paused'].includes(phase)) { config = next; broadcast(); return; }
        const wasRunning = phase === 'running';
        if (wasRunning) await pause();
        config = next;
        try { if (wasRunning) await resume(); inform('输入声源已切换。'); }
        catch (error) { config = previous; broadcast(); inform('切换失败，已关闭收音：' + error.message, 'error'); throw error; }
        broadcast();
    }
    async function persistNote() {
        if (!noteDirty || !sessionId || !['running', 'paused', 'stopping'].includes(phase)) return;
        const saved = waitFor(message => message.type === 'note_saved', 10000);
        send({ type: 'note', content: note }); await saved; noteDirty = false;
    }
    async function command(name, payload = {}) {
        if (['stop', 'resume'].includes(name)) {
            if (payload.mode !== undefined && payload.mode !== config.mode) throw new Error('当前同传模式已改变，请刷新设置后重试。');
            if (payload.sessionId !== undefined && payload.sessionId !== sessionId) throw new Error('当前同传会话已改变，请刷新设置后重试。');
        }
        if (name === 'start') await start(payload);
        else if (name === 'pause') await pause();
        else if (name === 'resume') await resume();
        else if (name === 'stop') await stop();
        else if (name === 'switch-source') await switchSource(payload);
        else if (name === 'set-volume') await applyAudioRouting({ ttsVolume: payload.volume });
        else if (name === 'set-tts') {
            if (payload.enabled && !config.audioEnabled && activePhases.has(phase)) throw new Error('本次会话仅输出文字，请结束后开启译音再开始');
            await applyAudioRouting({ ttsEnabled: payload.enabled });
        } else if (name === 'set-audio-routing') await applyAudioRouting(payload);
        else if (name === 'enumerate-devices') return refreshDevices();
        else if (name === 'request-audio-permission') {
            if (!requestAudioPermission) throw new Error('当前环境不支持申请麦克风权限');
            const result = await requestAudioPermission(); await refreshDevices(); return result;
        } else if (name === 'audio-routing-test') {
            if (!mixBus) throw new Error('混音服务尚未就绪');
            await refreshDevices();
            return mixBus.testTone(payload);
        } else if (name === 'set-target') {
            if (!languages.has(payload.targetLanguage)) throw new Error('请选择支持的目标语言');
            if (config.mode === 'outgoing' && TEXT_ONLY_LANGS.includes(payload.targetLanguage)) throw new Error('发言翻译请选择支持译音播报的目标语言');
            if (payload.targetLanguage === config.targetLanguage) return snapshot();
            const previousPhase = phase;
            const next = { ...config, targetLanguage: payload.targetLanguage, audioEnabled: !TEXT_ONLY_LANGS.includes(payload.targetLanguage) };
            if (activePhases.has(phase)) {
                await stop(); await start(next);
                if (!ttsEnabled) await releasePlayer();
                broadcast();
                if (previousPhase === 'paused') await pause();
                inform('目标语言已切换，上一段会话已保存，已建立新会话。', 'success');
            } else { config = normalizeOptions(next); ttsEnabled = config.audioEnabled && audioRouting.ttsEnabled; broadcast(); }
        } else if (name === 'save-note') {
            clearTimeout(noteTimer);
            if (payload.content !== undefined) {
                if (typeof payload.content !== 'string' || payload.content.length > 20000) throw new Error('笔记最多20000字');
                noteDirty ||= note !== payload.content;
                note = payload.content;
            }
            if (payload.defer) noteTimer = setTimeout(() => void execute('save-note').catch(error => inform(error.message, 'error')), 500);
            else await persistNote();
        } else if (name === 'prepare-overlay') {
            if (!activePhases.has(phase)) await start({ ...payload, meetingName: payload.meetingName || '悬浮同传 ' + new Date().toLocaleString('zh-CN'), useSystemAudio: true, useMicAudio: false, audioEnabled: true, hotwords: loadHotwords() });
        } else if (name !== 'snapshot') throw new Error('不支持的媒体操作');
        return snapshot(['snapshot', 'start', 'stop', 'prepare-overlay', 'set-target'].includes(name));
    }
    function execute(name, payload = {}) {
        if (name === 'snapshot') return Promise.resolve(snapshot());
        const operation = queue.then(() => command(name, payload));
        queue = operation.catch(() => {});
        return operation.catch(error => { inform(error.message, 'error'); throw error; });
    }
    return { execute };
}
