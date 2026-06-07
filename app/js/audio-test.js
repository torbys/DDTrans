/**
 * 音频测试面板模块
 */

import * as dom from './dom.js';
import * as state from './state.js';
import { BUFFER_SIZE } from './config.js';
import { updateVolumeBars } from './utils.js';

export function toggleAudioTestPanel() {
    const isOpen = dom.audioTestPanel.classList.toggle("show");
    if (!isOpen) {
        stopAudioTest();
    }
}

export async function startAudioTest() {
    try {
        dom.audioTestStatus.textContent = "正在获取麦克风权限...";
        dom.audioTestStartBtn.disabled = true;
        dom.audioTestStopBtn.disabled = false;

        state.setTestMicrophoneStream(await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
        }));

        state.setTestAudioCtx(new (window.AudioContext || window.webkitAudioContext)());
        const sampleRate = state.testAudioCtx.sampleRate;
        console.log(`[音频测试] AudioContext 采样率: ${sampleRate}Hz`);

        state.setTestAnalyser(state.testAudioCtx.createAnalyser());
        state.testAnalyser.fftSize = 256;
        state.testAnalyser.smoothingTimeConstant = 0.3;

        state.setTestScriptProcessor(state.testAudioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1));
        const source = state.testAudioCtx.createMediaStreamSource(state.testMicrophoneStream);
        source.connect(state.testAnalyser);
        source.connect(state.testScriptProcessor);
        state.testScriptProcessor.connect(state.testAudioCtx.destination);

        const freqData = new Uint8Array(state.testAnalyser.frequencyBinCount);
        let silenceCount = 0;

        function detectVolume() {
            state.testAnalyser.getByteFrequencyData(freqData);
            let sum = 0;
            for (let i = 0; i < freqData.length; i++) sum += freqData[i];
            const avg = sum / freqData.length / 255;

            updateVolumeBars(avg, dom.volumeBars);

            if (avg > 0.5) {
                dom.audioTestStatus.textContent = `检测到较强声音 (${Math.round(avg * 100)}%) - 麦克风工作正常`;
                silenceCount = 0;
            } else if (avg > 0.05) {
                dom.audioTestStatus.textContent = `检测到声音 (${Math.round(avg * 100)}%) - 请继续说话`;
                silenceCount = 0;
            } else {
                silenceCount++;
                if (silenceCount > 30) {
                    dom.audioTestStatus.textContent = "未检测到声音 - 请检查麦克风是否静音";
                } else {
                    dom.audioTestStatus.textContent = "正在监听... 请说话或播放音频";
                }
            }

            state.setTestAnimationId(requestAnimationFrame(detectVolume));
        }

        detectVolume();
        dom.audioTestStatus.textContent = "麦克风已开启 - 请说话或播放音频";

    } catch (err) {
        dom.audioTestStatus.textContent = "测试失败: " + err.message;
        dom.audioTestStartBtn.disabled = false;
        dom.audioTestStopBtn.disabled = true;
        console.error("[音频测试] 失败:", err);
    }
}

export function stopAudioTest() {
    if (state.testAnimationId) {
        cancelAnimationFrame(state.testAnimationId);
        state.setTestAnimationId(null);
    }
    if (state.testScriptProcessor) {
        state.testScriptProcessor.disconnect();
        state.setTestScriptProcessor(null);
    }
    if (state.testMicrophoneStream) {
        state.testMicrophoneStream.getTracks().forEach((t) => t.stop());
        state.setTestMicrophoneStream(null);
    }
    if (state.testAudioCtx && state.testAudioCtx.state !== "closed") {
        state.testAudioCtx.close();
        state.setTestAudioCtx(null);
    }
    state.setTestAnalyser(null);

    dom.audioTestStatus.textContent = "点击开始测试麦克风";
    dom.audioTestStartBtn.disabled = false;
    dom.audioTestStopBtn.disabled = true;
    updateVolumeBars(0, dom.volumeBars);
}
