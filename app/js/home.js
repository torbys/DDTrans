/**
 * 主页面逻辑
 */

import { LANG_DATA } from './config.js';
import { buildVolumeBars, updateVolumeBars } from './utils.js';

// DOM 元素
const minimizeBtn = document.getElementById("minimizeBtn");
const maximizeBtn = document.getElementById("maximizeBtn");
const closeBtn = document.getElementById("closeBtn");
const createMeetingCard = document.getElementById("createMeetingCard");
const manageMeetingCard = document.getElementById("manageMeetingCard");

// 弹窗
const createModalOverlay = document.getElementById("createModalOverlay");
const createModal = document.getElementById("createModal");
const modalClose = document.getElementById("modalClose");
const modalCancel = document.getElementById("modalCancel");
const modalConfirm = document.getElementById("modalConfirm");
const meetingNameInput = document.getElementById("meetingNameInput");

// 弹窗语言选择
const modalSourceLangDropdown = document.getElementById("modalSourceLangDropdown");
const modalSourceLangTrigger = document.getElementById("modalSourceLangTrigger");
const modalSourceLangMenu = document.getElementById("modalSourceLangMenu");
const modalSourceLangName = document.getElementById("modalSourceLangName");
const modalSourceLangNative = document.getElementById("modalSourceLangNative");

const modalTargetLangDropdown = document.getElementById("modalTargetLangDropdown");
const modalTargetLangTrigger = document.getElementById("modalTargetLangTrigger");
const modalTargetLangMenu = document.getElementById("modalTargetLangMenu");
const modalTargetLangName = document.getElementById("modalTargetLangName");
const modalTargetLangNative = document.getElementById("modalTargetLangNative");

const modalLangSwapBtn = document.getElementById("modalLangSwapBtn");

// 音频设备选择
const modalAudioDeviceDropdown = document.getElementById("modalAudioDeviceDropdown");
const modalAudioDeviceTrigger = document.getElementById("modalAudioDeviceTrigger");
const modalAudioDeviceMenu = document.getElementById("modalAudioDeviceMenu");
const modalAudioDeviceName = document.getElementById("modalAudioDeviceName");
const modalVolumeBars = document.getElementById("modalVolumeBars");
const modalAudioTestStatus = document.getElementById("modalAudioTestStatus");

// 状态
let modalSourceLang = "en";
let modalTargetLang = "zh";
let modalSelectedDeviceId = null;
let modalTestStream = null;
let modalTestAudioCtx = null;
let modalTestAnalyser = null;
let modalTestAnimationId = null;

