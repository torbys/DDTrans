/**
 * 音频采集模块（系统音频 + 麦克风）
 */

import * as state from './state.js';
import { TARGET_SAMPLE_RATE, BUFFER_SIZE } from './config.js';

/**
 * 仅获取系统音频（Electron desktopCapturer）
 */
export async function getSystemAudioStreamOnly() {
    if (typeof window.electronAPI === 'undefined') {
        console.warn('[前端] 非 Electron 环境，无法采集系统音频，回退到麦克风');
        return getMicAudioStream();
    }

    try {
        const result = await window.electronAPI.getSystemAudioStream();
        if (!result.success) {
            throw new Error(result.error || '获取系统音频失败');
        }

        console.log('[前端] 获取到系统音频源:', result.sourceName);

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: result.sourceId
                },
                optional: [
                    { echoCancellation: true },
                    { noiseSuppression: true },
                    { autoGainControl: true }
                ]
            },
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: result.sourceId,
                    minWidth: 1,
                    maxWidth: 1,
                    minHeight: 1,
                    maxHeight: 1
                }
            }
        });

        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            throw new Error('未获取到音频轨道');
        }

        state.setSystemAudioStream(new MediaStream(audioTracks));
        console.log('[前端] 系统音频流已创建，轨道数:', audioTracks.length);
        return state.systemAudioStream;
    } catch (err) {
        console.error('[前端] 获取系统音频失败:', err);
        return getMicAudioStream();
    }
}

/**
 * 仅获取麦克风音频
 */
export async function getMicAudioStream() {
    const audioConstraints = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
    };
    if (state.selectedMicDeviceId && state.selectedMicDeviceId !== 'default') {
        audioConstraints.deviceId = { exact: state.selectedMicDeviceId };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    console.log('[前端] 麦克风音频流已获取');
    return stream;
}

/**
 * 获取混合音频流（系统音频 + 麦克风）
 * 使用 Web Audio API 真正混音，而不是简单并列音轨
 */
export async function getCombinedAudioStream() {
    const [sysStream, micStream] = await Promise.all([
        getSystemAudioStreamOnly().catch(err => {
            console.warn('[前端] 系统音频获取失败，仅使用麦克风:', err);
            return null;
        }),
        getMicAudioStream().catch(err => {
            console.warn('[前端] 麦克风获取失败:', err);
            return null;
        })
    ]);

    if (!sysStream && !micStream) {
        throw new Error('无法获取任何音频流');
    }

    if (!sysStream) return micStream;
    if (!micStream) return sysStream;

    // 使用 Web Audio API 真正混音
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();

    // 系统音频
    const sysSource = audioCtx.createMediaStreamSource(sysStream);
    const sysGain = audioCtx.createGain();
    sysGain.gain.value = 1.0;
    sysSource.connect(sysGain);
    sysGain.connect(dest);

    // 麦克风音频
    const micSource = audioCtx.createMediaStreamSource(micStream);
    const micGain = audioCtx.createGain();
    micGain.gain.value = 1.0;
    micSource.connect(micGain);
    micGain.connect(dest);

    const mixedStream = dest.stream;
    state.setCombinedStream(mixedStream);
    console.log('[前端] 混合音频流已创建（Web Audio混音），输出轨道数:', mixedStream.getAudioTracks().length);
    return mixedStream;
}

/**
 * 根据用户选择获取对应音频流
 */
export async function getAudioStreamBySelection() {
    if (state.useSystemAudio && state.useMicAudio) {
        return getCombinedAudioStream();
    } else if (state.useSystemAudio) {
        return getSystemAudioStreamOnly();
    } else if (state.useMicAudio) {
        return getMicAudioStream();
    }
    return null;
}
