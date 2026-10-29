import { LANG_DATA, TEXT_ONLY_LANGS } from './config.js';

const api = window.electronAPI ?? {};
const byId = id => document.getElementById(id);
const els = {
    shell: byId('overlayShell'),
    meetingName: byId('meetingName'),
    sessionState: byId('sessionState'),
    captureBtn: byId('captureBtn'),
    captureLabel: byId('captureLabel'),
    captureHint: byId('captureHint'),
    targetLanguage: byId('targetLanguage'),
    ttsToggle: byId('ttsToggle'),
    ttsVolume: byId('ttsVolume'),
    ttsVolumeValue: byId('ttsVolumeValue'),
    ttsNote: byId('ttsNote'),
    opacityRange: byId('opacityRange'),
    opacityValue: byId('opacityValue'),
    hideSubtitlesBtn: byId('hideSubtitlesBtn'),
    hideSubtitlesMark: byId('hideSubtitlesMark'),
    minimizeBtn: byId('minimizeBtn'),
    returnBtn: byId('returnBtn'),
    exitBtn: byId('exitBtn'),
    subtitleArea: byId('subtitleArea'),
    subtitleEmpty: byId('subtitleEmpty'),
    segmentList: byId('segmentList'),
    elapsedTime: byId('elapsedTime'),
    levelBar: byId('levelBar'),
    overlayBall: byId('overlayBall'),
    ballState: byId('ballState'),
    copyMenu: byId('copyMenu'),
    copyMenuBtn: byId('copyMenuBtn'),
    feedbackToast: byId('feedbackToast'),
};

const state = {
    snapshot: {
        phase: 'idle',
        sessionId: null,
        config: { meetingName: '悬浮同传', targetLanguage: 'en', useSystemAudio: true, useMicAudio: false, audioEnabled: true },
        ttsEnabled: false,
        ttsVolume: 0.7,
        elapsedMs: 0,
        segments: [],
        feedback: null,
        capabilities: { systemAudio: true, isolatedTts: true },
    },
    preferences: { mode: 'standard', opacity: 0.86, subtitlesVisible: true },
    segmentNodes: new Map(),
    activeSegmentKey: null,
    copySegmentKey: null,
    pendingTargetLanguage: null,
    toastTimer: null,
    pending: false,
};

const runningPhases = new Set(['running', 'pausing', 'paused']);
const busyPhases = new Set(['starting', 'pausing', 'stopping']);
const phaseLabels = {
    idle: '未开始',
    starting: '正在准备',
    running: '正在采集',
    pausing: '正在暂停',
    paused: '已暂停',
    stopping: '正在结束',
    stopped: '已结束',
    failed: '需要重试',
};