// ============ 初始化 ============
function init() {
    // 窗口控制按钮（Electron 环境）
    if (window.electronAPI) {
        minimizeBtn.addEventListener("click", () => {
            window.electronAPI.minimizeWindow();
        });
        maximizeBtn.addEventListener("click", () => {
            window.electronAPI.maximizeWindow();
        });
        closeBtn.addEventListener("click", () => {
            window.electronAPI.closeWindow();
        });
    }

    // 创建同传 - 打开弹窗
    createMeetingCard.addEventListener("click", openModal);

    // 同传管理 - 暂留
    manageMeetingCard.addEventListener("click", () => {
        console.log("同传管理功能暂留");
    });

    // 弹窗关闭
    modalClose.addEventListener("click", closeModal);
    modalCancel.addEventListener("click", closeModal);
    createModalOverlay.addEventListener("click", (e) => {
        if (e.target === createModalOverlay) closeModal();
    });

    // 确定创建
    modalConfirm.addEventListener("click", confirmCreate);

    // 初始化弹窗语言下拉
    initModalLangDropdowns();

    // 初始化音频设备下拉
    initAudioDeviceDropdown();

    // 生成音量格子
    buildVolumeBars(modalVolumeBars, 20, "vol-bar");

    // 默认会议名称
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月${String(now.getDate()).padStart(2, '0')}日`;
    meetingNameInput.value = `${dateStr}_记录_1`;
}

// ============ 弹窗控制 ============
function openModal() {
    createModalOverlay.classList.add("show");
}

function closeModal() {
    createModalOverlay.classList.remove("show");
    stopModalAudioTest();
}

function confirmCreate() {
    const meetingName = meetingNameInput.value.trim() || "未命名会议";

    // 构建 URL 参数
    const params = new URLSearchParams();
    params.set("name", meetingName);
    params.set("sourceLang", modalSourceLang);
    params.set("targetLang", modalTargetLang);
    if (modalSelectedDeviceId) params.set("audioDevice", modalSelectedDeviceId);

    window.location.href = `./index.html?${params.toString()}`;
}

// ============ 弹窗语言选择 ============
function initModalLangDropdowns() {
    renderLangMenu(modalSourceLangMenu, "source");
    renderLangMenu(modalTargetLangMenu, "target");

    modalSourceLangTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleModalLangDropdown(modalSourceLangMenu, modalSourceLangDropdown);
    });

    modalTargetLangTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleModalLangDropdown(modalTargetLangMenu, modalTargetLangDropdown);
    });

    modalLangSwapBtn.addEventListener("click", () => {
        const temp = modalSourceLang;
        modalSourceLang = modalTargetLang;
        modalTargetLang = temp;
        updateModalLangDisplay();
    });

    document.addEventListener("click", () => {
        modalSourceLangMenu.classList.remove("show");
        modalSourceLangDropdown.classList.remove("open");
        modalTargetLangMenu.classList.remove("show");
        modalTargetLangDropdown.classList.remove("open");
        modalAudioDeviceMenu.classList.remove("show");
        modalAudioDeviceDropdown.classList.remove("open");
    });

    updateModalLangDisplay();
}

function renderLangMenu(menu, type) {
    menu.innerHTML = "";
    LANG_DATA.forEach((lang) => {
        const item = document.createElement("div");
        item.className = "modal-select-item";
        item.dataset.code = lang.code;
        item.innerHTML = `
            <span class="item-name">${lang.name}</span>
            <span class="item-native">${lang.native}</span>
            <span class="item-check"><i class="ri-check-line"></i></span>
        `;
        item.addEventListener("click", () => {
            if (type === "source") {
                modalSourceLang = lang.code;
                if (modalSourceLang === modalTargetLang) {
                    const other = LANG_DATA.find((l) => l.code !== modalSourceLang);
                    if (other) modalTargetLang = other.code;
                }
            } else {
                modalTargetLang = lang.code;
                if (modalTargetLang === modalSourceLang) {
                    const other = LANG_DATA.find((l) => l.code !== modalTargetLang);
                    if (other) modalSourceLang = other.code;
                }
            }
            updateModalLangDisplay();
            modalSourceLangMenu.classList.remove("show");
            modalSourceLangDropdown.classList.remove("open");
            modalTargetLangMenu.classList.remove("show");
            modalTargetLangDropdown.classList.remove("open");
        });
        menu.appendChild(item);
    });
}

function toggleModalLangDropdown(menu, dropdown) {
    const isOpen = menu.classList.contains("show");
    modalSourceLangMenu.classList.remove("show");
    modalSourceLangDropdown.classList.remove("open");
    modalTargetLangMenu.classList.remove("show");
    modalTargetLangDropdown.classList.remove("open");
    if (!isOpen) {
        menu.classList.add("show");
        dropdown.classList.add("open");
        highlightModalActiveItem(menu, dropdown === modalSourceLangDropdown ? modalSourceLang : modalTargetLang);
    }
}

function highlightModalActiveItem(menu, code) {
    menu.querySelectorAll(".modal-select-item").forEach((item) => {
        item.classList.toggle("active", item.dataset.code === code);
    });
}

function updateModalLangDisplay() {
    const sourceLang = LANG_DATA.find((l) => l.code === modalSourceLang);
    const targetLang = LANG_DATA.find((l) => l.code === modalTargetLang);

    if (sourceLang) {
        modalSourceLangName.textContent = sourceLang.name;
        modalSourceLangNative.textContent = sourceLang.native;
    }
    if (targetLang) {
        modalTargetLangName.textContent = targetLang.name;
        modalTargetLangNative.textContent = targetLang.native;
    }
}

// ============ 音频设备选择 ============
async function initAudioDeviceDropdown() {
    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");

        // 去重：按 label 去重，保留第一个
        const seenLabels = new Set();
        const uniqueInputs = audioInputs.filter((d) => {
            if (!d.label || seenLabels.has(d.label)) return false;
            seenLabels.add(d.label);
            return true;
        });

        modalAudioDeviceMenu.innerHTML = "";

        // 添加一个默认选项
        const defaultItem = document.createElement("div");
        defaultItem.className = "modal-select-item active";
        defaultItem.dataset.deviceId = "";
        defaultItem.innerHTML = `
            <span class="item-name">系统默认</span>
            <span class="item-check"><i class="ri-check-line"></i></span>
        `;
        defaultItem.addEventListener("click", () => {
            modalSelectedDeviceId = "";
            modalAudioDeviceName.textContent = "系统默认";
            modalAudioDeviceMenu.classList.remove("show");
            modalAudioDeviceDropdown.classList.remove("open");
            startModalAudioTest("");
        });
        modalAudioDeviceMenu.appendChild(defaultItem);

        uniqueInputs.forEach((device) => {
            const item = document.createElement("div");
            item.className = "modal-select-item";
            item.dataset.deviceId = device.deviceId;
            item.innerHTML = `
                <span class="item-name">${device.label || "未命名设备"}</span>
                <span class="item-check"><i class="ri-check-line"></i></span>
            `;
            item.addEventListener("click", () => {
                modalSelectedDeviceId = device.deviceId;
                modalAudioDeviceName.textContent = device.label || "未命名设备";
                modalAudioDeviceMenu.classList.remove("show");
                modalAudioDeviceDropdown.classList.remove("open");
                startModalAudioTest(device.deviceId);
            });
            modalAudioDeviceMenu.appendChild(item);
        });

        modalAudioDeviceTrigger.addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = modalAudioDeviceMenu.classList.contains("show");
            modalAudioDeviceMenu.classList.remove("show");
            modalAudioDeviceDropdown.classList.remove("open");
            if (!isOpen) {
                modalAudioDeviceMenu.classList.add("show");
                modalAudioDeviceDropdown.classList.add("open");
            }
        });

    } catch (err) {
        console.error("枚举音频设备失败:", err);
        modalAudioDeviceName.textContent = "无法访问音频设备";
    }
}

// ============ 音频测试 ============
async function startModalAudioTest(deviceId) {
    stopModalAudioTest();

    try {
        modalAudioTestStatus.textContent = "正在监听音频...";

        const constraints = {
            audio: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
        };

        modalTestStream = await navigator.mediaDevices.getUserMedia(constraints);
        modalTestAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const sampleRate = modalTestAudioCtx.sampleRate;

        modalTestAnalyser = modalTestAudioCtx.createAnalyser();
        modalTestAnalyser.fftSize = 256;
        modalTestAnalyser.smoothingTimeConstant = 0.3;

        const source = modalTestAudioCtx.createMediaStreamSource(modalTestStream);
        source.connect(modalTestAnalyser);

        const freqData = new Uint8Array(modalTestAnalyser.frequencyBinCount);
        let silenceCount = 0;

        function detectVolume() {
            if (!modalTestAnalyser) return;
            modalTestAnalyser.getByteFrequencyData(freqData);
            let sum = 0;
            for (let i = 0; i < freqData.length; i++) sum += freqData[i];
            const avg = sum / freqData.length / 255;

            updateVolumeBars(avg, modalVolumeBars);

            if (avg > 0.5) {
                modalAudioTestStatus.textContent = `检测到较强声音 (${Math.round(avg * 100)}%) - 音频正常`;
                silenceCount = 0;
            } else if (avg > 0.05) {
                modalAudioTestStatus.textContent = `检测到声音 (${Math.round(avg * 100)}%)`;
                silenceCount = 0;
            } else {
                silenceCount++;
                if (silenceCount > 30) {
                    modalAudioTestStatus.textContent = "未检测到声音 - 请检查设备是否静音";
                } else {
                    modalAudioTestStatus.textContent = "正在监听... 请说话或播放音频";
                }
            }

            modalTestAnimationId = requestAnimationFrame(detectVolume);
        }

        detectVolume();

    } catch (err) {
        modalAudioTestStatus.textContent = "测试失败: " + err.message;
        console.error("[音频测试] 失败:", err);
    }
}

function stopModalAudioTest() {
    if (modalTestAnimationId) {
        cancelAnimationFrame(modalTestAnimationId);
        modalTestAnimationId = null;
    }
    if (modalTestStream) {
        modalTestStream.getTracks().forEach((t) => t.stop());
        modalTestStream = null;
    }
    if (modalTestAudioCtx && modalTestAudioCtx.state !== "closed") {
        modalTestAudioCtx.close();
        modalTestAudioCtx = null;
    }
    modalTestAnalyser = null;
    updateVolumeBars(0, modalVolumeBars);
    modalAudioTestStatus.textContent = "请选择音频设备进行测试";
}

init();
