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

// 音频播放队列
let audioChunks = [];

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

        // 同传过程中禁用语言选择、交换按钮、热词和AI语音
        lang.setLangDropdownDisabled(true);
        dom.langSwapBtn.disabled = true;
        dom.hotwordBtn.disabled = true;
        dom.aiVoiceBtn.disabled = true;

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
                audio_enabled: state.aiVoiceEnabled,
            };

            // 添加热词配置
            if (state.hotwords && state.hotwords.length > 0) {
                const phrases = {};
                state.hotwords.forEach((hw) => {
                    if (hw.source && hw.target) {
                        phrases[hw.source] = hw.target;
                    }
                });
                if (Object.keys(phrases).length > 0) {
                    config.corpus = { phrases };
                }
            }

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
            if (!state.isRunning || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
            // 注意：暂停时仍然采集但不发送，保持音频上下文活跃
            if (state.isPaused) {
                // 暂停时只更新音量指示（显示为0）
                updateVolumeBars(0, dom.fcVolumeBars);
                return;
            }

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

        // 同步声源状态到底部控制条面板
        if (dom.fcSpSystemAudio) dom.fcSpSystemAudio.checked = state.useSystemAudio;
        if (dom.fcSpMicAudio) dom.fcSpMicAudio.checked = state.useMicAudio;
        if (dom.fcSourceLabel) {
            if (state.useSystemAudio && state.useMicAudio) {
                dom.fcSourceLabel.textContent = "混合声源";
            } else if (state.useSystemAudio) {
                dom.fcSourceLabel.textContent = "电脑声音";
            } else if (state.useMicAudio) {
                dom.fcSourceLabel.textContent = "麦克风";
            } else {
                dom.fcSourceLabel.textContent = "请选择声源";
            }
        }

        // 更新会话标题
        const now = new Date();
        dom.sessionTitle.textContent = `${now.getFullYear()}年${String(now.getMonth()+1).padStart(2,'0')}月${String(now.getDate()).padStart(2,'0')}日_记录`;

        state.setIsRunning(true);
        state.setIsPaused(false);
        dom.startBtn.disabled = false;
        dom.startBtn.innerHTML = '<i class="ri-stop-circle-line"></i> 停止同传';
        dom.startBtn.style.background = "#ff4d4f";
        setStatus("翻译中...", "active");

        // 重置AI音频
        audioChunks = [];
        state.setAudioBlobs([]);
        state.setCurrentAudioIndex(0);
        if (dom.aiAudioPlayBtn) dom.aiAudioPlayBtn.style.display = "none";  // 新增
        dom.fcAudioPlayBtn.style.display = "none";
        dom.fcAudioPlayBtn.innerHTML = '<i class="ri-volume-up-line"></i>';

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
    const newPaused = !state.isPaused;

    if (newPaused) {
        // 暂停时：有音频才显示播放按钮
        if (state.audioBlobs.length > 0) {
            dom.aiAudioPlayBtn.style.display = "flex";
        }
    } else {
        // 恢复时：强制隐藏
        dom.aiAudioPlayBtn.style.display = "none";
        
        // 如果正在播放，顺便停掉并重置图标
        if (state.isPlayingAudio) {
            if (state.audioSource) {
                try { state.audioSource.stop(); } catch (e) {}
                state.setAudioSource(null);
            }
            if (state.audioCtx && state.audioCtx.state !== "closed") {
                try { state.audioCtx.close(); } catch (e) {}
                state.setAudioCtx(null);
            }
            state.setIsPlayingAudio(false);
            state.setCurrentAudioIndex(0);
            
            // 重置按钮图标
            if (dom.aiAudioPlayBtn) {
                dom.aiAudioPlayBtn.classList.remove("playing");
                dom.aiAudioPlayBtn.innerHTML = '<i class="ri-play-fill" style="color: #000; font-size: 16px;"></i>';
                dom.aiAudioPlayBtn.title = "播放AI音频";
            }
            dom.fcAudioPlayBtn.innerHTML = '<i class="ri-volume-up-line"></i>';
            dom.fcAudioPlayBtn.classList.remove("playing");
        }
    }

    if (newPaused) {
        // 发送暂停信号给后端
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: "pause" }));
        }
        state.setPausedTime(Date.now());
        dom.fcPauseBtn.classList.add("paused");
        dom.fcPauseBtn.innerHTML = '<i class="ri-play-fill"></i>';
        setStatus("已暂停", "paused");
        console.log("[前端] 发送暂停信号");
    } else {
        // 发送恢复信号给后端
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: "resume" }));
        }
        state.setTotalPaused(state.totalPaused + Date.now() - state.pausedTime);
        dom.fcPauseBtn.classList.remove("paused");
        dom.fcPauseBtn.innerHTML = '<i class="ri-pause-fill"></i>';
        setStatus("翻译中...", "active");
        console.log("[前端] 发送恢复信号");
        // 恢复采集时停止AI音频播放并隐藏播放按钮
        if (state.isPlayingAudio) {
            if (state.audioSource) {
                try { state.audioSource.stop(); } catch (e) {}
                state.setAudioSource(null);
            }
            if (state.audioCtx && state.audioCtx.state !== "closed") {
                try { state.audioCtx.close(); } catch (e) {}
                state.setAudioCtx(null);
            }
            state.setIsPlayingAudio(false);
            state.setCurrentAudioIndex(0);
            dom.fcAudioPlayBtn.innerHTML = '<i class="ri-volume-up-line"></i>';
            dom.fcAudioPlayBtn.classList.remove("playing");
        }
        dom.fcAudioPlayBtn.style.display = "none";
    }
    state.setIsPaused(newPaused);
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

    // 停止AI音频播放
    if (state.isPlayingAudio) {
        if (state.audioSource) {
            try { state.audioSource.stop(); } catch (e) {}
            state.setAudioSource(null);
        }
        if (state.audioCtx && state.audioCtx.state !== "closed") {
            try { state.audioCtx.close(); } catch (e) {}
            state.setAudioCtx(null);
        }
        state.setIsPlayingAudio(false);
        state.setCurrentAudioIndex(0);
    }
    if (dom.aiAudioPlayBtn) dom.aiAudioPlayBtn.style.display = "flex";

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

    // 同传结束后恢复语言选择、交换按钮、热词和AI语音
    lang.setLangDropdownDisabled(false);
    dom.langSwapBtn.disabled = false;
    dom.hotwordBtn.disabled = false;
    dom.aiVoiceBtn.disabled = false;
}

