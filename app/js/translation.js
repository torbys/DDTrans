/**
 * 翻译核心逻辑（WebSocket 通信 + 音频发送）
 */

import * as dom from './dom.js';
import * as state from './state.js';
import * as renderer from './renderer.js';
import * as view from './view.js';
import * as lang from './lang.js';
import { TARGET_SAMPLE_RATE, BUFFER_SIZE } from './config.js';
import { setStatus, resample, float32ToInt16, updateVolumeBars } from './utils.js';
import { getAudioStreamBySelection } from './audio-capture.js';

export async function toggleTranslation() {
    if (state.isRunning) {
        stopTranslation();
        return;
    }

    // 检查是否至少选择了一个声源
    if (!dom.aspSystemAudio.checked && !dom.aspMicAudio.checked) {
        setStatus("请至少选择一个输入声源", "error");
        dom.audioSourcePanel.classList.add("show");
        setTimeout(() => {
            dom.audioSourcePanel.classList.remove("show");
        }, 2000);
        return;
    }

    await startTranslation();
}

async function startTranslation() {
    try {
        setStatus("连接中...", "connecting");
        dom.startBtn.disabled = true;
        dom.startBtn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> 启动中...';

        // 同传过程中禁用语言选择和交换按钮
        lang.setLangDropdownDisabled(true);
        dom.langSwapBtn.disabled = true;

        // 1. 获取音频流（根据用户选择）
        const finalStream = await getAudioStreamBySelection();
        if (!finalStream) {
            throw new Error("无法获取音频流");
        }

        state.setMicrophoneStream(finalStream);
        console.log("[前端] 音频流已获取");

        // 2. 创建 AudioContext
        state.setAudioContext(new (window.AudioContext || window.webkitAudioContext)());
        const sourceSampleRate = state.audioContext.sampleRate;
        console.log(`[前端] AudioContext 采样率: ${sourceSampleRate}Hz (目标: ${TARGET_SAMPLE_RATE}Hz)`);

        // 3. 创建 ScriptProcessorNode 采集原始 PCM
        state.setScriptProcessor(state.audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1));
        const source = state.audioContext.createMediaStreamSource(state.microphoneStream);
        source.connect(state.scriptProcessor);
        state.scriptProcessor.connect(state.audioContext.destination);

        // 4. 建立 WebSocket 连接
        // Electron 中 location.protocol 是 file:，需要硬编码后端地址
        const wsUrl = (location.protocol === "file:")
            ? "ws://localhost:1145/ws/translate"
            : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/translate`;
        state.setWs(new WebSocket(wsUrl));
        state.ws.binaryType = "arraybuffer";

        state.ws.onopen = () => {
            console.log("[前端] WebSocket 已连接");

            const config = {
                type: "start",
                source_language: state.currentSourceLang,
                target_language: state.currentTargetLang,
                audio_enabled: false, // 不请求语音输出
            };
            console.log("[前端] 发送配置:", JSON.stringify(config, null, 2));
            state.ws.send(JSON.stringify(config));
        };

        state.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            console.log("[前端] 收到消息:", msg.type, msg);
            handleServerMessage(msg);
        };

        state.ws.onerror = (err) => {
            console.error("[前端] WebSocket 错误:", err);
            setStatus("连接错误", "error");
        };

        state.ws.onclose = () => {
            console.log("[前端] WebSocket 已关闭");
            if (state.isRunning) stopTranslation();
        };

        // 5. ScriptProcessor.onaudioprocess - 音频采集 + 重采样 + 发送
        state.scriptProcessor.onaudioprocess = (event) => {
            if (!state.isRunning || state.isPaused || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;

            const inputData = event.inputBuffer.getChannelData(0); // Float32Array
            const inputSampleRate = state.audioContext.sampleRate;

            // 重采样到 16kHz
            const resampled = resample(inputData, inputSampleRate, TARGET_SAMPLE_RATE);

            // Float32 → Int16 (PCM)
            const pcm = float32ToInt16(resampled);

            // 发送 raw PCM bytes
            state.ws.send(pcm.buffer);

            // 更新音量指示
            let rms = 0;
            for (let i = 0; i < resampled.length; i++) {
                rms += resampled[i] * resampled[i];
            }
            rms = Math.sqrt(rms / resampled.length);
            updateVolumeBars(rms * 2, dom.fcVolumeBars);
        };

        // 显示翻译区域，隐藏空状态
        dom.emptyState.style.display = "none";
        view.applyViewMode();

        // 显示浮动控制条
        dom.floatingControls.classList.add("show");

        // 更新会话标题
        const now = new Date();
        dom.sessionTitle.textContent = `${now.getFullYear()}年${String(now.getMonth()+1).padStart(2,'0')}月${String(now.getDate()).padStart(2,'0')}日_记录`;

        state.setIsRunning(true);
        state.setIsPaused(false);
        dom.startBtn.disabled = false;
        dom.startBtn.innerHTML = '<i class="ri-stop-circle-line"></i> 停止同传';
        dom.startBtn.style.background = "#ff4d4f";
        setStatus("翻译中...", "active");

        // 启动计时器
        state.setStartTime(Date.now());
        state.setTotalPaused(0);
        state.setTimerInterval(setInterval(updateTimer, 100));

    } catch (err) {
        console.error("[前端] 启动失败:", err);
        if (err.name === "NotAllowedError") {
            setStatus("请允许麦克风权限", "error");
        } else {
            setStatus("启动失败: " + err.message, "error");
        }
        dom.startBtn.disabled = false;
        dom.startBtn.innerHTML = '<i class="ri-mic-line"></i> 开始同传';
        dom.startBtn.style.background = "";
        cleanup();
    }
}

export function togglePause() {
    if (!state.isRunning) return;
    state.setIsPaused(!state.isPaused);

    if (state.isPaused) {
        state.setPausedTime(Date.now());
        dom.fcPauseBtn.classList.add("paused");
        dom.fcPauseBtn.innerHTML = '<i class="ri-play-fill"></i>';
        setStatus("已暂停", "paused");
        console.log("[前端] 暂停音频输入");
    } else {
        state.setTotalPaused(state.totalPaused + Date.now() - state.pausedTime);
        dom.fcPauseBtn.classList.remove("paused");
        dom.fcPauseBtn.innerHTML = '<i class="ri-pause-fill"></i>';
        setStatus("翻译中...", "active");
        console.log("[前端] 恢复音频输入");
    }
}

export function stopTranslation() {
    if (!state.isRunning) return;
    state.setIsRunning(false);
    state.setIsPaused(false);

    console.log("[前端] 停止翻译");
    setStatus("就绪", "idle");

    dom.startBtn.innerHTML = '<i class="ri-mic-line"></i> 开始同传';
    dom.startBtn.style.background = "";

    // 隐藏浮动控制条
    dom.floatingControls.classList.remove("show");
    dom.fcPauseBtn.classList.remove("paused");
    dom.fcPauseBtn.innerHTML = '<i class="ri-pause-fill"></i>';

    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.setTimerInterval(null);
    }

    cleanup();

    // 回到初始界面：显示空状态，隐藏翻译区域
    dom.emptyState.style.display = "flex";
    dom.sourceArea.classList.remove("show");
    dom.targetArea.classList.remove("show");

    // 清空文本内容
    renderer.clearText();

    // 同传结束后恢复语言选择和交换按钮
    lang.setLangDropdownDisabled(false);
    dom.langSwapBtn.disabled = false;
}

function cleanup() {
    if (state.scriptProcessor) {
        state.scriptProcessor.disconnect();
        state.setScriptProcessor(null);
    }
    if (state.microphoneStream) {
        state.microphoneStream.getTracks().forEach((t) => t.stop());
        state.setMicrophoneStream(null);
    }
    if (state.systemAudioStream) {
        state.systemAudioStream.getTracks().forEach((t) => t.stop());
        state.setSystemAudioStream(null);
    }
    if (state.combinedStream) {
        state.setCombinedStream(null);
    }
    if (state.audioContext && state.audioContext.state !== "closed") {
        state.audioContext.close();
        state.setAudioContext(null);
    }
    if (state.ws) {
        state.ws.close();
        state.setWs(null);
    }
    console.log("[前端] 清理资源完成");
    updateVolumeBars(0, dom.fcVolumeBars);
}

function updateTimer() {
    if (state.isPaused) return;
    const elapsed = Math.floor((Date.now() - state.startTime - state.totalPaused) / 1000);
    const h = Math.floor(elapsed / 3600).toString().padStart(2, "0");
    const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, "0");
    const s = (elapsed % 60).toString().padStart(2, "0");
    dom.fcTimer.textContent = `${h}:${m}:${s}`;
}

function handleServerMessage(msg) {
    switch (msg.type) {
        case "ready":
            console.log("[前端] 服务端就绪，千问会话已配置");
            break;

        case "speech_started":
        case "item_created":
        case "response_created":
            renderer.ensureSourceSegment();
            renderer.ensureTargetSegment();
            break;

        case "source_text_delta":
            renderer.updateSourceSegment(msg.confirmed, msg.stash);
            break;

        case "source_text_final":
            if (state.currentSourceSegment) {
                renderer.finalizeSourceSegment(msg.text);
            }
            break;

        case "translation_delta":
            renderer.updateTargetSegment(msg.confirmed, msg.stash);
            break;

        case "translation_final":
            if (state.currentTargetSegment) {
                renderer.finalizeTargetSegment(msg.text);
            }
            break;

        case "response_done":
            console.log("[前端] 一轮响应完成", msg.usage);
            if (msg.text && state.currentTargetSegment) {
                renderer.finalizeTargetSegment(msg.text);
            }
            break;

        case "session_end":
            console.log("[前端] 会话结束");
            stopTranslation();
            break;

        case "error":
            console.error("[前端] 服务端错误:", msg.message);
            setStatus("错误: " + msg.message, "error");
            break;

        case "connection_closed":
            console.log("[前端] 连接关闭:", msg.reason);
            break;
    }
}
