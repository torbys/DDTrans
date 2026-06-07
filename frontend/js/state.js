/**
 * 全局状态管理
 */

// WebSocket 与音频
export let ws = null;
export let audioContext = null;
export let scriptProcessor = null;
export let microphoneStream = null;

// 运行状态
export let isRunning = false;
export let isPaused = false;
export let timerInterval = null;
export let startTime = 0;
export let pausedTime = 0;
export let totalPaused = 0;

// 音频测试专用
export let testAudioCtx = null;
export let testScriptProcessor = null;
export let testMicrophoneStream = null;
export let testAnalyser = null;
export let testAnimationId = null;

// 文本内容 - 每段话的结构: { finalSpan, stashSpan }
export let currentSourceSegment = null;
export let currentTargetSegment = null;

// 用数组存储原文和译文内容（每段为字符串）
export let sourceSegments = [];
export let targetSegments = [];

// 字号设置
export let currentFontSize = 15;

// 视图模式: bilingual | source | target
export let currentViewMode = "bilingual";

// 语言设置
export let currentSourceLang = "en";
export let currentTargetLang = "zh";

// 音频输入设备
export let audioInputDevices = [];
export let selectedMicDeviceId = "default";
export let useSystemAudio = true;
export let useMicAudio = true;

// 系统音频流（Electron 桌面捕获）
export let systemAudioStream = null;
export let combinedStream = null;

// ============ Setter 函数 ============
export function setWs(val) { ws = val; }
export function setAudioContext(val) { audioContext = val; }
export function setScriptProcessor(val) { scriptProcessor = val; }
export function setMicrophoneStream(val) { microphoneStream = val; }
export function setIsRunning(val) { isRunning = val; }
export function setIsPaused(val) { isPaused = val; }
export function setTimerInterval(val) { timerInterval = val; }
export function setStartTime(val) { startTime = val; }
export function setPausedTime(val) { pausedTime = val; }
export function setTotalPaused(val) { totalPaused = val; }

export function setTestAudioCtx(val) { testAudioCtx = val; }
export function setTestScriptProcessor(val) { testScriptProcessor = val; }
export function setTestMicrophoneStream(val) { testMicrophoneStream = val; }
export function setTestAnalyser(val) { testAnalyser = val; }
export function setTestAnimationId(val) { testAnimationId = val; }

export function setCurrentSourceSegment(val) { currentSourceSegment = val; }
export function setCurrentTargetSegment(val) { currentTargetSegment = val; }

export function setCurrentFontSize(val) { currentFontSize = val; }
export function setCurrentViewMode(val) { currentViewMode = val; }
export function setCurrentSourceLang(val) { currentSourceLang = val; }
export function setCurrentTargetLang(val) { currentTargetLang = val; }

export function setAudioInputDevices(val) { audioInputDevices = val; }
export function setSelectedMicDeviceId(val) { selectedMicDeviceId = val; }
export function setUseSystemAudio(val) { useSystemAudio = val; }
export function setUseMicAudio(val) { useMicAudio = val; }
export function setSystemAudioStream(val) { systemAudioStream = val; }
export function setCombinedStream(val) { combinedStream = val; }

// 数组操作
export function pushSourceSegment(text) { sourceSegments.push(text); }
export function pushTargetSegment(text) { targetSegments.push(text); }
export function clearSourceSegments() { sourceSegments = []; }
export function clearTargetSegments() { targetSegments = []; }
