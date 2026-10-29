
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
export function buildVolumeBars(container, count, className = 'vol-bar') {
    container.innerHTML = "";
    for (let i = 0; i < count; i++) {
        const bar = document.createElement("div");
        bar.className = className;
        bar.dataset.index = i;
        container.appendChild(bar);
    }
}
