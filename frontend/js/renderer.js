/**
 * 文本渲染模块（双 span 段落管理）
 */

import * as dom from './dom.js';
import * as state from './state.js';

export function ensureSourceSegment() {
    if (!state.currentSourceSegment) {
        const finalSpan = document.createElement("span");
        finalSpan.className = "final";
        dom.sourceText.appendChild(finalSpan);

        const stashSpan = document.createElement("span");
        stashSpan.className = "streaming";
        dom.sourceText.appendChild(stashSpan);

        state.setCurrentSourceSegment({ finalSpan, stashSpan });
    }
}

export function ensureTargetSegment() {
    if (!state.currentTargetSegment) {
        const finalSpan = document.createElement("span");
        finalSpan.className = "final";
        dom.targetText.appendChild(finalSpan);

        const stashSpan = document.createElement("span");
        stashSpan.className = "streaming";
        dom.targetText.appendChild(stashSpan);

        state.setCurrentTargetSegment({ finalSpan, stashSpan });
    }
}

export function updateSourceSegment(confirmed, stash) {
    ensureSourceSegment();
    state.currentSourceSegment.finalSpan.textContent = confirmed;
    state.currentSourceSegment.stashSpan.textContent = stash;
    dom.sourceArea.scrollTop = dom.sourceArea.scrollHeight;
}

export function updateTargetSegment(confirmed, stash) {
    ensureTargetSegment();
    state.currentTargetSegment.finalSpan.textContent = confirmed;
    state.currentTargetSegment.stashSpan.textContent = stash;
    dom.targetArea.scrollTop = dom.targetArea.scrollHeight;
}

export function finalizeSourceSegment(text) {
    if (state.currentSourceSegment) {
        state.currentSourceSegment.finalSpan.textContent = text + " ";
        state.currentSourceSegment.stashSpan.remove();
        state.setCurrentSourceSegment(null);
    } else {
        const span = document.createElement("span");
        span.className = "final";
        span.textContent = text + " ";
        dom.sourceText.appendChild(span);
    }
    state.pushSourceSegment(text);
    dom.sourceArea.scrollTop = dom.sourceArea.scrollHeight;
}

export function finalizeTargetSegment(text) {
    if (state.currentTargetSegment) {
        state.currentTargetSegment.finalSpan.textContent = text + " ";
        state.currentTargetSegment.stashSpan.remove();
        state.setCurrentTargetSegment(null);
    } else {
        const span = document.createElement("span");
        span.className = "final";
        span.textContent = text + " ";
        dom.targetText.appendChild(span);
    }
    state.pushTargetSegment(text);
    dom.targetArea.scrollTop = dom.targetArea.scrollHeight;
}

export function clearText() {
    dom.sourceText.innerHTML = "";
    dom.targetText.innerHTML = "";
    state.setCurrentSourceSegment(null);
    state.setCurrentTargetSegment(null);
    state.clearSourceSegments();
    state.clearTargetSegments();
}
