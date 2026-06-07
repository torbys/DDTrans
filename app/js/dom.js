/**
 * DOM 元素引用
 */

// 自定义标题栏按钮
export const titleBar = document.getElementById("titleBar");
export const homeBtn = document.getElementById("homeBtn");
export const minimizeBtn = document.getElementById("minimizeBtn");
export const maximizeBtn = document.getElementById("maximizeBtn");
export const closeBtn = document.getElementById("closeBtn");
export const timerDisplay = document.getElementById("timerDisplay");

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

// AI语音
export const aiVoiceBtn = document.getElementById("aiVoiceBtn");
export const aiVoiceWrapper = document.getElementById("aiVoiceWrapper");
export const aiVoiceHint = document.getElementById("aiVoiceHint");
export const aiVoiceTooltip = document.getElementById("aiVoiceTooltip");

// 热词配置弹窗
export const hotwordBtn = document.getElementById("hotwordBtn");
export const hotwordModalOverlay = document.getElementById("hotwordModalOverlay");
export const hotwordModal = document.getElementById("hotwordModal");
export const hotwordModalClose = document.getElementById("hotwordModalClose");
export const hotwordCancel = document.getElementById("hotwordCancel");
export const hotwordConfirm = document.getElementById("hotwordConfirm");
export const hotwordList = document.getElementById("hotwordList");
export const hotwordAdd = document.getElementById("hotwordAdd");

// 布局分区
export const layoutDropdown = document.getElementById("layoutDropdown");
export const layoutMenu = document.getElementById("layoutMenu");
export const layoutLabel = document.getElementById("layoutLabel");

// 模型选择
export const modelDropdown = document.getElementById("modelDropdown");
export const modelMenu = document.getElementById("modelMenu");

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
export const fcAudioPlayBtn = document.getElementById("fcAudioPlayBtn");
export const fcTimer = document.getElementById("fcTimer");
export const fcVolumeBars = document.getElementById("fcVolumeBars");
export const fcSourceBtn = document.getElementById("fcSourceBtn");
export const fcSourceLabel = document.getElementById("fcSourceLabel");
export const fcSourceArrow = document.getElementById("fcSourceArrow");
export const fcSourcePanel = document.getElementById("fcSourcePanel");
export const fcSpSystemAudio = document.getElementById("fcSpSystemAudio");
export const fcSpMicAudio = document.getElementById("fcSpMicAudio");

// 结束同传确认弹窗
export const stopConfirmOverlay = document.getElementById("stopConfirmOverlay");
export const stopConfirmClose = document.getElementById("stopConfirmClose");
export const stopConfirmCancel = document.getElementById("stopConfirmCancel");
export const stopConfirmOk = document.getElementById("stopConfirmOk");

// 笔记区域
export const notesArea = document.getElementById("notesArea");
export const notesToggle = document.getElementById("notesToggle");
export const notesToggleIcon = document.getElementById("notesToggleIcon");
