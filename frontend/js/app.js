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

// ============ 初始化 ============
function init() {
    // 开始/停止按钮
    dom.startBtn.addEventListener("click", translation.toggleTranslation);

    // 音频测试面板
    dom.audioTestBtn.addEventListener("click", audioTest.toggleAudioTestPanel);
    dom.audioTestClose.addEventListener("click", () => {
        dom.audioTestPanel.classList.remove("show");
        audioTest.stopAudioTest();
    });
    dom.audioTestStartBtn.addEventListener("click", audioTest.startAudioTest);
    dom.audioTestStopBtn.addEventListener("click", audioTest.stopAudioTest);

    // 浮动控制条
    dom.fcPauseBtn.addEventListener("click", translation.togglePause);
    dom.fcStopBtn.addEventListener("click", translation.stopTranslation);

    // 生成音量格子
    buildVolumeBars(dom.volumeBars, 30, "vol-bar");
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
    dom.langSwapBtn.addEventListener("click", lang.swapLanguages);

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