function formatTime(milliseconds = 0) {
    const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getSegmentKey(segment) {
    return String(segment.segment_key ?? segment.sequence_order ?? `${segment.speaker_id}-${segment.source_text}`);
}

function normalizeSegments(segments) {
    const seen = new Map();
    for (const segment of segments ?? []) {
        if (!segment) continue;
        seen.set(getSegmentKey(segment), segment);
    }
    return [...seen.values()]
        .sort((a, b) => Number(a.sequence_order ?? 0) - Number(b.sequence_order ?? 0))
        .slice(-4);
}

function mergeSnapshot(partial) {
    if (!partial || typeof partial !== 'object') return;
    const previous = state.snapshot;
    const sessionChanged = partial.sessionId !== undefined && partial.sessionId !== previous.sessionId;
    const clearSegments = sessionChanged || partial.phase === 'starting';
    state.snapshot = {
        ...previous,
        ...partial,
        config: { ...previous.config, ...partial.config },
        capabilities: { ...previous.capabilities, ...partial.capabilities },
        segments: partial.segments !== undefined ? normalizeSegments(partial.segments) : (clearSegments ? [] : previous.segments),
        feedback: partial.feedback ?? previous.feedback,
    };
    if (clearSegments) state.activeSegmentKey = null;
    render();
}

function updateSegment(segment) {
    const key = getSegmentKey(segment);
    const segments = [...state.snapshot.segments];
    const index = segments.findIndex(item => getSegmentKey(item) === key);
    if (index === -1) segments.push(segment);
    else segments[index] = { ...segments[index], ...segment };
    state.snapshot = { ...state.snapshot, segments: normalizeSegments(segments) };
    render();
}

function populateLanguages() {
    const selected = state.snapshot.config.targetLanguage ?? 'en';
    els.targetLanguage.replaceChildren(...LANG_DATA.map(language => {
        const option = document.createElement('option');
        option.value = language.code;
        option.textContent = `${language.name} (${language.native})`;
        option.selected = language.code === selected;
        return option;
    }));
}

function hasSpeaker(segment) {
    return segment.speaker_id !== undefined && segment.speaker_id !== null && segment.speaker_id !== '';
}

function createSegmentNode(key) {
    const node = document.createElement('article');
    const meta = document.createElement('div');
    const speaker = document.createElement('span');
    const status = document.createElement('span');
    const source = document.createElement('p');
    const target = document.createElement('p');

    node.className = 'subtitle-segment';
    node.dataset.segmentKey = key;
    node.tabIndex = 0;
    node.setAttribute('aria-label', '字幕组，长按或右键复制');
    meta.className = 'segment-meta';
    speaker.className = 'speaker-tag';
    status.className = 'segment-status';
    source.className = 'segment-source';
    target.className = 'segment-target';
    meta.append(speaker, status);
    node.append(meta, source, target);
    node.parts = { meta, speaker, status, source, target };
    return node;
}

function updateSegmentNode(node, segment) {
    const { meta, speaker, status, source, target } = node.parts;
    const speakerPresent = hasSpeaker(segment);
    const statusPresent = Boolean(segment.status && segment.status !== 'final');
    const sourceText = segment.source_text ?? '';
    const targetText = segment.target_text ?? '';

    speaker.hidden = !speakerPresent;
    speaker.textContent = speakerPresent ? `说话人 ${segment.speaker_id}` : '';
    status.hidden = !statusPresent;
    status.textContent = statusPresent ? (segment.status === 'interrupted' ? '未完整结束' : '生成中') : '';
    meta.hidden = !speakerPresent && !statusPresent;
    source.hidden = !sourceText;
    source.textContent = sourceText;
    target.hidden = !targetText;
    target.textContent = targetText;
    node.classList.toggle('is-selected', state.activeSegmentKey === node.dataset.segmentKey);
}

function setActiveSegment(key) {
    if (key === state.activeSegmentKey) return;
    state.segmentNodes.get(state.activeSegmentKey)?.classList.remove('is-selected');
    state.activeSegmentKey = key;
    state.segmentNodes.get(key)?.classList.add('is-selected');
}

function renderSegments() {
    const segments = state.snapshot.segments;
    const nextKeys = new Set();
    let cursor = els.segmentList.firstElementChild;
    els.subtitleEmpty.classList.toggle('is-hidden', segments.length > 0);

    for (const segment of segments) {
        const key = getSegmentKey(segment);
        nextKeys.add(key);
        let node = state.segmentNodes.get(key);
        if (!node) {
            node = createSegmentNode(key);
            state.segmentNodes.set(key, node);
        }
        updateSegmentNode(node, segment);
        if (node !== cursor) els.segmentList.insertBefore(node, cursor);
        cursor = node.nextElementSibling;
    }

    for (const [key, node] of state.segmentNodes) {
        if (nextKeys.has(key)) continue;
        node.remove();
        state.segmentNodes.delete(key);
    }
    if (state.activeSegmentKey && !nextKeys.has(state.activeSegmentKey)) state.activeSegmentKey = null;
    layoutVisibleSegments();
}

function layoutVisibleSegments() {
    const nodes = state.snapshot.segments
        .map(segment => state.segmentNodes.get(getSegmentKey(segment)))
        .filter(Boolean);
    const availableHeight = els.segmentList.clientHeight;
    const gap = Number.parseFloat(getComputedStyle(els.segmentList).rowGap) || 0;
    let usedHeight = 0;
    let hideOlder = false;

    for (const node of nodes) node.hidden = false;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        const requiredHeight = node.offsetHeight + (usedHeight ? gap : 0);
        if (hideOlder || (usedHeight && usedHeight + requiredHeight > availableHeight)) {
            node.hidden = true;
            hideOlder = true;
            continue;
        }
        usedHeight += requiredHeight;
    }
}

