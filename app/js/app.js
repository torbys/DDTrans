import * as dom from './dom.js';
import * as state from './state.js';
import * as view from './view.js';
import * as lang from './lang.js';
import * as audioSource from './audio-source.js';
import * as translation from './translation.js';
import { buildVolumeBars } from './utils.js';
import { TEXT_ONLY_LANGS } from './config.js';
import { mediaCommand } from './media-client.js';

const run = action => async event => { try { await action(event); } catch (error) { translation.showFeedback(error.message, 'error'); if (dom.hotwordModalOverlay.classList.contains('show')) document.getElementById('hotwordError').textContent = error.message; } };
const params = new URLSearchParams(location.search);
state.setMeetingName(params.get('name') || '同传 ' + new Date().toLocaleString('zh-CN'));
dom.sessionTitle.textContent = state.meetingName;
if (params.get('targetLang')) state.setCurrentTargetLang(params.get('targetLang'));
if (params.get('audioDevice')) state.setSelectedMicDeviceId(params.get('audioDevice'));
try { const saved = JSON.parse(localStorage.getItem('ddtrans.hotwords') || '[]'); if (Array.isArray(saved)) state.setHotwords(saved.filter(word => typeof word.source === 'string' && typeof word.target === 'string').slice(0, 1000)); } catch (_) {}
lang.updateLangDisplay();
lang.initLangDropdown('target', dom.targetLangDropdown, dom.targetLangTrigger, dom.targetLangMenu);
buildVolumeBars(dom.fcVolumeBars, 16);
audioSource.updateAudioSourceLabel();
view.applyLayout(); view.updateFontSize();
state.setAiVoiceEnabled(false);
dom.aiVoiceBtn.setAttribute('aria-pressed', String(state.aiVoiceEnabled));
function checkVoiceSupport() {
    const disabled = TEXT_ONLY_LANGS.includes(state.currentTargetLang) || state.isRunning;
    if (TEXT_ONLY_LANGS.includes(state.currentTargetLang)) { state.setAiVoiceEnabled(false); dom.aiVoiceBtn.setAttribute('aria-pressed', 'false'); }
    dom.aiVoiceBtn.disabled = disabled;
    dom.aiVoiceWrapper.classList.toggle('disabled', TEXT_ONLY_LANGS.includes(state.currentTargetLang));
}
checkVoiceSupport();
document.addEventListener('target-language-changed', checkVoiceSupport);
document.addEventListener('session-state', checkVoiceSupport);
dom.aiVoiceBtn.addEventListener('click', run(async () => {
    if (dom.aiVoiceBtn.disabled) return;
    const enabled = !state.aiVoiceEnabled;
    state.setAiVoiceEnabled(enabled); dom.aiVoiceBtn.setAttribute('aria-pressed', String(enabled));
    await mediaCommand('set-tts', { enabled });
    translation.showFeedback(enabled ? '已开启译音播报，设置会用于下一次开始的同传。' : '已关闭译音播报，下一次开始时仅生成文字字幕。');
}));
dom.aiVoiceHint.title = '实时播报译音；支持自身音频隔离的系统可同时采集电脑声音。部分目标语言仅支持文字。';
document.getElementById('overlayBtn').addEventListener('click', run(translation.enterOverlay));
dom.startBtn.addEventListener('click', run(translation.toggleTranslation));
dom.fcPauseBtn.addEventListener('click', run(translation.togglePause));
dom.sourceSpeakerIcon.addEventListener('click', run(() => translation.playRecording('raw')));
dom.targetSpeakerIcon.addEventListener('click', run(() => translation.playRecording('tts')));
for (const [icon, label] of [[dom.sourceSpeakerIcon, '回放原音'], [dom.targetSpeakerIcon, '回放译音']]) {
    icon.setAttribute('role', 'button'); icon.tabIndex = 0; icon.setAttribute('aria-label', label); icon.title = label;
    icon.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); icon.click(); } });
}
document.querySelector('.notes-textarea').addEventListener('input', translation.scheduleNoteSave);
document.querySelector('.notes-textarea').addEventListener('blur', run(translation.flushNote));
dom.notesToggle.addEventListener('click', () => {
    const collapsed = dom.notesArea.classList.toggle('collapsed'); dom.notesToggle.title = collapsed ? '展开笔记' : '收起笔记';
    dom.notesToggleIcon.className = collapsed ? 'ri-arrow-left-s-line' : 'ri-arrow-right-s-line';
});
function bindModal(overlay, open, close, cancel, confirm, action) {
    open.addEventListener('click', () => overlay.classList.add('show'));
    close.addEventListener('click', () => overlay.classList.remove('show'));
    cancel.addEventListener('click', () => overlay.classList.remove('show'));
    overlay.addEventListener('click', event => { if (event.target === overlay) overlay.classList.remove('show'); });
    confirm.addEventListener('click', run(async () => {
        confirm.disabled = true;
        try { overlay.classList.remove('show'); await action(); } finally { confirm.disabled = false; }
    }));
}
bindModal(dom.stopConfirmOverlay, dom.fcStopBtn, dom.stopConfirmClose, dom.stopConfirmCancel, dom.stopConfirmOk, translation.stopTranslation);
bindModal(dom.restartConfirmOverlay, dom.fcRestartBtn, dom.restartConfirmClose, dom.restartConfirmCancel, dom.restartConfirmOk, async () => { await translation.stopTranslation(); await translation.startTranslation(); });
document.getElementById('newSessionBtn').addEventListener('click', run(translation.startTranslation));
document.getElementById('viewSavedBtn').addEventListener('click', () => {
    const id = translation.getSessionId(); if (!id) return;
    if (window.electronAPI) window.electronAPI.openDetailWindow(id); else location.href = './detail.html?id=' + id;
});
dom.homeBtn.addEventListener('click', run(async () => { if (state.isRunning) await translation.stopTranslation(); location.href = './home.html'; }));
for (const [button, name] of [[dom.minimizeBtn, 'minimizeWindow'], [dom.maximizeBtn, 'maximizeWindow'], [dom.closeBtn, 'closeWindow']]) {
    button.addEventListener('click', () => window.electronAPI?.[name]());
    button.setAttribute('aria-label', button.title);
}
function dropdown(trigger, menu) {
    trigger.addEventListener('click', event => { event.stopPropagation(); menu.classList.toggle('show'); });
    menu.addEventListener('click', event => event.stopPropagation());
}
dropdown(dom.viewModeDropdown, dom.viewModeMenu); dropdown(dom.layoutDropdown, dom.layoutMenu); dropdown(dom.shareBtn, dom.shareMenu);
dom.viewModeMenu.querySelectorAll('[data-mode]').forEach(item => item.addEventListener('click', () => { view.setViewMode(item.dataset.mode); view.applyViewMode(); dom.viewModeMenu.classList.remove('show'); }));
dom.layoutMenu.querySelectorAll('[data-layout]').forEach(item => item.addEventListener('click', () => { view.setLayout(item.dataset.layout); dom.layoutMenu.classList.remove('show'); }));
dom.increaseFontBtn.addEventListener('click', view.increaseFontSize); dom.decreaseFontBtn.addEventListener('click', view.decreaseFontSize);
dom.shareMenu.querySelectorAll('[data-share]').forEach(item => item.addEventListener('click', run(async () => {
    const field = item.dataset.share === 'source' ? 'source_text' : 'target_text';
    const text = translation.getSegments().map(segment => (segment.speaker_id == null ? '' : '说话人 ' + segment.speaker_id + '：') + (segment[field] || '')).join('\n\n');
    if (!text) throw new Error('暂无字幕可复制');
    await navigator.clipboard.writeText(text); dom.shareMenu.classList.remove('show'); translation.showFeedback('字幕已复制。', 'success');
})));
dom.audioSourceBtn.addEventListener('click', run(async event => {
    if (dom.audioSourceBtn.disabled) return;
    event.stopPropagation(); dom.audioSourcePanel.classList.toggle('show');
    if (dom.audioSourcePanel.classList.contains('show')) await audioSource.enumerateAudioDevices();
}));
dom.audioSourcePanel.addEventListener('click', event => event.stopPropagation());
dom.fcSourceBtn.addEventListener('click', event => { event.stopPropagation(); if (!dom.fcSourceBtn.disabled) dom.fcSourcePanel.classList.toggle('show'); });
dom.fcSourcePanel.addEventListener('click', event => event.stopPropagation());
async function sourceChanged(event) {
    const livePanel = event.target === dom.fcSpSystemAudio || event.target === dom.fcSpMicAudio;
    if (livePanel) { dom.aspSystemAudio.checked = dom.fcSpSystemAudio.checked; dom.aspMicAudio.checked = dom.fcSpMicAudio.checked; }
    if (state.isRunning && !dom.aspSystemAudio.checked && !dom.aspMicAudio.checked) { event.target.checked = true; if (livePanel) { dom.aspSystemAudio.checked = dom.fcSpSystemAudio.checked; dom.aspMicAudio.checked = dom.fcSpMicAudio.checked; } throw new Error('同传时至少保留一个输入声源'); }
    audioSource.updateAudioSourceLabel();
    dom.fcSpSystemAudio.checked = state.useSystemAudio; dom.fcSpMicAudio.checked = state.useMicAudio;
    await translation.switchAudioSource();
}
[dom.aspSystemAudio, dom.aspMicAudio, dom.fcSpSystemAudio, dom.fcSpMicAudio].forEach(input => input.addEventListener('change', run(sourceChanged)));
dom.aspMicSub.addEventListener('click', run(async event => { if (event.target.closest('[data-device-id]') && state.isRunning) await translation.switchAudioSource(); }));
function hotwordRow(source = '', target = '') {
    const row = document.createElement('div'); row.className = 'hotword-row';
    for (const [value, placeholder] of [[source, '原文'], [target, '指定译文']]) { const input = document.createElement('input'); input.className = 'hotword-input'; input.value = value; input.placeholder = placeholder; input.maxLength = 500; row.append(input); }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'hotword-delete'; remove.textContent = '×'; remove.setAttribute('aria-label', '删除热词'); remove.addEventListener('click', () => row.remove()); row.append(remove); dom.hotwordList.append(row);
}
function closeHotwords() { dom.hotwordModalOverlay.classList.remove('show'); }
dom.hotwordBtn.addEventListener('click', () => {
    document.getElementById('hotwordError').textContent = '';
    dom.hotwordList.replaceChildren(); state.hotwords.forEach(word => hotwordRow(word.source, word.target)); if (!state.hotwords.length) hotwordRow();
    document.getElementById('hotwordSourceLang').textContent = '自动识别'; document.getElementById('hotwordTargetLang').textContent = dom.targetLangName.textContent;
    dom.hotwordModalOverlay.classList.add('show');
});
dom.hotwordAdd.addEventListener('click', () => { if (dom.hotwordList.children.length < 1000) hotwordRow(); });
dom.hotwordModalClose.addEventListener('click', closeHotwords); dom.hotwordCancel.addEventListener('click', closeHotwords);
dom.hotwordConfirm.addEventListener('click', run(() => {
    const words = [], seen = new Set();
    for (const row of dom.hotwordList.children) {
        const [source, target] = [...row.querySelectorAll('input')].map(input => input.value.trim());
        if (!source && !target) continue;
        if (!source || !target) throw new Error('每个热词都需要原文和指定译文');
        if (seen.has(source)) throw new Error('热词原文重复：' + source);
        seen.add(source); words.push({ source, target });
    }
    state.setHotwords(words); localStorage.setItem('ddtrans.hotwords', JSON.stringify(words)); closeHotwords(); translation.showFeedback('热词已保存，将用于下一次开始的同传。', 'success');
}));
document.addEventListener('click', () => { lang.closeAllLangDropdowns(); [dom.viewModeMenu, dom.layoutMenu, dom.shareMenu, dom.audioSourcePanel, dom.fcSourcePanel].forEach(menu => menu.classList.remove('show')); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeHotwords(); [dom.stopConfirmOverlay, dom.restartConfirmOverlay].forEach(modal => modal.classList.remove('show')); } });
