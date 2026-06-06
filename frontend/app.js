/**
 * AI 同声传译助手 - 前端核心逻辑
 *
 * 使用 ScriptProcessorNode 采集原始 PCM 音频
 *
 * 音频管道：麦克风 → ScriptProcessor(Float32) → 重采样(16kHz) → Int16 → WebSocket → 千问API
 */

// ============ DOM 元素 ============
const startBtn = document.getElementById("startBtn");
const emptyState = document.getElementById("emptyState");
const bilingualContent = document.getElementById("bilingualContent");
const sourceArea = document.getElementById("sourceArea");
const sourceText = document.getElementById("sourceText");
const targetArea = document.getElementById("targetArea");
const targetText = document.getElementById("targetText");
const statusText = document.getElementById("statusText");
const audioLevelEl = document.getElementById("audioLevel");
const connectionStatusEl = document.getElementById("connectionStatus");
const langDisplay = document.getElementById("langDisplay");
const audioTestBtn = document.getElementById("audioTestBtn");
const audioTestPanel = document.getElementById("audioTestPanel");
const audioTestClose = document.getElementById("audioTestClose");
const audioTestStartBtn = document.getElementById("audioTestStartBtn");
const audioTestStopBtn = document.getElementById("audioTestStopBtn");
const audioTestStatus = document.getElementById("audioTestStatus");
const volumeBars = document.getElementById("volumeBars");
const sessionTitle = document.getElementById("sessionTitle");

// 字号控制
const increaseFontBtn = document.getElementById("increaseFontBtn");
const decreaseFontBtn = document.getElementById("decreaseFontBtn");

// 视图模式
const viewModeDropdown = document.getElementById("viewModeDropdown");
const viewModeMenu = document.getElementById("viewModeMenu");
const viewModeLabel = document.getElementById("viewModeLabel");

// 语言选择
const sourceLangSelect = document.getElementById("sourceLangSelect");
const targetLangSelect = document.getElementById("targetLangSelect");

// 浮动控制条
const floatingControls = document.getElementById("floatingControls");
const fcPauseBtn = document.getElementById("fcPauseBtn");
const fcStopBtn = document.getElementById("fcStopBtn");
const fcTimer = document.getElementById("fcTimer");
const fcVolumeBars = document.getElementById("fcVolumeBars");

// ============ 状态 ============
let ws = null;
let audioContext = null;
let scriptProcessor = null;
let microphoneStream = null;
let isRunning = false;
let isPaused = false;
let timerInterval = null;
let startTime = 0;
let pausedTime = 0;
let totalPaused = 0;

// 音频测试专用
let testAudioCtx = null;
let testScriptProcessor = null;
let testMicrophoneStream = null;
let testAnalyser = null;
let testAnimationId = null;

// 文本内容 - 每段话的结构: { finalSpan, stashSpan }
let currentSourceSegment = null;
let currentTargetSegment = null;

// 用数组存储原文和译文内容（每段为字符串）
let sourceSegments = [];
let targetSegments = [];

// 字号设置
let currentFontSize = 15;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 24;

// 视图模式: bilingual | source | target
let currentViewMode = "bilingual";

// 语言设置
let currentSourceLang = "en";
let currentTargetLang = "zh";

// ============ 音频采集参数 ============
const TARGET_SAMPLE_RATE = 16000; // 千问 API 要求的采样率
const BUFFER_SIZE = 4096;         // ScriptProcessor 缓冲区大小 (2的幂次方)

