/** 会议详情浏览页面 */

const backBtn = document.getElementById("backBtn");
const meetingName = document.getElementById("meetingName");
const fontDecrease = document.getElementById("fontDecrease");
const fontIncrease = document.getElementById("fontIncrease");
const exportBtn = document.getElementById("exportBtn");
const minimizeBtn = document.getElementById("minimizeBtn");
const maximizeBtn = document.getElementById("maximizeBtn");
const closeBtn = document.getElementById("closeBtn");
const sourcePanel = document.getElementById("sourcePanel");
const targetPanel = document.getElementById("targetPanel");
const sourceContent = document.getElementById("sourceContent");
const targetContent = document.getElementById("targetContent");
const resizer = document.getElementById("resizer");
const sourcePlayBtn = document.getElementById("sourcePlayBtn");
const targetPlayBtn = document.getElementById("targetPlayBtn");
const sourceProgressFill = document.getElementById("sourceProgressFill");
const targetProgressFill = document.getElementById("targetProgressFill");
const sourceAudioTime = document.getElementById("sourceAudioTime");
const targetAudioTime = document.getElementById("targetAudioTime");
const tabTranslation = document.getElementById("tabTranslation");
const tabNotes = document.getElementById("tabNotes");

const sessionId = new URLSearchParams(window.location.search).get("id");
let sessionData = null;
let currentFontSize = 15;
let currentTab = "translation";
let currentMediaAudio = null;
let currentPlaybackResolve = null;
let playbackVersion = 0;
let activeAudioType = null;