function ttsBlockReason(snapshot) {
    const { config, capabilities } = snapshot;
    if (config.audioEnabled === false) return '本次会话仅输出文字，请结束后开启译音再开始';
    if (TEXT_ONLY_LANGS.includes(config.targetLanguage)) return '此语言仅支持文本输出';
    return '';
}

function render() {
    const { snapshot, preferences } = state;
    const phase = snapshot.phase ?? 'idle';
    const isActive = runningPhases.has(phase);
    const isBusy = busyPhases.has(phase) || state.pending;
    const canResumeCurrentSource = phase === 'running' || phase === 'paused';
    const canStartSystemSource = snapshot.capabilities.systemAudio !== false;
    const ttsReason = ttsBlockReason(snapshot);

    document.documentElement.style.setProperty('--panel-opacity', String(preferences.opacity));
    els.shell.classList.toggle('ball-mode', preferences.mode === 'ball');
    els.shell.classList.toggle('subtitles-hidden', !preferences.subtitlesVisible);
    els.shell.classList.toggle('is-active', isActive);
    els.shell.classList.toggle('is-busy', busyPhases.has(phase));
    els.meetingName.textContent = snapshot.config.meetingName || '悬浮同传';
    els.sessionState.textContent = phaseLabels[phase] ?? phase;
    els.elapsedTime.textContent = formatTime(snapshot.elapsedMs);
    els.ballState.textContent = phase === 'running' ? '采集' : phase === 'paused' ? '暂停' : '待命';
    els.hideSubtitlesBtn.title = preferences.subtitlesVisible ? '隐藏字幕文字' : '显示字幕文字';
    els.hideSubtitlesBtn.setAttribute('aria-label', els.hideSubtitlesBtn.title);
    els.hideSubtitlesMark.textContent = preferences.subtitlesVisible ? '字幕' : '显示';
    els.returnBtn.title = '返回主界面，同传继续运行';
    els.returnBtn.setAttribute('aria-label', els.returnBtn.title);

    els.captureBtn.disabled = isBusy || (!canResumeCurrentSource && !canStartSystemSource);
    if (!canStartSystemSource && !canResumeCurrentSource) {
        els.captureLabel.textContent = '电脑声音不可用';
        els.captureHint.textContent = '请检查系统音频权限或设备';
    } else if (phase === 'running') {
        els.captureLabel.textContent = '暂停收音';
        els.captureHint.textContent = '正在采集电脑声音，译音不会再次进入翻译';
    } else if (phase === 'paused') {
        els.captureLabel.textContent = '继续收音';
        els.captureHint.textContent = '继续当前会话的实时字幕';
    } else if (busyPhases.has(phase)) {
        els.captureLabel.textContent = phaseLabels[phase];
        els.captureHint.textContent = '请稍候';
    } else if (phase === 'failed') {
        els.captureLabel.textContent = '重新开始';
        els.captureHint.textContent = '上次连接没有完成，请重试';
    } else {
        els.captureLabel.textContent = '开始收音';
        els.captureHint.textContent = '点击开始采集电脑声音';
    }

    els.targetLanguage.value = state.pendingTargetLanguage ?? snapshot.config.targetLanguage ?? 'en';
    els.targetLanguage.disabled = isBusy || Boolean(state.pendingTargetLanguage);
    els.ttsToggle.disabled = Boolean(ttsReason) || isBusy;
    els.ttsToggle.setAttribute('aria-checked', String(!ttsReason && Boolean(snapshot.ttsEnabled)));
    els.ttsVolume.disabled = Boolean(ttsReason) || isBusy || !snapshot.ttsEnabled;
    els.ttsNote.textContent = ttsReason;
    byId('ttsRow').title = ttsReason;
    els.ttsToggle.setAttribute('aria-description', ttsReason || '只改变译音播报，字幕和采集继续运行');
    els.ttsNote.hidden = !ttsReason;
    const ttsVolumePercent = Math.round((snapshot.ttsVolume ?? 0.8) * 100);
    const opacityPercent = Math.round(preferences.opacity * 100);
    els.ttsVolume.value = String(ttsVolumePercent);
    els.ttsVolumeValue.textContent = `${ttsVolumePercent}%`;
    els.ttsVolume.setAttribute('aria-valuetext', `${ttsVolumePercent}%，${ttsVolumePercent === 0 ? '静音' : ttsVolumePercent < 50 ? '小声' : ttsVolumePercent > 80 ? '大声' : '中等音量'}`);
    els.opacityRange.value = String(opacityPercent);
    els.opacityValue.textContent = `${opacityPercent}%`;
    els.opacityRange.setAttribute('aria-valuetext', `${opacityPercent}%，${opacityPercent < 75 ? '遮挡较少' : '更清晰'}`);
    renderSegments();
}

