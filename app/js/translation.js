import { TEXT_ONLY_LANGS } from './config.js';
import * as dom from './dom.js';
import * as state from './state.js';
import * as renderer from './renderer.js';
import * as view from './view.js';
import * as lang from './lang.js';
import { updateVolumeBars } from './utils.js';
import { mediaCommand, getMediaSnapshot, onMediaEvent } from './media-client.js';

let phase = 'idle', sessionId = null, replay, replayDone;
let replayGeneration = 0, sourceSwitching = false;
const segments = new Map();
const notes = () => document.querySelector('.notes-textarea');
function lockSourceControls(locked) {
    for (const control of [dom.aspSystemAudio, dom.aspMicAudio, dom.fcSpSystemAudio, dom.fcSpMicAudio, dom.audioSourceBtn, dom.fcSourceBtn]) {
        control.disabled = locked; control.setAttribute('aria-disabled', String(locked));
    }
    dom.aspMicSub.querySelectorAll('button').forEach(button => { button.disabled = locked || !state.useMicAudio; });
}
export function showFeedback(message, kind = 'info') {
    const element = document.getElementById('sessionFeedback');
    element.textContent = message; element.dataset.kind = kind;
    element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}
function setPhase(next) {
    phase = next;
    const busy = ['starting', 'pausing', 'stopping'].includes(next);
    notes().readOnly = busy;
    lockSourceControls(busy || sourceSwitching);
    state.setIsRunning(!['idle', 'stopped', 'failed'].includes(next));
    renderer.setSessionState(next); lang.setLangDropdownDisabled(state.isRunning);
    dom.aiVoiceBtn.disabled = state.isRunning; dom.hotwordBtn.disabled = state.isRunning;
    dom.startBtn.disabled = busy; dom.fcPauseBtn.disabled = busy;
    dom.fcStopBtn.disabled = next === 'stopping'; dom.fcRestartBtn.disabled = busy;
    const overlayButton = document.getElementById('overlayBtn'); if (overlayButton) overlayButton.disabled = busy;
    dom.fcPauseBtn.setAttribute('aria-label', next === 'paused' ? '恢复同传' : '暂停同传');
    dom.fcPauseBtn.innerHTML = next === 'paused' ? '<i class="ri-play-fill"></i>' : '<i class="ri-pause-fill"></i>';
    dom.floatingControls.classList.toggle('show', state.isRunning && next !== 'starting');
    const labels = { idle: '准备就绪', starting: '正在连接', running: '同传中 · 实时保存', pausing: '正在暂停', paused: '已关闭收音 · 内容已保存', stopping: '正在接收尾段并保存', stopped: '已保存', failed: '连接中断 · 查看历史记录' };
    document.getElementById('sessionStatus').textContent = labels[next] || next;
    document.getElementById('sessionActions').hidden = !['stopped', 'failed'].includes(next);
    dom.sourceSpeakerIcon.style.display = sessionId && ['paused', 'stopped'].includes(next) ? 'inline' : 'none';
    dom.targetSpeakerIcon.style.display = state.aiVoiceEnabled && ['paused', 'stopped'].includes(next) ? 'inline' : 'none';
    document.dispatchEvent(new CustomEvent('session-state', { detail: next }));
}
function updateClock(ms) {
    const seconds = Math.floor(ms / 1000);
    const text = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
    dom.fcTimer.textContent = text; document.getElementById('timerDisplay').textContent = text;
}
function applySnapshot(snapshot) {
    if (snapshot.sessionId !== sessionId || snapshot.phase === 'starting') {
        sessionId = snapshot.sessionId; segments.clear(); renderer.clearText();
    }
    if (snapshot.config && (snapshot.sessionId || state.isRunning || snapshot.phase === 'starting')) {
        const config = snapshot.config;
        state.setMeetingName(config.meetingName); dom.sessionTitle.textContent = config.meetingName;
        state.setCurrentTargetLang(config.targetLanguage); lang.updateLangDisplay();
        state.setUseSystemAudio(config.useSystemAudio); state.setUseMicAudio(config.useMicAudio);
        state.setSelectedMicDeviceId(config.deviceId); state.setAiVoiceEnabled(config.audioEnabled);
        dom.aiVoiceBtn.setAttribute('aria-pressed', String(config.audioEnabled));
        dom.aspSystemAudio.checked = dom.fcSpSystemAudio.checked = config.useSystemAudio;
        dom.aspMicAudio.checked = dom.fcSpMicAudio.checked = config.useMicAudio;
        dom.fcSourceLabel.textContent = config.useSystemAudio && config.useMicAudio ? '混合声源' : config.useSystemAudio ? '电脑声音' : '麦克风';
    }
    if (snapshot.audioRouting && !TEXT_ONLY_LANGS.includes(state.currentTargetLang)) {
        state.setAiVoiceEnabled(snapshot.audioRouting.ttsEnabled);
        dom.aiVoiceBtn.setAttribute('aria-pressed', String(snapshot.audioRouting.ttsEnabled));
    }
    if (snapshot.segments) for (const segment of snapshot.segments) { segments.set(segment.segment_key, segment); renderer.upsertSegment(segment); }
    if (segments.size || snapshot.phase === 'running') { dom.emptyState.style.display = 'none'; view.applyViewMode(); }
    updateClock(snapshot.elapsedMs || 0); setPhase(snapshot.phase);
    if (snapshot.feedback) showFeedback(snapshot.feedback.message, snapshot.feedback.kind);
}
const unsubscribe = onMediaEvent(event => {
    if (event.type === 'snapshot') applySnapshot(event.snapshot);
    if (event.type === 'segment') { segments.set(event.segment.segment_key, event.segment); renderer.upsertSegment(event.segment); }
    if (event.type === 'feedback') showFeedback(event.message, event.kind);
    if (event.type === 'clock') updateClock(event.elapsedMs);
    if (event.type === 'level') updateVolumeBars(event.level * 2, dom.fcVolumeBars);
});
void getMediaSnapshot().then(snapshot => {
    if (!['idle', 'stopped', 'failed'].includes(snapshot.phase)) { applySnapshot(snapshot); notes().value = snapshot.note || ''; }
}).catch(error => showFeedback(error.message, 'error'));
export async function startTranslation() {
    if (state.isRunning) return;
    const draft = sessionId ? '' : notes().value;
    stopReplay(); notes().value = draft;
    try {
        applySnapshot(await mediaCommand('start', { meetingName: state.meetingName, targetLanguage: state.currentTargetLang, useSystemAudio: state.useSystemAudio, useMicAudio: state.useMicAudio, deviceId: state.selectedMicDeviceId, audioEnabled: state.aiVoiceEnabled, hotwords: state.hotwords }));
        if (draft) await flushNote();
    }
    catch (error) { showFeedback(error.message, 'error'); throw error; }
}
export async function toggleTranslation() { if (state.isRunning) await stopTranslation(); else await startTranslation(); }
export async function togglePause() {
    if (!['running', 'paused'].includes(phase)) return;
    stopReplay(); applySnapshot(await mediaCommand(phase === 'running' ? 'pause' : 'resume'));
}
export function flushNote() {
    if (!sessionId || !state.isRunning) return Promise.resolve();
    return mediaCommand('save-note', { content: notes().value });
}
export function scheduleNoteSave() {
    if (sessionId && state.isRunning) void mediaCommand('save-note', { content: notes().value, defer: true }).catch(error => showFeedback(error.message, 'error'));
}
export async function stopTranslation() {
    await flushNote(); stopReplay(); const snapshot = await mediaCommand('stop'); applySnapshot(snapshot); return snapshot.sessionId;
}
export async function switchAudioSource() {
    dom.fcSourceLabel.textContent = state.useSystemAudio && state.useMicAudio ? '混合声源' : state.useSystemAudio ? '电脑声音' : '麦克风';
    if (!['running', 'paused'].includes(phase)) return;
    sourceSwitching = true; lockSourceControls(true); stopReplay();
    try { applySnapshot(await mediaCommand('switch-source', { useSystemAudio: state.useSystemAudio, useMicAudio: state.useMicAudio, deviceId: state.selectedMicDeviceId })); }
    finally { sourceSwitching = false; lockSourceControls(['starting', 'pausing', 'stopping'].includes(phase)); }
}
export async function enterOverlay() {
    if (!window.electronAPI) throw new Error('悬浮窗需要通过桌面应用打开');
    stopReplay(); await flushNote(); await window.electronAPI.enterOverlay({ targetLanguage: state.currentTargetLang });
}
export function stopReplay() { replayGeneration++; if (replay) { replay.pause(); replay.src = ''; replay = null; replayDone?.(); replayDone = null; } }
export async function playRecording(type) {
    if (!sessionId || !['paused', 'stopped'].includes(phase)) return;
    if (replay) { stopReplay(); return; }
    const generation = ++replayGeneration;
    const urls = type === 'raw' ? ['/api/sessions/' + sessionId + '/audio?type=raw'] : [...segments.values()].sort((a, b) => a.sequence_order - b.sequence_order).filter(segment => segment.has_tts_audio && segment.status === 'final').map(segment => '/api/audio/' + segment.id + '?type=tts');
    if (!urls.length) { showFeedback('译音仍在生成，完成后可以回放。'); return; }
    for (const url of urls) {
        if (generation !== replayGeneration) return;
        const audio = new Audio(url); replay = audio;
        try { await new Promise((resolve, reject) => { replayDone = resolve; audio.onended = resolve; audio.onerror = () => reject(new Error('音频加载失败')); audio.play().catch(reject); }); }
        catch (error) { if (generation === replayGeneration) showFeedback(error.message, 'error'); break; }
    }
    if (generation === replayGeneration) { replay = null; replayDone = null; }
}
export function getSessionId() { return sessionId; }
export function getSegments() { return [...segments.values()].sort((a, b) => a.sequence_order - b.sequence_order); }
window.addEventListener('pagehide', () => { unsubscribe(); stopReplay(); });
