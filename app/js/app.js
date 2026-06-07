/**
 * AI 同声传译助手 - 前端入口
 *
 * 使用 ES Module 组织代码
 */

import * as dom from './dom.js';
import * as state from './state.js';
import * as view from './view.js';
import * as lang from './lang.js';
import * as audioSource from './audio-source.js';
import * as audioTest from './audio-test.js';
import * as translation from './translation.js';
import { buildVolumeBars } from './utils.js';
import { TEXT_ONLY_LANGS } from './config.js';

// ============ 初始化 ============
function init() {
    // 解析 URL 参数
    const urlParams = new URLSearchParams(window.location.search);
    const meetingName = urlParams.get("name");
    const sourceLangParam = urlParams.get("sourceLang");
    const targetLangParam = urlParams.get("targetLang");
    const audioDeviceParam = urlParams.get("audioDevice");

    // 应用会议名称
    if (meetingName) {
        dom.sessionTitle.textContent = meetingName;
    }

    // 应用语言设置
    if (sourceLangParam) {
        state.setCurrentSourceLang(sourceLangParam);
    }
    if (targetLangParam) {
        state.setCurrentTargetLang(targetLangParam);
    }
    lang.updateLangDisplay();

    // 应用音频设备设置
    if (audioDeviceParam) {
        state.setSelectedMicDeviceId(audioDeviceParam);
    }

    // 开始/停止按钮
    dom.startBtn.addEventListener("click", translation.toggleTranslation);

    // AI语音切换
    dom.aiVoiceBtn.addEventListener("click", () => {
        if (dom.aiVoiceBtn.disabled) return;
        const enabled = !state.aiVoiceEnabled;
        state.setAiVoiceEnabled(enabled);
        dom.aiVoiceBtn.setAttribute("aria-pressed", enabled);
    });

    // AI语音hint tooltip（全局层级，避免被其他元素遮挡）
    function showAiVoiceTooltip() {
        if (!dom.aiVoiceHint || !dom.aiVoiceTooltip) return;
        const rect = dom.aiVoiceHint.getBoundingClientRect();
        const tooltipWidth = 320;
        // 计算水平居中位置，确保不超出视口
        let left = rect.left + rect.width / 2 - tooltipWidth / 2;
        left = Math.max(10, Math.min(left, window.innerWidth - tooltipWidth - 10));
        // 显示在图标下方
        const top = rect.bottom + 8;
        dom.aiVoiceTooltip.style.left = left + "px";
        dom.aiVoiceTooltip.style.top = top + "px";
        dom.aiVoiceTooltip.classList.add("show");
    }
    function hideAiVoiceTooltip() {
        if (dom.aiVoiceTooltip) {
            dom.aiVoiceTooltip.classList.remove("show");
        }
    }
    if (dom.aiVoiceHint) {
        dom.aiVoiceHint.addEventListener("mouseenter", showAiVoiceTooltip);
        dom.aiVoiceHint.addEventListener("mouseleave", hideAiVoiceTooltip);
    }

    // 检查目标语言是否支持AI语音
    function checkAiVoiceSupport() {
        const targetCode = state.currentTargetLang;
        const isTextOnly = TEXT_ONLY_LANGS.includes(targetCode);
        if (isTextOnly) {
            // 禁用AI语音
            state.setAiVoiceEnabled(false);
            dom.aiVoiceBtn.setAttribute("aria-pressed", "false");
            dom.aiVoiceBtn.disabled = true;
            dom.aiVoiceWrapper.classList.add("disabled");
        } else {
            dom.aiVoiceBtn.disabled = false;
            dom.aiVoiceWrapper.classList.remove("disabled");
        }
    }
    // 初始检查
    checkAiVoiceSupport();

    // 热词配置弹窗
    function openHotwordModal() {
        dom.hotwordModalOverlay.classList.add("show");
        // 更新列标题语言显示
        const sourceLangName = dom.sourceLangName.textContent || "英语";
        const targetLangName = dom.targetLangName.textContent || "中文";
        const hotwordSourceLang = document.getElementById("hotwordSourceLang");
        const hotwordTargetLang = document.getElementById("hotwordTargetLang");
        if (hotwordSourceLang) hotwordSourceLang.textContent = sourceLangName;
        if (hotwordTargetLang) hotwordTargetLang.textContent = targetLangName;
        renderHotwordList();
    }
    function closeHotwordModal() {
        dom.hotwordModalOverlay.classList.remove("show");
    }
    function renderHotwordList() {
        dom.hotwordList.innerHTML = "";
        state.hotwords.forEach((hw, index) => {
            const row = document.createElement("div");
            row.className = "hotword-row";
            row.innerHTML = `
                <input type="text" class="hotword-input" placeholder="原文" value="${hw.source || ''}">
                <input type="text" class="hotword-input" placeholder="译文" value="${hw.target || ''}">
                <button class="hotword-delete" data-index="${index}" title="删除">
                    <i class="ri-delete-bin-line"></i>
                </button>
            `;
            row.querySelector(".hotword-delete").addEventListener("click", () => {
                state.hotwords.splice(index, 1);
                renderHotwordList();
            });
            dom.hotwordList.appendChild(row);
        });
    }
    dom.hotwordBtn.addEventListener("click", openHotwordModal);
    dom.hotwordModalClose.addEventListener("click", closeHotwordModal);
    dom.hotwordCancel.addEventListener("click", closeHotwordModal);
    dom.hotwordConfirm.addEventListener("click", () => {
        const rows = dom.hotwordList.querySelectorAll(".hotword-row");
        const words = [];
        rows.forEach((row) => {
            const inputs = row.querySelectorAll(".hotword-input");
            const source = inputs[0].value.trim();
            const target = inputs[1].value.trim();
            if (source && target) {
                words.push({ source, target });
            }
        });
        state.setHotwords(words);
        closeHotwordModal();
    });
    dom.hotwordAdd.addEventListener("click", () => {
        const row = document.createElement("div");
        row.className = "hotword-row";
        row.innerHTML = `
            <input type="text" class="hotword-input" placeholder="原文">
            <input type="text" class="hotword-input" placeholder="译文">
            <button class="hotword-delete" title="删除">
                <i class="ri-delete-bin-line"></i>
            </button>
        `;
        row.querySelector(".hotword-delete").addEventListener("click", () => {
            row.remove();
        });
        dom.hotwordList.appendChild(row);
    });
    dom.hotwordModalOverlay.addEventListener("click", (e) => {
        if (e.target === dom.hotwordModalOverlay) closeHotwordModal();
    });

    // 布局分区下拉
    dom.layoutDropdown.addEventListener("click", (e) => {
        e.stopPropagation();
        dom.layoutMenu.classList.toggle("show");
    });
    document.addEventListener("click", () => {
        dom.layoutMenu.classList.remove("show");
    });
    dom.layoutMenu.addEventListener("click", (e) => {
        if (e.target.classList.contains("dropdown-item")) {
            const layout = e.target.dataset.layout;
            view.setLayout(layout);
        }
    });

    // 模型选择下拉
    dom.modelDropdown.addEventListener("click", (e) => {
        e.stopPropagation();
        dom.modelMenu.classList.toggle("show");
    });
    document.addEventListener("click", () => {
        dom.modelMenu.classList.remove("show");
    });

    // 浮动控制条
    dom.fcPauseBtn.addEventListener("click", translation.togglePause);

    // 底部声源切换面板
    function updateFcSourceLabel() {
        const useSys = dom.fcSpSystemAudio.checked;
        const useMic = dom.fcSpMicAudio.checked;
        if (useSys && useMic) {
            dom.fcSourceLabel.textContent = "混合声源";
        } else if (useSys) {
            dom.fcSourceLabel.textContent = "电脑声音";
        } else if (useMic) {
            dom.fcSourceLabel.textContent = "麦克风";
        } else {
            dom.fcSourceLabel.textContent = "请选择声源";
        }
    }

    function syncFcSourceToState() {
        state.setUseSystemAudio(dom.fcSpSystemAudio.checked);
        state.setUseMicAudio(dom.fcSpMicAudio.checked);
        // 同步到开始按钮旁的声源面板
        dom.aspSystemAudio.checked = dom.fcSpSystemAudio.checked;
        dom.aspMicAudio.checked = dom.fcSpMicAudio.checked;
        audioSource.updateAudioSourceLabel();
    }

    if (dom.fcSourceBtn) {
        dom.fcSourceBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const isShow = dom.fcSourcePanel.classList.contains("show");
            if (isShow) {
                dom.fcSourcePanel.classList.remove("show");
                dom.fcSourceArrow.classList.remove("ri-arrow-down-s-line");
                dom.fcSourceArrow.classList.add("ri-arrow-up-s-line");
            } else {
                dom.fcSourcePanel.classList.add("show");
                dom.fcSourceArrow.classList.remove("ri-arrow-up-s-line");
                dom.fcSourceArrow.classList.add("ri-arrow-down-s-line");
            }
        });
    }

    document.addEventListener("click", () => {
        if (dom.fcSourcePanel) dom.fcSourcePanel.classList.remove("show");
        if (dom.fcSourceArrow) {
            dom.fcSourceArrow.classList.remove("ri-arrow-down-s-line");
            dom.fcSourceArrow.classList.add("ri-arrow-up-s-line");
        }
    });

    if (dom.fcSourcePanel) {
        dom.fcSourcePanel.addEventListener("click", (e) => {
            e.stopPropagation();
        });
    }

    if (dom.fcSpSystemAudio) {
        dom.fcSpSystemAudio.addEventListener("change", () => {
            updateFcSourceLabel();
            syncFcSourceToState();
            if (state.isRunning) {
                translation.switchAudioSource();
            }
        });
    }
    if (dom.fcSpMicAudio) {
        dom.fcSpMicAudio.addEventListener("change", () => {
            updateFcSourceLabel();
            syncFcSourceToState();
            if (state.isRunning) {
                translation.switchAudioSource();
            }
        });
    }

    // 停止按钮打开确认弹窗
    dom.fcStopBtn.addEventListener("click", () => {
        dom.stopConfirmOverlay.classList.add("show");
    });

    // 结束同传确认弹窗
    dom.stopConfirmClose.addEventListener("click", () => {
        dom.stopConfirmOverlay.classList.remove("show");
    });
    dom.stopConfirmCancel.addEventListener("click", () => {
        dom.stopConfirmOverlay.classList.remove("show");
    });
    dom.stopConfirmOk.addEventListener("click", () => {
        dom.stopConfirmOverlay.classList.remove("show");
        translation.stopTranslation();
    });
    dom.stopConfirmOverlay.addEventListener("click", (e) => {
        if (e.target === dom.stopConfirmOverlay) dom.stopConfirmOverlay.classList.remove("show");
    });

    // AI音频播放按钮
    dom.fcAudioPlayBtn.addEventListener("click", () => {
        if (state.isPlayingAudio) {
            // 停止播放
            stopAudioPlayback();
        } else {
            // 开始播放
            playNextAudioBlob();
        }
    });

    function stopAudioPlayback() {
        if (state.audioSource) {
            try { state.audioSource.stop(); } catch (e) {}
            state.setAudioSource(null);
        }
        if (state.audioCtx && state.audioCtx.state !== "closed") {
            try { state.audioCtx.close(); } catch (e) {}
            state.setAudioCtx(null);
        }
        state.setIsPlayingAudio(false);
        dom.fcAudioPlayBtn.innerHTML = '<i class="ri-volume-up-line"></i>';
        dom.fcAudioPlayBtn.classList.remove("playing");
    }

    async function playNextAudioBlob() {
        if (state.currentAudioIndex >= state.audioBlobs.length) {
            // 全部播放完毕
            stopAudioPlayback();
            state.setCurrentAudioIndex(0);
            return;
        }

        const audioData = state.audioBlobs[state.currentAudioIndex];
        if (!audioData || !audioData.pcm) {
            state.setCurrentAudioIndex(state.currentAudioIndex + 1);
            playNextAudioBlob();
            return;
        }

        try {
            // 创建离线音频上下文解码PCM数据
            const sampleRate = audioData.sampleRate || 24000;
            const numChannels = 1;
            const pcmData = audioData.pcm;
            const length = pcmData.length;

            // 创建AudioBuffer
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            state.setAudioCtx(audioCtx);
            const audioBuffer = audioCtx.createBuffer(numChannels, length, sampleRate);
            const channelData = audioBuffer.getChannelData(0);

            // Int16 -> Float32 (-1.0 ~ 1.0)
            for (let i = 0; i < length; i++) {
                channelData[i] = pcmData[i] / 32768.0;
            }

            // 创建BufferSource并播放
            const source = audioCtx.createBufferSource();
            state.setAudioSource(source);
            source.buffer = audioBuffer;
            source.connect(audioCtx.destination);

            source.onended = () => {
                state.setCurrentAudioIndex(state.currentAudioIndex + 1);
                playNextAudioBlob();
            };

            state.setIsPlayingAudio(true);
            dom.fcAudioPlayBtn.innerHTML = '<i class="ri-pause-fill"></i>';
            dom.fcAudioPlayBtn.classList.add("playing");

            source.start(0);
        } catch (err) {
            console.error("[前端] 音频播放失败:", err);
            state.setCurrentAudioIndex(state.currentAudioIndex + 1);
            playNextAudioBlob();
        }
    }

    // 生成音量格子
    buildVolumeBars(dom.fcVolumeBars, 20, "fc-vol-bar");

    // 隐藏翻译区域
    dom.sourceArea.classList.remove("show");
    dom.targetArea.classList.remove("show");

    // 字号控制事件
    dom.increaseFontBtn.addEventListener("click", view.increaseFontSize);
    dom.decreaseFontBtn.addEventListener("click", view.decreaseFontSize);

    // 视图模式下拉菜单
    dom.viewModeDropdown.addEventListener("click", (e) => {
        e.stopPropagation();
        dom.viewModeMenu.classList.toggle("show");
    });
    document.addEventListener("click", () => {
        dom.viewModeMenu.classList.remove("show");
    });
    dom.viewModeMenu.addEventListener("click", (e) => {
        if (e.target.classList.contains("dropdown-item")) {
            const mode = e.target.dataset.mode;
            view.setViewMode(mode);
        }
    });

    // 初始化自定义语言下拉
    lang.initLangDropdown("source", dom.sourceLangDropdown, dom.sourceLangTrigger, dom.sourceLangMenu, dom.sourceLangName, dom.sourceLangNative);
    lang.initLangDropdown("target", dom.targetLangDropdown, dom.targetLangTrigger, dom.targetLangMenu, dom.targetLangName, dom.targetLangNative);

    // 交换语言按钮
    dom.langSwapBtn.addEventListener("click", () => {
        lang.swapLanguages();
        checkAiVoiceSupport();
    });

    // 监听目标语言变化，检查AI语音支持
    const targetLangObserver = new MutationObserver(() => {
        checkAiVoiceSupport();
    });
    if (dom.targetLangName) {
        targetLangObserver.observe(dom.targetLangName, { childList: true });
    }

    // 音频输入源面板
    dom.audioSourceBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        dom.audioSourcePanel.classList.toggle("show");
    });
    document.addEventListener("click", () => {
        dom.audioSourcePanel.classList.remove("show");
    });
    dom.audioSourcePanel.addEventListener("click", (e) => {
        e.stopPropagation();
    });

    dom.aspSystemAudio.addEventListener("change", audioSource.updateAudioSourceLabel);
    dom.aspMicAudio.addEventListener("change", audioSource.updateAudioSourceLabel);

    // 枚举音频设备
    audioSource.enumerateAudioDevices();

    // 窗口控制按钮（Electron 环境）
    if (window.electronAPI) {
        dom.minimizeBtn.addEventListener("click", () => {
            window.electronAPI.minimizeWindow();
        });
        dom.maximizeBtn.addEventListener("click", () => {
            window.electronAPI.maximizeWindow();
        });
        dom.closeBtn.addEventListener("click", () => {
            window.electronAPI.closeWindow();
        });
    }

    // 笔记收起/展开
    dom.notesToggle.addEventListener("click", () => {
        dom.notesArea.classList.toggle("collapsed");
        const isCollapsed = dom.notesArea.classList.contains("collapsed");
        dom.notesToggle.title = isCollapsed ? "展开笔记" : "收起笔记";
        dom.notesToggleIcon.className = isCollapsed ? "ri-arrow-left-s-line" : "ri-arrow-right-s-line";
    });

    // 返回主页按钮
    dom.homeBtn.addEventListener("click", () => {
        window.location.href = "./home.html";
    });
}

// 启动
init();

// 旋转动画样式
const styleEl = document.createElement("style");
styleEl.textContent = `
    @keyframes ri-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }
    .ri-spin {
        animation: ri-spin 1s linear infinite;
        display: inline-block;
    }
`;
document.head.appendChild(styleEl);