function showFeedback(message, kind = 'info') {
    if (!message) return;
    els.feedbackToast.textContent = message;
    els.feedbackToast.dataset.kind = kind;
    els.feedbackToast.classList.add('is-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => els.feedbackToast.classList.remove('is-visible'), 3000);
}

function readableError(error, fallback) {
    const message = String(error?.message || fallback || '操作未完成')
        .replace(/^Error invoking remote method '[^']+':\s*/i, '')
        .replace(/^Error:\s*/i, '')
        .trim();
    return message || fallback || '操作未完成';
}

async function invoke(name, ...args) {
    if (typeof api[name] !== 'function') return undefined;
    try {
        return await api[name](...args);
    } catch (error) {
        showFeedback(readableError(error), 'error');
        return undefined;
    }
}

async function runMediaCommand(command, payload = {}) {
    state.pending = true;
    render();
    try {
        const snapshot = await invoke('mediaCommand', command, payload);
        if (snapshot) mergeSnapshot(snapshot);
        return snapshot;
    } finally {
        state.pending = false;
        render();
    }
}

function subtitleTextFor(key) {
    const segment = state.snapshot.segments.find(item => getSegmentKey(item) === key);
    if (!segment) return '';
    const speaker = hasSpeaker(segment) ? `说话人 ${segment.speaker_id}` : '';
    return [speaker, segment.source_text, segment.target_text].filter(Boolean).join('\n');
}

async function copyText(text) {
    if (!text) return;
    try {
        if (typeof api.copyText !== 'function') throw new Error('当前环境不支持复制');
        await api.copyText(text);
        showFeedback('已复制字幕', 'success');
    } catch (error) {
        showFeedback(readableError(error, '复制失败'), 'error');
    }
}

function copySegment(key) {
    return copyText(subtitleTextFor(key));
}

function closeCopyMenu() {
    els.copyMenu.classList.remove('is-open');
    state.copySegmentKey = null;
}

function openCopyMenu(event, key) {
    event.preventDefault();
    setActiveSegment(key);
    state.copySegmentKey = key;
    const menuWidth = 154;
    const menuHeight = 38;
    els.copyMenu.style.left = `${Math.min(event.clientX, window.innerWidth - menuWidth - 8)}px`;
    els.copyMenu.style.top = `${Math.min(event.clientY, window.innerHeight - menuHeight - 8)}px`;
    els.copyMenu.classList.add('is-open');
}

function bindSegmentCopy() {
    let timer = null;
    let startX = 0;
    let startY = 0;
    let pendingKey = null;
    let pendingText = '';

    els.segmentList.addEventListener('pointerdown', event => {
        const segment = event.target.closest('.subtitle-segment');
        if (!segment || event.button !== 0) return;
        pendingKey = segment.dataset.segmentKey;
        pendingText = subtitleTextFor(pendingKey);
        startX = event.clientX;
        startY = event.clientY;
        setActiveSegment(pendingKey);
        els.segmentList.setPointerCapture(event.pointerId);
        timer = window.setTimeout(() => {
            timer = null;
            void copyText(pendingText);
        }, 600);
    });

    els.segmentList.addEventListener('pointermove', event => {
        if (timer && Math.hypot(event.clientX - startX, event.clientY - startY) > 5) {
            clearTimeout(timer);
            timer = null;
        }
    });

    for (const eventName of ['pointerup', 'pointercancel']) {
        els.segmentList.addEventListener(eventName, event => {
            if (timer) clearTimeout(timer);
            timer = null;
            if (els.segmentList.hasPointerCapture(event.pointerId)) els.segmentList.releasePointerCapture(event.pointerId);
        });
    }

    els.segmentList.addEventListener('contextmenu', event => {
        const segment = event.target.closest('.subtitle-segment');
        if (segment) openCopyMenu(event, segment.dataset.segmentKey);
    });

    els.segmentList.addEventListener('focusin', event => {
        const segment = event.target.closest('.subtitle-segment');
        if (!segment) return;
        setActiveSegment(segment.dataset.segmentKey);
    });
}

function bindBallDrag() {
    let pointerId = null;
    let originX = 0;
    let originY = 0;
    let lastX = 0;
    let lastY = 0;
    let moved = false;

    els.overlayBall.addEventListener('pointerdown', event => {
        pointerId = event.pointerId;
        originX = event.screenX;
        originY = event.screenY;
        lastX = event.screenX;
        lastY = event.screenY;
        moved = false;
        els.overlayBall.setPointerCapture(pointerId);
    });

    els.overlayBall.addEventListener('pointermove', event => {
        if (event.pointerId !== pointerId) return;
        const deltaX = event.screenX - lastX;
        const deltaY = event.screenY - lastY;
        if (Math.hypot(event.screenX - originX, event.screenY - originY) > 5) moved = true;
        if (deltaX || deltaY) {
            void invoke('moveOverlay', { deltaX, deltaY });
            lastX = event.screenX;
            lastY = event.screenY;
        }
    });

    els.overlayBall.addEventListener('pointerup', event => {
        if (event.pointerId !== pointerId) return;
        pointerId = null;
        if (!moved) void setMode('standard');
    });

    els.overlayBall.addEventListener('pointercancel', () => { pointerId = null; });
}

async function setMode(mode) {
    const result = await invoke('setOverlayMode', mode);
    if (result === undefined && typeof api.setOverlayMode !== 'function') return;
    state.preferences.mode = mode;
    render();
}

function updatePreferences(preferences) {
    state.preferences = { ...state.preferences, ...preferences };
    render();
    void invoke('updateOverlayPreferences', preferences);
}

function bindControls() {
    els.captureBtn.addEventListener('click', () => {
        const phase = state.snapshot.phase;
        if (phase === 'running') return void runMediaCommand('pause');
        if (phase === 'paused') return void runMediaCommand('resume');
        if (['idle', 'stopped', 'failed'].includes(phase)) {
            const targetLanguage = state.snapshot.config.targetLanguage || els.targetLanguage.value;
            return void runMediaCommand('start', {
                useSystemAudio: true,
                useMicAudio: false,
                targetLanguage,
                audioEnabled: true,
                meetingName: `悬浮同传 ${new Date().toLocaleString('zh-CN')}`,
            });
        }
    });

    els.targetLanguage.addEventListener('change', async event => {
        const targetLanguage = event.target.value;
        if (targetLanguage === state.snapshot.config.targetLanguage) return;
        state.pendingTargetLanguage = targetLanguage;
        render();
        showFeedback('切换目标语言将保存并新建会话');
        await runMediaCommand('set-target', { targetLanguage });
        state.pendingTargetLanguage = null;
        render();
    });

    els.ttsToggle.addEventListener('click', () => {
        if (ttsBlockReason(state.snapshot)) return;
        void runMediaCommand('set-tts', { enabled: !state.snapshot.ttsEnabled });
    });

    els.ttsVolume.addEventListener('input', event => {
        state.snapshot.ttsVolume = Number(event.target.value) / 100;
        render();
    });
    els.ttsVolume.addEventListener('change', event => void runMediaCommand('set-volume', { volume: Number(event.target.value) / 100 }));
    els.opacityRange.addEventListener('input', event => updatePreferences({ opacity: Number(event.target.value) / 100 }));
    els.hideSubtitlesBtn.addEventListener('click', () => updatePreferences({ subtitlesVisible: !state.preferences.subtitlesVisible }));
    els.minimizeBtn.addEventListener('click', () => void setMode('ball'));
    els.returnBtn.addEventListener('click', () => void invoke('returnToMain'));
    els.exitBtn.addEventListener('click', () => void invoke('exitOverlay'));
    els.copyMenuBtn.addEventListener('click', () => {
        if (state.copySegmentKey) void copySegment(state.copySegmentKey);
        closeCopyMenu();
    });
    document.addEventListener('pointerdown', event => {
        if (!els.copyMenu.contains(event.target)) closeCopyMenu();
    });
    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && state.activeSegmentKey && !window.getSelection()?.toString()) {
            event.preventDefault();
            void copySegment(state.activeSegmentKey);
        }
        if (event.key === 'Escape') closeCopyMenu();
    });
}

