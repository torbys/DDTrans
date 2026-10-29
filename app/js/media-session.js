import { LANG_DATA, TEXT_ONLY_LANGS } from './config.js';

const activePhases = new Set(['starting', 'running', 'pausing', 'paused', 'stopping']);
const languages = new Set(LANG_DATA.map(language => language.code));

export function createMediaSession({ createCapture, createPlayer, createSocket, publish = () => {}, capabilities = {}, now = Date.now }) {
    let phase = 'idle', sessionId = null, capture = null, player = null, socket = null;
    let queue = Promise.resolve(), stopping = null, clock = null, accumulatedMs = 0, activeStart = 0;
    let ttsEnabled = true, ttsVolume = 0.8, note = '', noteTimer = null, noteDirty = false, lastLevel = 0;
    let playbackGeneration = 0, playbackQueue = Promise.resolve(), releasing = Promise.resolve(), pendingAudioBytes = 0;
    let feedback = { message: '准备就绪', kind: 'info' };
    let config = { meetingName: '', targetLanguage: 'zh', useSystemAudio: true, useMicAudio: false, deviceId: 'default', audioEnabled: true, hotwords: [] };
    const mediaCapabilities = { systemAudio: false, ...capabilities };
    const segments = new Map(), waiters = new Set();
    const elapsed = () => accumulatedMs + (phase === 'running' ? now() - activeStart : 0);
    const sortedSegments = () => [...segments.values()].sort((left, right) => left.sequence_order - right.sequence_order);
    const snapshot = (includeSegments = true) => ({ phase, sessionId, config: { ...config }, ttsEnabled, ttsVolume, elapsedMs: elapsed(), note, feedback: { ...feedback }, capabilities: { ...mediaCapabilities }, ...(includeSegments ? { segments: sortedSegments() } : {}) });
    const broadcast = () => publish({ type: 'snapshot', snapshot: snapshot(false) });
    const inform = (message, kind = 'info') => { feedback = { message, kind }; publish({ type: 'feedback', ...feedback }); };

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
        promise.catch(() => {});
        return promise;
    }

    function notify(message) {
        for (const entry of [...waiters]) {
            if (entry.check(message)) { clearTimeout(entry.timer); waiters.delete(entry); entry.resolve(message); }
            else if (message.closed || message.type === 'error' && phase === 'starting') { clearTimeout(entry.timer); waiters.delete(entry); entry.reject(new Error(message.message)); }
        }
    }

    function send(message) {
        if (socket?.readyState !== 1) throw new Error('本地连接已断开');
        socket.send(JSON.stringify(message));
    }

    async function releaseCapture() {
        const old = capture;
        capture = null;
        await old?.stop();
        publish({ type: 'level', level: 0 });
    }

    async function releasePlayer() {
        playbackGeneration++;
        const old = player;
        player = null;
        await old?.stop();
    }

    function releaseMedia() {
        releasing = releasing.then(async () => { await releaseCapture(); await releasePlayer(); });
        return releasing;
    }

    const canPlay = () => config.audioEnabled && ttsEnabled && !TEXT_ONLY_LANGS.includes(config.targetLanguage);

    async function ensurePlayer() {
        if (!canPlay() || player) return;
        player = createPlayer({ sampleRate: 24000, volume: ttsVolume, onError(error) {
            inform('译音播放已停止：' + error.message + '。译音仍会保存到记录。', 'error');
            ttsEnabled = false;
            void releasePlayer();
            broadcast();
        } });
    }

    async function makeCapture() {
        return createCapture({
            useSystemAudio: config.useSystemAudio,
            useMicAudio: config.useMicAudio,
            deviceId: config.deviceId,
            initiallyPaused: true,
            onFrame({ pcm }) {
                if (phase !== 'running' || socket?.readyState !== 1) return;
                if (socket.bufferedAmount > 64000) {
                    capture?.pause();
                    inform('音频发送积压超过2秒，正在结束并保存。', 'error');
                    void execute('stop').catch(error => inform(error.message, 'error'));
                    return;
                }
                socket.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
            },
            onLevel(level) {
                if (now() - lastLevel < 100) return;
                lastLevel = now();
                publish({ type: 'level', level: phase === 'running' ? level : 0 });
            },
            onError(error) {
                const message = '收音已停止：' + error.message;
                inform(message, 'error');
                if (phase === 'starting') { notify({ type: 'error', message }); socket?.close(); }
                else if (activePhases.has(phase)) void execute('stop').then(() => inform(message + '。已收到的内容已保存。', 'error')).catch(reason => inform(reason.message, 'error'));
            },
        });
    }

    function handleMessage(message) {
        if (message.type === 'ready') sessionId = message.session_id;
        if (message.type === 'state') setPhase(message.state);
        if (message.type === 'segment') {
            const segment = { ...segments.get(message.segment.segment_key), ...message.segment };
            segments.set(segment.segment_key, segment);
            publish({ type: 'segment', segment });
        }
        if (message.type === 'audio' && phase === 'running' && canPlay()) {
            const generation = playbackGeneration;
            const bytes = Uint8Array.from(atob(message.audio), char => char.charCodeAt(0));
            if (pendingAudioBytes + bytes.byteLength > 480000) {
                ttsEnabled = false;
                void releasePlayer();
                inform('译音待播超过 10 秒，已停止播报。字幕和译音记录仍会保存，可手动重新开启。', 'warning');
                broadcast();
                return;
            }
            pendingAudioBytes += bytes.byteLength;
            playbackQueue = playbackQueue.then(async () => {
                if (generation !== playbackGeneration || phase !== 'running' || !canPlay()) return;
                await ensurePlayer();
                if (generation === playbackGeneration && phase === 'running' && canPlay()) player?.append(bytes);
            }).catch(error => { inform('译音播放失败：' + error.message, 'error'); void releasePlayer(); }).finally(() => { pendingAudioBytes -= bytes.byteLength; });
        }
        if (message.type === 'stopped') {
            void releaseMedia().catch(error => inform(error.message, 'error'));
            setPhase('stopped');
            inform(message.status === 'completed' ? '本次同传已完整保存。' : '已保存收到的内容，部分结果未完整返回；请查看记录。', message.status === 'completed' ? 'success' : 'warning');
        }
        if (message.type === 'error' || message.type === 'warning') inform(message.message, message.type);
        notify(message);
    }

    function normalizeOptions(options) {
        const next = { ...config, ...options };
        if (!languages.has(next.targetLanguage)) throw new Error('请选择支持的目标语言');
        next.useSystemAudio = Boolean(next.useSystemAudio);
        next.useMicAudio = Boolean(next.useMicAudio);
        if (!next.useSystemAudio && !next.useMicAudio) throw new Error('请选择至少一个输入声源');
        if (next.useSystemAudio && !mediaCapabilities.systemAudio) throw new Error('当前系统不支持桌面音频采集，请使用麦克风');
        next.audioEnabled = Boolean(next.audioEnabled) && !TEXT_ONLY_LANGS.includes(next.targetLanguage);
        next.meetingName = String(next.meetingName || '悬浮同传 ' + new Date().toLocaleString('zh-CN')).trim().slice(0, 200);
        next.hotwords = Array.isArray(next.hotwords) ? next.hotwords.filter(word => typeof word?.source === 'string' && typeof word?.target === 'string').slice(0, 1000) : [];
        return next;
    }

    async function start(options = {}) {
        if (activePhases.has(phase)) return;
        await releasing;
        config = normalizeOptions(options);
        clearTimeout(noteTimer);
        noteDirty = false;
        stopping = null;
        sessionId = null;
        segments.clear();
        note = '';
        accumulatedMs = 0;
        ttsEnabled = config.audioEnabled;
        setPhase('starting');
        publish({ type: 'snapshot', snapshot: snapshot() });
        inform('正在准备音频并连接 Qwen 3.8…');
        try {
            capture = await makeCapture();
            capture.pause();
            const ws = createSocket();
            socket = ws;
            const ready = waitFor(message => message.type === 'ready', 25000);
            ws.onopen = () => {
                try { send({ type: 'start', meeting_name: config.meetingName, target_language: config.targetLanguage, audio_enabled: config.audioEnabled, transport: 'websocket', corpus: { phrases: Object.fromEntries(config.hotwords.map(word => [word.source, word.target])) } }); }
                catch (error) { notify({ type: 'error', message: error.message, closed: true }); }
            };
            ws.onmessage = event => { if (socket === ws) { try { handleMessage(JSON.parse(event.data)); } catch (error) { inform(error.message, 'error'); } } };
            ws.onerror = () => notify({ type: 'error', message: '无法连接同传后台', closed: true });
            ws.onclose = () => {
                if (socket !== ws) return;
                socket = null;
                notify({ type: 'error', message: '本地连接已关闭', closed: true });
                if (activePhases.has(phase)) {
                    void releaseMedia().catch(error => inform(error.message, 'error'));
                    setPhase('failed');
                    inform('连接已中断。后台会保存已收到的结果，请在历史记录中查看。', 'error');
                }
            };
            await ready;
            setPhase('running');
            capture?.resume();
            inform('同传中，原文、译文和录音持续保存。');
        } catch (error) {
            await releaseMedia();
            const old = socket;
            socket = null;
            old?.close();
            setPhase('failed');
            inform(error.message, 'error');
            throw error;
        }
    }

    async function pause() {
        if (phase !== 'running') return;
        setPhase('pausing');
        await releaseMedia();
        const paused = waitFor(message => message.type === 'state' && message.state === 'paused', 10000);
        send({ type: 'pause' });
        await paused;
        inform('已关闭收音，尾段仍会补齐并保存。');
    }

    async function resume() {
        if (phase !== 'paused') return;
        try {
            capture = await makeCapture();
            capture.pause();
            const resumed = waitFor(message => message.type === 'state' && message.state === 'running', 10000);
            send({ type: 'resume' });
            await resumed;
            capture.resume();
            inform('已恢复同传。');
        } catch (error) {
            await releaseMedia();
            throw error;
        }
    }

    async function persistNote() {
        if (!noteDirty || !sessionId || !['running', 'paused', 'stopping'].includes(phase)) return;
        const saved = waitFor(message => message.type === 'note_saved', 10000);
        send({ type: 'note', content: note });
        await saved;
        noteDirty = false;
    }

    async function stop() {
        if (stopping) return stopping;
        if (!activePhases.has(phase)) { await releaseMedia(); return; }
        stopping = (async () => {
            clearTimeout(noteTimer);
            setPhase('stopping');
            inform('正在接收尾段并保存，请稍候…');
            await releaseCapture();
            await releasePlayer();
            try { await persistNote(); }
            catch (error) { inform('笔记确认失败：' + error.message + '。正在保存同传内容。', 'warning'); }
            try {
                const stopped = waitFor(message => message.type === 'stopped');
                send({ type: 'stop' });
                await stopped;
            } catch (error) {
                notify({ type: 'error', message: error.message, closed: true });
                setPhase('failed');
                inform(error.message, 'error');
                throw error;
            } finally {
                const old = socket;
                socket = null;
                old?.close();
                await releaseMedia();
            }
        })();
        return stopping;
    }

    async function switchSource(options) {
        const previous = config;
        const next = normalizeOptions({ ...config, ...options });
        if (!['running', 'paused'].includes(phase)) { config = next; broadcast(); return; }
        const wasRunning = phase === 'running';
        if (wasRunning) await pause();
        config = next;
        try { if (wasRunning) await resume(); inform('输入声源已切换。'); }
        catch (error) { config = previous; broadcast(); inform('切换失败，已关闭收音：' + error.message, 'error'); throw error; }
        broadcast();
    }

    async function setTarget(targetLanguage) {
        if (!languages.has(targetLanguage)) throw new Error('请选择支持的目标语言');
        if (targetLanguage === config.targetLanguage) return;
        const previousPhase = phase;
        const next = { ...config, targetLanguage, audioEnabled: config.audioEnabled && !TEXT_ONLY_LANGS.includes(targetLanguage) };
        if (activePhases.has(phase)) {
            await stop();
            await start(next);
            if (previousPhase === 'paused') await pause();
            inform('目标语言已切换，上一段会话已保存，已建立新会话。', 'success');
        } else {
            config = normalizeOptions(next);
            ttsEnabled = config.audioEnabled;
            broadcast();
        }
    }

    async function command(name, payload = {}) {
        if (name === 'start') await start(payload);
        else if (name === 'pause') await pause();
        else if (name === 'resume') await resume();
        else if (name === 'stop') await stop();
        else if (name === 'switch-source') await switchSource(payload);
        else if (name === 'set-volume') {
            const volume = Number(payload.volume);
            if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('音量必须在 0 到 1 之间');
            ttsVolume = volume;
            player?.setVolume(ttsVolume);
            broadcast();
        } else if (name === 'set-tts') {
            if (payload.enabled && !config.audioEnabled && activePhases.has(phase)) throw new Error('本次会话仅输出文字，请结束后开启译音再开始');
            ttsEnabled = Boolean(payload.enabled) && !TEXT_ONLY_LANGS.includes(config.targetLanguage);
            if (!ttsEnabled) await releasePlayer();
            broadcast();
        } else if (name === 'set-target') await setTarget(payload.targetLanguage);
        else if (name === 'save-note') {
            clearTimeout(noteTimer);
            if (payload.content !== undefined) {
                if (typeof payload.content !== 'string' || payload.content.length > 20000) throw new Error('笔记最多20000字');
                noteDirty ||= note !== payload.content;
                note = payload.content;
            }
            if (payload.defer) noteTimer = setTimeout(() => void execute('save-note').catch(error => inform(error.message, 'error')), 500);
            else await persistNote();
        } else if (name !== 'snapshot') throw new Error('不支持的媒体操作');
        return snapshot(['snapshot', 'start', 'stop', 'set-target'].includes(name));
    }

    function execute(name, payload = {}) {
        if (name === 'snapshot') return Promise.resolve(snapshot());
        const operation = queue.then(() => command(name, payload));
        queue = operation.catch(() => {});
        return operation.catch(error => { inform(error.message, 'error'); throw error; });
    }

    return { execute };
}
