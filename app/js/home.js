import { LANG_DATA } from './config.js';
import { buildVolumeBars, updateVolumeBars } from './utils.js';
const byId = id => document.getElementById(id);
const overlay = byId('createModalOverlay');
const input = byId('meetingNameInput');
const menu = byId('modalTargetLangMenu');
const deviceMenu = byId('modalAudioDeviceMenu');
const level = byId('modalVolumeBars');
const status = byId('modalAudioTestStatus');
let target = 'zh', deviceId = 'default', testStream, context, animation, generation = 0;
input.maxLength = 200;
byId('modalSourceLangName').textContent = '自动识别'; byId('modalSourceLangNative').textContent = 'Auto';
byId('modalSourceLangTrigger').setAttribute('aria-disabled', 'true'); byId('modalSourceLangTrigger').style.pointerEvents = 'none';
byId('modalLangSwapBtn').hidden = true;
buildVolumeBars(level, 16);
function closeMenus() { menu.classList.remove('show'); deviceMenu.classList.remove('show'); }
function updateLanguage() {
    const language = LANG_DATA.find(item => item.code === target);
    byId('modalTargetLangName').textContent = language.name; byId('modalTargetLangNative').textContent = language.native;
}
for (const language of LANG_DATA) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'modal-select-item'; item.textContent = language.name + ' · ' + language.native;
    item.addEventListener('click', () => { target = language.code; updateLanguage(); closeMenus(); }); menu.append(item);
}
byId('modalTargetLangTrigger').addEventListener('click', event => { event.stopPropagation(); const open = !menu.classList.contains('show'); closeMenus(); menu.classList.toggle('show', open); });
byId('modalAudioDeviceTrigger').addEventListener('click', event => { event.stopPropagation(); const open = !deviceMenu.classList.contains('show'); closeMenus(); deviceMenu.classList.toggle('show', open); });
async function stopTest() {
    generation++; if (animation) cancelAnimationFrame(animation); animation = null;
    testStream?.getTracks().forEach(track => track.stop()); testStream = null;
    const old = context; context = null; if (old && old.state !== 'closed') await old.close();
    updateVolumeBars(0, level);
}
async function testDevice(id) {
    await stopTest(); const current = generation; status.textContent = '正在打开麦克风…';
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id === 'default' ? undefined : { exact: id }, channelCount: 1 } });
        if (current !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
        testStream = stream; context = new AudioContext(); await context.resume();
        const analyser = context.createAnalyser(); analyser.fftSize = 512;
        const source = context.createMediaStreamSource(stream); const zero = context.createGain(); zero.gain.value = 0;
        source.connect(analyser); analyser.connect(zero); zero.connect(context.destination);
        const samples = new Float32Array(analyser.fftSize);
        function tick() {
            if (current !== generation) return;
            analyser.getFloatTimeDomainData(samples); let sum = 0; for (const value of samples) sum += value * value;
            const rms = Math.sqrt(sum / samples.length); updateVolumeBars(Math.min(1, rms * 4), level);
            status.textContent = rms > 0.01 ? '已检测到声音，设备可用。' : '正在测试，请对麦克风说话。';
            animation = requestAnimationFrame(tick);
        }
        tick();
    } catch (error) { if (current === generation) { await stopTest(); status.textContent = '测试失败：' + error.message; } }
}
async function loadDevices() {
    deviceMenu.replaceChildren();
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter(item => item.kind === 'audioinput' && item.deviceId !== 'communications');
        if (!inputs.some(item => item.deviceId === 'default')) inputs.unshift({ deviceId: 'default', label: '系统默认麦克风' });
        inputs.forEach((device, index) => {
            const item = document.createElement('button'); item.type = 'button'; item.className = 'modal-select-item'; item.textContent = device.label || '麦克风 ' + (index + 1);
            item.addEventListener('click', () => { deviceId = device.deviceId || 'default'; byId('modalAudioDeviceName').textContent = item.textContent; closeMenus(); void testDevice(deviceId); }); deviceMenu.append(item);
        });
    } catch (error) { status.textContent = '设备列表不可用：' + error.message; }
}
byId('createMeetingCard').addEventListener('click', () => {
    input.value = '同传 ' + new Date().toLocaleString('zh-CN'); overlay.classList.add('show'); input.focus();
    status.textContent = '选择设备可测试音量；开始同传时使用该设备。'; void loadDevices();
});
async function closeModal() { overlay.classList.remove('show'); await stopTest(); }
byId('modalClose').addEventListener('click', () => void closeModal()); byId('modalCancel').addEventListener('click', () => void closeModal());
overlay.addEventListener('click', event => { if (event.target === overlay) void closeModal(); });
byId('modalConfirm').addEventListener('click', async () => {
    byId('modalConfirm').disabled = true;
    try { await stopTest(); const query = new URLSearchParams({ name: input.value.trim() || '未命名同传', targetLang: target, audioDevice: deviceId }); location.href = './index.html?' + query; }
    finally { byId('modalConfirm').disabled = false; }
});
byId('manageMeetingCard').addEventListener('click', () => { if (window.electronAPI) window.electronAPI.openManageWindow(); else location.href = './manage.html'; });
for (const [id, method] of [['minimizeBtn', 'minimizeWindow'], ['maximizeBtn', 'maximizeWindow'], ['closeBtn', 'closeWindow']]) byId(id).addEventListener('click', () => window.electronAPI?.[method]());
document.addEventListener('click', closeMenus);
document.addEventListener('keydown', event => { if (event.key === 'Escape') void closeModal(); });
window.addEventListener('pagehide', () => void stopTest());
updateLanguage();

byId('openOverlayBtn').addEventListener('click', async () => {
    const button = byId('openOverlayBtn'), status = byId('overlayEntryStatus');
    button.disabled = true; status.textContent = '正在准备系统音频和悬浮同传…';
    try {
        await stopTest();
        if (!window.electronAPI) throw new Error('悬浮窗需要通过桌面应用打开');
        await window.electronAPI.enterOverlay({ targetLanguage: target });
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
});
