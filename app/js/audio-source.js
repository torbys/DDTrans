/**
 * 音频输入源管理
 */

import * as dom from './dom.js';
import * as state from './state.js';

export async function enumerateAudioDevices() {
    try {
        // 先请求一次权限，否则标签可能为空
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        state.setAudioInputDevices(devices.filter((d) => d.kind === "audioinput"));
        renderMicDeviceList();
    } catch (err) {
        console.error("[前端] 枚举音频设备失败:", err);
    }
}

function renderMicDeviceList() {
    dom.aspMicSub.innerHTML = "";

    // 过滤并去重：只保留真实麦克风硬件
    const seenLabels = new Set();
    const uniqueDevices = [];
    state.audioInputDevices.forEach((device) => {
        const label = device.label || "";
        // 跳过系统虚拟设备、立体声混音等非麦克风设备
        if (device.deviceId === "default" || device.deviceId === "communications") {
            return;
        }
        // 跳过 label 中包含 Default / Communications / 立体声混音 的设备
        if (/^Default\s*[-–—]/i.test(label) || /^Communications\s*[-–—]/i.test(label)) {
            return;
        }
        if (label.includes("立体声混音") || label.includes("Stereo Mix")) {
            return;
        }
        // 去重
        if (!seenLabels.has(label)) {
            seenLabels.add(label);
            uniqueDevices.push(device);
        }
    });

    uniqueDevices.forEach((device, index) => {
        const div = document.createElement("div");
        div.className = "asp-sub-item" + (index === 0 ? " active" : "");
        div.dataset.deviceId = device.deviceId;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = device.label || `麦克风 ${index + 1}`;

        div.appendChild(nameSpan);

        div.addEventListener("click", () => {
            if (!state.useMicAudio) return;
            dom.aspMicSub.querySelectorAll(".asp-sub-item").forEach((el) => el.classList.remove("active"));
            div.classList.add("active");
            state.setSelectedMicDeviceId(device.deviceId);
        });

        dom.aspMicSub.appendChild(div);
    });

    if (uniqueDevices.length > 0) {
        state.setSelectedMicDeviceId(uniqueDevices[0].deviceId);
    }

    // 根据麦克风勾选状态更新子选项样式
    updateMicSubState();
}

export function updateAudioSourceLabel() {
    state.setUseSystemAudio(dom.aspSystemAudio.checked);
    state.setUseMicAudio(dom.aspMicAudio.checked);

    if (state.useSystemAudio && state.useMicAudio) {
        dom.audioSourceLabel.textContent = "混合声源";
    } else if (state.useSystemAudio) {
        dom.audioSourceLabel.textContent = "电脑声音";
    } else if (state.useMicAudio) {
        dom.audioSourceLabel.textContent = "麦克风";
    } else {
        dom.audioSourceLabel.textContent = "请选择声源";
    }

    // 同步麦克风子选项的禁用状态
    updateMicSubState();

    // 如果没有选中任何声源，开始按钮变灰提示
    if (!state.useSystemAudio && !state.useMicAudio) {
        dom.startBtn.style.opacity = "0.5";
        dom.startBtn.style.cursor = "not-allowed";
        dom.startBtn.title = "请至少选择一个输入声源";
    } else {
        dom.startBtn.style.opacity = "";
        dom.startBtn.style.cursor = "";
        dom.startBtn.title = "";
    }
}

function updateMicSubState() {
    const items = dom.aspMicSub.querySelectorAll(".asp-sub-item");
    items.forEach((item) => {
        item.classList.toggle("disabled", !state.useMicAudio);
    });
}
