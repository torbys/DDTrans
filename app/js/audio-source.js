import * as dom from './dom.js';
import * as state from './state.js';

export async function enumerateAudioDevices() {
    let permissionStream;
    try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        if (!devices.some(device => device.kind === 'audioinput' && device.label)) {
            permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            devices = await navigator.mediaDevices.enumerateDevices();
        }
        const inputs = devices.filter(device => device.kind === 'audioinput' && device.deviceId !== 'communications');
        if (!inputs.length) throw new Error('未发现可用麦克风');
        state.setAudioInputDevices(inputs);
        if (!inputs.some(device => device.deviceId === state.selectedMicDeviceId)) {
            state.setSelectedMicDeviceId(inputs.some(device => device.deviceId === 'default') ? 'default' : inputs[0].deviceId);
        }
        renderMicDeviceList();
    } finally {
        permissionStream?.getTracks().forEach(track => track.stop());
    }
}

function renderMicDeviceList() {
    dom.aspMicSub.replaceChildren();
    state.audioInputDevices.forEach((device, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'asp-sub-item';
        item.classList.toggle('active', device.deviceId === state.selectedMicDeviceId);
        item.dataset.deviceId = device.deviceId;
        item.textContent = device.deviceId === 'default' ? '系统默认麦克风' : device.label || '麦克风 ' + (index + 1);
        item.addEventListener('click', () => {
            if (!state.useMicAudio) return;
            dom.aspMicSub.querySelectorAll('.asp-sub-item').forEach(element => element.classList.remove('active'));
            item.classList.add('active');
            state.setSelectedMicDeviceId(device.deviceId);
        });
        dom.aspMicSub.append(item);
    });
    updateMicSubState();
}

export function updateAudioSourceLabel() {
    state.setUseSystemAudio(dom.aspSystemAudio.checked);
    state.setUseMicAudio(dom.aspMicAudio.checked);
    dom.audioSourceLabel.textContent = state.useSystemAudio && state.useMicAudio ? '混合声源' : state.useSystemAudio ? '电脑声音' : state.useMicAudio ? '麦克风' : '请选择声源';
    dom.fcSourceLabel.textContent = dom.audioSourceLabel.textContent;
    updateMicSubState();
    const missing = !state.useSystemAudio && !state.useMicAudio;
    dom.startBtn.style.opacity = missing ? '0.5' : '';
    dom.startBtn.style.cursor = missing ? 'not-allowed' : '';
    dom.startBtn.title = missing ? '请至少选择一个输入声源' : '';
}

function updateMicSubState() {
    dom.aspMicSub.querySelectorAll('.asp-sub-item').forEach(item => {
        item.disabled = !state.useMicAudio || dom.audioSourceBtn.disabled;
        item.classList.toggle('disabled', !state.useMicAudio);
    });
}