// ============ 初始化 ============
function init() {
    startBtn.addEventListener("click", toggleTranslation);
    audioTestBtn.addEventListener("click", toggleAudioTestPanel);
    audioTestClose.addEventListener("click", () => {
        audioTestPanel.classList.remove("show");
        stopAudioTest();
    });
    audioTestStartBtn.addEventListener("click", startAudioTest);
    audioTestStopBtn.addEventListener("click", stopAudioTest);

    // 浮动控制条
    fcPauseBtn.addEventListener("click", togglePause);
    fcStopBtn.addEventListener("click", stopTranslation);

    // 生成音量格子
    buildVolumeBars();
    buildFcVolumeBars();

    // 隐藏翻译区域
    sourceArea.classList.remove("show");
    targetArea.classList.remove("show");

    // 字号控制事件
    increaseFontBtn.addEventListener("click", increaseFontSize);
    decreaseFontBtn.addEventListener("click", decreaseFontSize);

    // 视图模式下拉菜单
    viewModeDropdown.addEventListener("click", (e) => {
        e.stopPropagation();
        viewModeMenu.classList.toggle("show");
    });
    document.addEventListener("click", () => {
        viewModeMenu.classList.remove("show");
    });
    viewModeMenu.addEventListener("click", (e) => {
        if (e.target.classList.contains("dropdown-item")) {
            const mode = e.target.dataset.mode;
            setViewMode(mode);
        }
    });

    // 语言选择事件
    sourceLangSelect.addEventListener("change", () => {
        currentSourceLang = sourceLangSelect.value;
        updateLangDisplay();
    });
    targetLangSelect.addEventListener("change", () => {
        currentTargetLang = targetLangSelect.value;
        updateLangDisplay();
    });
}

// ============ 音量格子 ============
function buildVolumeBars() {
    volumeBars.innerHTML = "";
    for (let i = 0; i < 30; i++) {
        const bar = document.createElement("div");
        bar.className = "vol-bar";
        bar.dataset.index = i;
        volumeBars.appendChild(bar);
    }
}

function buildFcVolumeBars() {
    fcVolumeBars.innerHTML = "";
    for (let i = 0; i < 20; i++) {
        const bar = document.createElement("div");
        bar.className = "fc-vol-bar";
        bar.dataset.index = i;
        fcVolumeBars.appendChild(bar);
    }
}

function updateVolumeBars(level, container) {
    const bars = container.querySelectorAll(".vol-bar, .fc-vol-bar");
    const activeCount = Math.floor(level * bars.length);
    bars.forEach((bar, i) => {
        bar.classList.toggle("active", i < activeCount);
        if (i < activeCount) {
            if (i < bars.length * 0.3) bar.style.background = "#52c41a";
            else if (i < bars.length * 0.7) bar.style.background = "#faad14";
            else bar.style.background = "#ff4d4f";
        } else {
            bar.style.background = "";
        }
    });
}

// ============ 音频测试面板 ============
function toggleAudioTestPanel() {
    const isOpen = audioTestPanel.classList.toggle("show");
    if (!isOpen) {
        stopAudioTest();
    }
}

async function startAudioTest() {
    try {
        audioTestStatus.textContent = "正在获取麦克风权限...";
        audioTestStartBtn.disabled = true;
        audioTestStopBtn.disabled = false;

        testMicrophoneStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
        });

        testAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const sampleRate = testAudioCtx.sampleRate;
        console.log(`[音频测试] AudioContext 采样率: ${sampleRate}Hz`);

        testAnalyser = testAudioCtx.createAnalyser();
        testAnalyser.fftSize = 256;
        testAnalyser.smoothingTimeConstant = 0.3;

        testScriptProcessor = testAudioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
        const source = testAudioCtx.createMediaStreamSource(testMicrophoneStream);
        source.connect(testAnalyser);
        source.connect(testScriptProcessor);
        testScriptProcessor.connect(testAudioCtx.destination);

        const freqData = new Uint8Array(testAnalyser.frequencyBinCount);
        let silenceCount = 0;

        function detectVolume() {
            testAnalyser.getByteFrequencyData(freqData);
            let sum = 0;
            for (let i = 0; i < freqData.length; i++) sum += freqData[i];
            const avg = sum / freqData.length / 255;

            updateVolumeBars(avg, volumeBars);

            if (avg > 0.5) {
                audioTestStatus.textContent = `检测到较强声音 (${Math.round(avg * 100)}%) - 麦克风工作正常`;
                silenceCount = 0;
            } else if (avg > 0.05) {
                audioTestStatus.textContent = `检测到声音 (${Math.round(avg * 100)}%) - 请继续说话`;
                silenceCount = 0;
            } else {
                silenceCount++;
                if (silenceCount > 30) {
                    audioTestStatus.textContent = "未检测到声音 - 请检查麦克风是否静音";
                } else {
                    audioTestStatus.textContent = "正在监听... 请说话或播放音频";
                }
            }

            testAnimationId = requestAnimationFrame(detectVolume);
        }

        detectVolume();
        audioTestStatus.textContent = "麦克风已开启 - 请说话或播放音频";

    } catch (err) {
        audioTestStatus.textContent = "测试失败: " + err.message;
        audioTestStartBtn.disabled = false;
        audioTestStopBtn.disabled = true;
        console.error("[音频测试] 失败:", err);
    }
}

