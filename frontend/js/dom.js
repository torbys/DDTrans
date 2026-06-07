/**
 * DOM 元素引用
 */

// 主按钮与区域
export const startBtn = document.getElementById("startBtn");
export const emptyState = document.getElementById("emptyState");
export const bilingualContent = document.getElementById("bilingualContent");
export const sourceArea = document.getElementById("sourceArea");
export const sourceText = document.getElementById("sourceText");
export const targetArea = document.getElementById("targetArea");
export const targetText = document.getElementById("targetText");
export const sessionTitle = document.getElementById("sessionTitle");

// 底部状态栏已移除，相关 DOM 引用保留但不再使用
export let statusText = null;
export let audioLevelEl = null;
export let connectionStatusEl = null;

// 音频测试面板
export const audioTestBtn = document.getElementById("audioTestBtn");
export const audioTestPanel = document.getElementById("audioTestPanel");
export const audioTestClose = document.getElementById("audioTestClose");
export const audioTestStartBtn = document.getElementById("audioTestStartBtn");
export const audioTestStopBtn = document.getElementById("audioTestStopBtn");
export const audioTestStatus = document.getElementById("audioTestStatus");
export const volumeBars = document.getElementById("volumeBars");

// 字号控制
export const increaseFontBtn = document.getElementById("increaseFontBtn");
export const decreaseFontBtn = document.getElementById("decreaseFontBtn");

// 视图模式
export const viewModeDropdown = document.getElementById("viewModeDropdown");
export const viewModeMenu = document.getElementById("viewModeMenu");
export const viewModeLabel = document.getElementById("viewModeLabel");

// 语言选择（自定义下拉）
export const sourceLangDropdown = document.getElementById("sourceLangDropdown");
export const sourceLangTrigger = document.getElementById("sourceLangTrigger");
export const sourceLangMenu = document.getElementById("sourceLangMenu");
export const sourceLangName = document.getElementById("sourceLangName");
export const sourceLangNative = document.getElementById("sourceLangNative");

export const targetLangDropdown = document.getElementById("targetLangDropdown");
export const targetLangTrigger = document.getElementById("targetLangTrigger");
export const targetLangMenu = document.getElementById("targetLangMenu");
export const targetLangName = document.getElementById("targetLangName");
export const targetLangNative = document.getElementById("targetLangNative");

export const langSwapBtn = document.getElementById("langSwapBtn");

// 音频输入源
export const audioSourceBtn = document.getElementById("audioSourceBtn");
export const audioSourcePanel = document.getElementById("audioSourcePanel");
export const audioSourceLabel = document.getElementById("audioSourceLabel");
export const aspSystemAudio = document.getElementById("aspSystemAudio");
export const aspMicAudio = document.getElementById("aspMicAudio");
export const aspSystemSub = document.getElementById("aspSystemSub");
export const aspMicSub = document.getElementById("aspMicSub");

// 浮动控制条
export const floatingControls = document.getElementById("floatingControls");
export const fcPauseBtn = document.getElementById("fcPauseBtn");
export const fcStopBtn = document.getElementById("fcStopBtn");
export const fcTimer = document.getElementById("fcTimer");
export const fcVolumeBars = document.getElementById("fcVolumeBars");