function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function formatTime(seconds) {
    if (seconds === null || seconds === undefined || seconds === "") return "";
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return "00:00";
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

function getSegmentTimeLabel(segment) {
    const formatMilliseconds = (value) => {
        if (value === null || value === undefined || value === "") return "";
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? formatTime(number / 1000) : "";
    };
    const start = formatMilliseconds(segment.start_ms);
    const end = formatMilliseconds(segment.end_ms);
    if (start && end) return `${start} - ${end}`;
    return start || end || "实时";
}

function getSpeakerLabel(segment) {
    const speakerId = segment.speaker_id;
    return speakerId === null || speakerId === undefined || speakerId === ""
        ? "说话人"
        : `说话人 ${String(speakerId)}`;
}

function getSortedSegments() {
    const segments = Array.isArray(sessionData?.segments) ? sessionData.segments : [];
    return segments
        .map((segment, index) => ({ segment, index }))
        .sort((left, right) => {
            const leftOrder = Number(left.segment.sequence_order);
            const rightOrder = Number(right.segment.sequence_order);
            const a = Number.isFinite(leftOrder) ? leftOrder : Number.MAX_SAFE_INTEGER;
            const b = Number.isFinite(rightOrder) ? rightOrder : Number.MAX_SAFE_INTEGER;
            return a - b || left.index - right.index;
        })
        .map(({ segment }) => segment);
}

function renderEmpty(container, message) {
    container.replaceChildren(createElement("div", "notes-empty", message));
}

function createSegment(segment, textKey, emptyText) {
    const article = createElement("article", "detail-segment");
    const meta = createElement("div", "detail-segment-meta");
    meta.append(
        createElement("span", "detail-segment-speaker", getSpeakerLabel(segment)),
        createElement("span", "detail-segment-time", getSegmentTimeLabel(segment)),
    );
    const value = segment[textKey] == null ? "" : String(segment[textKey]);
    const content = createElement("div", "detail-segment-text", value || emptyText);
    if (!value.trim()) content.classList.add("para-empty");
    article.append(meta, content);
    return article;
}

function renderSegmentList(container, textKey, emptyMessage, emptySegmentText) {
    const segments = getSortedSegments();
    if (segments.length === 0) {
        renderEmpty(container, emptyMessage);
        return;
    }
    const fragment = document.createDocumentFragment();
    segments.forEach((segment) => fragment.appendChild(createSegment(segment, textKey, emptySegmentText)));
    container.replaceChildren(fragment);
}

function renderTranslation() {
    renderSegmentList(sourceContent, "source_text", "暂无原文记录", "暂无原文");
    renderSegmentList(targetContent, "target_text", "暂无译文记录", "暂无译文");
}

function renderNotes() {
    renderSegmentList(sourceContent, "source_text", "暂无原文记录", "暂无原文");
    const notes = Array.isArray(sessionData?.notes) ? sessionData.notes : [];
    if (notes.length === 0) {
        renderEmpty(targetContent, "暂无笔记");
        return;
    }
    const fragment = document.createDocumentFragment();
    notes.forEach((note) => fragment.appendChild(createElement("div", "notes-content", note?.content == null ? "" : String(note.content))));
    targetContent.replaceChildren(fragment);
}

function renderContent() {
    if (!sessionData) return;
    if (currentTab === "translation") renderTranslation();
    else renderNotes();
    const noteCount = Array.isArray(sessionData.notes) ? sessionData.notes.length : 0;
    tabNotes.querySelector("span").textContent = noteCount > 0 ? `笔记(${noteCount})` : "笔记";
}

function showError(message) {
    renderEmpty(sourceContent, message);
    renderEmpty(targetContent, message);
}

function hasAudio(type) {
    if (type === 'raw' && sessionData?.session?.has_raw_audio) return true;
    const flag = type === 'raw' ? 'has_raw_audio' : 'has_tts_audio';
    return getSortedSegments().some(segment => segment[flag]);
}

function setButtonIcon(button, iconClass) {
    button.replaceChildren(createElement("i", iconClass));
}

function resetAudioUI() {
    setButtonIcon(sourcePlayBtn, "ri-play-fill");
    setButtonIcon(targetPlayBtn, "ri-play-fill");
    sourceProgressFill.style.width = "0%";
    targetProgressFill.style.width = "0%";
    sourceAudioTime.textContent = "00:00 / 00:00";
    targetAudioTime.textContent = "00:00 / 00:00";
}

function updateAudioBarState() {
    const rawAvailable = hasAudio("raw");
    const ttsAvailable = hasAudio("tts");
    sourcePlayBtn.disabled = !rawAvailable;
    targetPlayBtn.disabled = !ttsAvailable;
    sourcePlayBtn.title = rawAvailable ? "播放会议原音" : "暂无会议原音";
    targetPlayBtn.title = ttsAvailable ? "播放全部译音" : "暂无译音";
}


function stopAllAudio() {
    playbackVersion += 1;
    if (currentMediaAudio) {
        currentMediaAudio.pause();
        currentMediaAudio.removeAttribute("src");
        currentMediaAudio.load();
    }
    currentMediaAudio = null;
    if (currentPlaybackResolve) currentPlaybackResolve();
    currentPlaybackResolve = null;
    activeAudioType = null;
    resetAudioUI();
}

function getAudioControls(type) {
    return type === "raw"
        ? { button: sourcePlayBtn, progress: sourceProgressFill, time: sourceAudioTime }
        : { button: targetPlayBtn, progress: targetProgressFill, time: targetAudioTime };
}

function setPlaying(type) {
    resetAudioUI();
    activeAudioType = type;
    setButtonIcon(getAudioControls(type).button, "ri-pause-fill");
}


function playMediaAudio(url, type, version, label = '') {
    return new Promise((resolve, reject) => {
        if (version !== playbackVersion) {
            resolve();
            return;
        }
        const controls = getAudioControls(type);
        const audio = new Audio(url);
        audio.preload = "metadata";
        currentMediaAudio = audio;
        let settled = false;
        const updateProgress = () => {
            const duration = audio.duration;
            if (!Number.isFinite(duration) || duration <= 0) return;
            controls.progress.style.width = `${Math.min(100, (audio.currentTime / duration) * 100)}%`;
            controls.time.textContent = label + `${formatTime(audio.currentTime)} / ${formatTime(duration)}`;
        };
        const updateDuration = () => {
            if (!Number.isFinite(audio.duration)) return;
            controls.time.textContent = label + `00:00 / ${formatTime(audio.duration)}`;
        };
        const settle = (error) => {
            if (settled) return;
            settled = true;
            audio.removeEventListener("loadedmetadata", updateDuration);
            audio.removeEventListener("timeupdate", updateProgress);
            audio.removeEventListener("ended", onEnded);
            audio.removeEventListener("error", onError);
            if (currentMediaAudio === audio) currentMediaAudio = null;
            if (currentPlaybackResolve === settle) currentPlaybackResolve = null;
            if (error) reject(error);
            else resolve();
        };
        const onEnded = () => settle();
        const onError = () => settle(new Error('录音播放失败'));
        currentPlaybackResolve = settle;
        controls.progress.style.width = "0%";
        controls.time.textContent = label + '00:00 / --:--';
        audio.addEventListener("loadedmetadata", updateDuration);
        audio.addEventListener("timeupdate", updateProgress);
        audio.addEventListener("ended", onEnded);
        audio.addEventListener("error", onError);
        audio.play().catch((error) => settle(error));
    });
}


async function playAudio(type) {
    if (!sessionData || !hasAudio(type)) return;
    stopAllAudio();
    const version = playbackVersion;
    setPlaying(type);
    const urls = type === 'raw' && sessionData.session.has_raw_audio
        ? ['/api/sessions/' + encodeURIComponent(sessionId) + '/audio?type=raw']
        : getSortedSegments().filter(segment => segment[type === 'raw' ? 'has_raw_audio' : 'has_tts_audio'])
            .map(segment => '/api/audio/' + encodeURIComponent(segment.id) + '?type=' + type);
    try {
        for (let index = 0; index < urls.length; index++) {
            if (version !== playbackVersion) return;
            const label = urls.length > 1 ? '第 ' + (index + 1) + '/' + urls.length + ' 段 · ' : '';
            await playMediaAudio(urls[index], type, version, label);
        }
        if (version === playbackVersion) {
            activeAudioType = null;
            resetAudioUI();
        }
    } catch (error) {
        if (version !== playbackVersion) return;
        console.error('播放音频失败:', error);
        const controls = getAudioControls(type);
        activeAudioType = null;
        setButtonIcon(controls.button, 'ri-play-fill');
        controls.time.textContent = '音频加载失败';
        controls.progress.style.width = '0%';
    }
}

async function loadSession() {
    try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
        if (!response.ok) throw new Error(`请求失败 (${response.status})`);
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        sessionData = data;
        meetingName.textContent = data.session?.name || "会议记录";
        renderContent();
        updateAudioBarState();
    } catch (error) {
        console.error("加载会议详情失败:", error);
        showError("加载失败，请检查后端服务");
        sourcePlayBtn.disabled = true;
        targetPlayBtn.disabled = true;
    }
}

