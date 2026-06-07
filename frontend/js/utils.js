/**
 * 工具函数
 */

/**
 * 设置状态（底部状态栏已移除，打印到控制台）
 */
export function setStatus(text, state) {
    console.log(`[状态] ${text}`);
}

/**
 * 重采样
 */
export function resample(input, fromRate, toRate) {
    if (fromRate === toRate) return new Float32Array(input);
    const ratio = fromRate / toRate;
    const outLen = Math.floor(input.length / ratio);
    const output = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const srcIdx = i * ratio;
        const srcIdxFloor = Math.floor(srcIdx);
        const frac = srcIdx - srcIdxFloor;
        const a = input[srcIdxFloor] || 0;
        const b = input[srcIdxFloor + 1] || 0;
        output[i] = a + (b - a) * frac;
    }
    return output;
}

/**
 * Float32 → Int16 (PCM)
 */
export function float32ToInt16(float32) {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
}

/**
 * 更新音量格子
 */
export function updateVolumeBars(level, container) {
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

/**
 * 生成音量格子
 */
export function buildVolumeBars(container, count, className) {
    container.innerHTML = "";
    for (let i = 0; i < count; i++) {
        const bar = document.createElement("div");
        bar.className = className;
        bar.dataset.index = i;
        container.appendChild(bar);
    }
}