/**
 * 动态切换音频输入源（采集过程中使用）
 */
export async function switchAudioSource() {
    if (!state.isRunning || !state.audioContext) return;

    try {
        console.log("[前端] 切换音频源...");

        // 1. 断开旧的音频连接
        if (state.scriptProcessor) {
            state.scriptProcessor.disconnect();
        }

        // 2. 停止旧的音频流
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

        // 3. 获取新的音频流
        const newStream = await getAudioStreamBySelection();
        if (!newStream) {
            throw new Error("无法获取新的音频流");
        }

        state.setMicrophoneStream(newStream);
        console.log("[前端] 新音频流已获取");

        // 4. 重新连接到 AudioContext
        const source = state.audioContext.createMediaStreamSource(state.microphoneStream);
        source.connect(state.scriptProcessor);
        state.scriptProcessor.connect(state.audioContext.destination);

        console.log("[前端] 音频源切换完成");
    } catch (err) {
        console.error("[前端] 切换音频源失败:", err);
        setStatus("切换声源失败: " + err.message, "error");
    }
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

        case "audio_delta":
            // 收集音频数据
            if (msg.audio) {
                audioChunks.push(msg.audio);
            }
            break;

        case "audio_done":
            // 一段音频完成，合并为PCM Int16Array数据
            if (audioChunks.length > 0) {
                const binary = atob(audioChunks.join(""));
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                // 直接存储Int16Array，采样率24000Hz（千问输出音频格式）
                const pcmData = new Int16Array(bytes.buffer);
                state.audioBlobs.push({ pcm: pcmData, sampleRate: 24000 });
                audioChunks = [];
                if (state.isPaused && state.audioBlobs.length > 0) {
                    if (dom.aiAudioPlayBtn) dom.aiAudioPlayBtn.style.display = "flex";
                }
            }
            break;

        case "session_finished":
            console.log("[前端] 千问会话段结束（暂停触发）");
            // 暂停时收到 session.finished，显示AI音频播放按钮
            if (state.isPaused && state.audioBlobs.length > 0) {
                if (dom.aiAudioPlayBtn) dom.aiAudioPlayBtn.style.display = "flex";
            }
            break;

        case "paused":
            console.log("[前端] 后端确认已暂停");
            break;

        case "resumed":
            console.log("[前端] 后端确认已恢复");
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