function switchTab(tab) {
    currentTab = tab;
    const isTranslation = tab === "translation";
    tabTranslation.classList.toggle("active", isTranslation);
    tabNotes.classList.toggle("active", !isTranslation);
    sourcePanel.querySelector(".panel-label").textContent = "原文";
    targetPanel.querySelector(".panel-label").textContent = isTranslation ? "译文" : "笔记";
    renderContent();
}

function changeFontSize(delta) {
    currentFontSize = Math.max(11, Math.min(24, currentFontSize + delta));
    sourceContent.style.fontSize = `${currentFontSize}px`;
    targetContent.style.fontSize = `${currentFontSize}px`;
}

function initResizer() {
    let isResizing = false;
    let startX = 0;
    let startSourceWidth = 0;
    resizer.addEventListener("mousedown", (event) => {
        isResizing = true;
        startX = event.clientX;
        startSourceWidth = sourcePanel.getBoundingClientRect().width;
        resizer.classList.add("resizing");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", (event) => {
        if (!isResizing) return;
        const containerWidth = document.querySelector(".detail-body").getBoundingClientRect().width;
        const nextSourceWidth = startSourceWidth + event.clientX - startX;
        const minWidth = 200;
        const maxWidth = containerWidth - minWidth - 6;
        if (nextSourceWidth < minWidth || nextSourceWidth > maxWidth) return;
        sourcePanel.style.flex = String(nextSourceWidth / containerWidth);
        targetPanel.style.flex = String(1 - nextSourceWidth / containerWidth - 6 / containerWidth);
    });
    document.addEventListener("mouseup", () => {
        if (!isResizing) return;
        isResizing = false;
        resizer.classList.remove("resizing");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    });
}

function exportSession() {
    if (!sessionData) return;
    const blob = new Blob([JSON.stringify(sessionData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sessionData.session?.name || "会议记录"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
}

function goBack() {
    if (window.electronAPI?.openManageWindow) window.electronAPI.openManageWindow();
    window.close();
}

function bindEvents() {
    if (window.electronAPI) {
        minimizeBtn.addEventListener("click", () => window.electronAPI.minimizeWindow());
        maximizeBtn.addEventListener("click", () => window.electronAPI.maximizeWindow());
        closeBtn.addEventListener("click", () => window.electronAPI.closeWindow());
    }
    backBtn.addEventListener("click", goBack);
    fontDecrease.addEventListener("click", () => changeFontSize(-1));
    fontIncrease.addEventListener("click", () => changeFontSize(1));
    exportBtn.addEventListener("click", exportSession);
    tabTranslation.addEventListener("click", () => switchTab("translation"));
    tabNotes.addEventListener("click", () => switchTab("notes"));
    sourcePlayBtn.addEventListener("click", () => activeAudioType === "raw" ? stopAllAudio() : playAudio("raw"));
    targetPlayBtn.addEventListener("click", () => activeAudioType === "tts" ? stopAllAudio() : playAudio("tts"));
}

async function init() {
    if (!sessionId) {
        showError("缺少会议 ID");
        sourcePlayBtn.disabled = true;
        targetPlayBtn.disabled = true;
        return;
    }
    bindEvents();
    initResizer();
    await loadSession();
}

window.addEventListener('pagehide', stopAllAudio);
init();