function bindMediaEvents() {
    if (typeof api.onMediaEvent !== 'function') return;
    const unsubscribe = api.onMediaEvent(event => {
        if (!event) return;
        if (event.type === 'snapshot') mergeSnapshot(event.snapshot);
        if (event.type === 'segment') updateSegment(event.segment);
        if (event.type === 'feedback') showFeedback(event.message, event.kind);
        if (event.type === 'level') els.levelBar.style.width = `${Math.round(Math.max(0, Math.min(1, Number(event.level) || 0)) * 100)}%`;
        if (event.type === 'clock') {
            state.snapshot.elapsedMs = event.elapsedMs ?? state.snapshot.elapsedMs;
            els.elapsedTime.textContent = formatTime(state.snapshot.elapsedMs);
        }
    });
    window.addEventListener('beforeunload', () => unsubscribe?.(), { once: true });
}

function bindPreferenceEvents() {
    if (typeof api.onOverlayPreferences !== 'function') return;
    const unsubscribe = api.onOverlayPreferences(preferences => {
        if (!preferences) return;
        state.preferences = { ...state.preferences, ...preferences };
        render();
    });
    window.addEventListener('beforeunload', () => unsubscribe?.(), { once: true });
}

async function initialize() {
    populateLanguages();
    bindControls();
    bindSegmentCopy();
    bindBallDrag();
    window.addEventListener('resize', layoutVisibleSegments);
    bindMediaEvents();
    bindPreferenceEvents();
    const [preferences, snapshot] = await Promise.all([
        invoke('getOverlayPreferences'),
        invoke('getMediaSnapshot'),
    ]);
    if (preferences) state.preferences = { ...state.preferences, ...preferences };
    if (snapshot) mergeSnapshot(snapshot);
    render();
}

void initialize();