function stopAudioTest() {
    if (testAnimationId) {
        cancelAnimationFrame(testAnimationId);
        testAnimationId = null;
    }
    if (testScriptProcessor) {
        testScriptProcessor.disconnect();
        testScriptProcessor = null;
    }
    if (testMicrophoneStream) {
        testMicrophoneStream.getTracks().forEach((t) => t.stop());
        testMicrophoneStream = null;
    }
    if (testAudioCtx && testAudioCtx.state !== "closed") {
        testAudioCtx.close();
        testAudioCtx = null;
    }
    testAnalyser = null;

    audioTestStatus.textContent = "点击开始测试麦克风";
    audioTestStartBtn.disabled = false;
    audioTestStopBtn.disabled = true;
    updateVolumeBars(0, volumeBars);
}

// ============ 视图模式切换 ============
function setViewMode(mode) {
    currentViewMode = mode;

    // 更新下拉菜单显示
    viewModeLabel.textContent = mode === "bilingual" ? "双语" : mode === "source" ? "原文" : "译文";
    viewModeMenu.querySelectorAll(".dropdown-item").forEach((item) => {
        item.classList.toggle("active", item.dataset.mode === mode);
    });

    if (isRunning) {
        applyViewMode();
    }
}

function applyViewMode() {
    sourceArea.classList.remove("show");
    targetArea.classList.remove("show");
    bilingualContent.classList.remove("single-view");

    switch (currentViewMode) {
        case "bilingual":
            sourceArea.classList.add("show");
            targetArea.classList.add("show");
            break;
        case "source":
            sourceArea.classList.add("show");
            bilingualContent.classList.add("single-view");
            break;
        case "target":
            targetArea.classList.add("show");
            bilingualContent.classList.add("single-view");
            break;
    }
}

// ============ 语言选择同步 ============
function updateLangDisplay() {
    const langNames = {
        zh: "中", en: "英", ja: "日", ko: "韩", fr: "法", de: "德",
        es: "西", pt: "葡", ru: "俄", ar: "阿", it: "意", id: "印尼",
        vi: "越", th: "泰", tr: "土", hi: "印", ms: "马", nl: "荷",
        ur: "乌", nb: "挪", sv: "瑞", da: "丹", he: "希", fi: "芬",
        pl: "波", is: "冰", cs: "捷", fil: "菲", fa: "波", yue: "粤",
        el: "希", af: "非", ast: "阿斯", be: "白", bg: "保", bn: "孟",
        bs: "波", ca: "加", ceb: "宿", et: "爱", gl: "加", gu: "古",
        hr: "克", hu: "匈", jv: "爪", kk: "哈", kn: "卡", ky: "柯",
        lv: "拉", mk: "马", ml: "马", mr: "马", pa: "旁", ro: "罗",
        sk: "斯", sl: "斯", sw: "斯", tg: "塔", az: "阿", uk: "乌"
    };
    const s = langNames[currentSourceLang] || currentSourceLang;
    const t = langNames[currentTargetLang] || currentTargetLang;
    // 不需要额外显示，select 本身已展示
}

// ============ 工具函数 ============
function setStatus(text, state) {
    statusText.textContent = text;
    statusText.className = state || "";
}

// ============ 启动 ============
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