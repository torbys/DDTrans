/**
 * 实时字幕渲染。原文和译文使用同一 segment_key 建立稳定关联。
 */

import * as dom from "./dom.js";

const segmentViews = new Map();
let arrivalOrder = 0;
let sourceSessionState = null;
let targetSessionState = null;
const SEGMENT_FIELDS = [
    "id",
    "segment_key",
    "sequence_order",
    "speaker_id",
    "source_text",
    "target_text",
    "start_ms",
    "end_ms",
    "status",
];

function toText(value) {
    return value == null ? "" : String(value);
}

function mergeSegment(previous, incoming) {
    const merged = { ...previous };
    SEGMENT_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(incoming, field)) {
            merged[field] = incoming[field];
        }
    });
    return merged;
}

function getSegmentKey(segment) {
    if (segment.segment_key != null && segment.segment_key !== "") return String(segment.segment_key);
    if (segment.id != null && segment.id !== "") return `id:${segment.id}`;
    return `sequence:${segment.sequence_order ?? arrivalOrder}`;
}

function getSequenceOrder(segment, fallback) {
    const value = Number(segment.sequence_order);
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER + fallback;
}

function formatTime(milliseconds) {
    if (milliseconds === null || milliseconds === undefined || milliseconds === "") return "";
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) return "";
    const totalSeconds = Math.floor(value / 1000);
    return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function getTimeLabel(segment) {
    const start = formatTime(segment.start_ms);
    const end = formatTime(segment.end_ms);
    if (start && end) return `${start} - ${end}`;
    return start || end || "实时";
}

function getSpeakerLabel(speakerId) {
    if (speakerId === null || speakerId === undefined || speakerId === "") return "说话人";
    return `说话人 ${String(speakerId)}`;
}

function createSegmentView(panel) {
    const wrapper = document.createElement("article");
    wrapper.className = "transcript-segment";
    const meta = document.createElement("div");
    meta.className = "segment-meta";
    const speaker = document.createElement("span");
    speaker.className = "segment-speaker";
    const time = document.createElement("span");
    time.className = "segment-time";
    const text = document.createElement("div");
    text.className = "segment-text";
    meta.append(speaker, time);
    wrapper.append(meta, text);
    panel.appendChild(wrapper);
    return { wrapper, speaker, time, text };
}

function insertInOrder(panel, view, sequence, order) {
    view.wrapper.dataset.sequenceOrder = String(sequence);
    view.wrapper.dataset.arrivalOrder = String(order);
    const next = Array.from(panel.children).find((candidate) => {
        if (candidate === view.wrapper || candidate.classList.contains("session-state")) return false;
        const candidateSequence = Number(candidate.dataset.sequenceOrder);
        const candidateOrder = Number(candidate.dataset.arrivalOrder);
        return candidateSequence > sequence
            || (candidateSequence === sequence && candidateOrder > order);
    });
    if (next) panel.insertBefore(view.wrapper, next);
    else panel.appendChild(view.wrapper);
}

function ensureSessionState(panel, current) {
    if (current) return current;
    const state = document.createElement("div");
    state.className = "session-state";
    state.setAttribute("role", "status");
    state.setAttribute("aria-live", "polite");
    panel.prepend(state);
    return state;
}

function updateSessionStateView(view, status, label) {
    view.hidden = !label;
    view.dataset.status = status;
    view.textContent = label;
}

function getPlaceholder(column, status) {
    if (status === "interrupted") return column === "source" ? "识别已中断" : "翻译已中断";
    if (status === "final") return column === "source" ? "暂无原文" : "暂无译文";
    return column === "source" ? "正在识别..." : "等待译文...";
}

function updateView(view, column, segment) {
    const status = ["pending", "final", "interrupted"].includes(segment.status) ? segment.status : "pending";
    const value = toText(column === "source" ? segment.source_text : segment.target_text);
    const hasText = value.trim().length > 0;
    view.wrapper.dataset.status = status;
    view.speaker.textContent = getSpeakerLabel(segment.speaker_id);
    view.time.textContent = getTimeLabel(segment);
    view.text.textContent = hasText ? value : getPlaceholder(column, status);
    view.text.classList.toggle("segment-placeholder", !hasText);
}

function scrollToLatest(area) {
    area.scrollTop = area.scrollHeight;
}

/** 用一次规范化事件更新两栏同一个段落。原文和译文可任意顺序到达。 */
export function upsertSegment(segment) {
    if (!segment || typeof segment !== "object") return;
    const key = getSegmentKey(segment);
    let record = segmentViews.get(key);
    if (!record) {
        const order = arrivalOrder++;
        const data = mergeSegment({}, segment);
        record = {
            order,
            data,
            sequence: getSequenceOrder(data, order),
            source: createSegmentView(dom.sourceText),
            target: createSegmentView(dom.targetText),
        };
        segmentViews.set(key, record);
    } else {
        record.data = mergeSegment(record.data, segment);
        record.sequence = getSequenceOrder(record.data, record.order);
    }
    updateView(record.source, "source", record.data);
    updateView(record.target, "target", record.data);
    insertInOrder(dom.sourceText, record.source, record.sequence, record.order);
    insertInOrder(dom.targetText, record.target, record.sequence, record.order);
    scrollToLatest(dom.sourceArea);
    scrollToLatest(dom.targetArea);
}

/** 标记当前会话状态，供样式和辅助技术读取。 */
export function setSessionState(status) {
    const value = toText(status || "idle");
    const labels = {
        pending: "准备中",
        running: "进行中",
        interrupted: "已中断",
        failed: "保存失败",
        completed: "已完成",
    };
    const label = labels[value] || "";
    dom.sourceText.dataset.sessionState = value;
    dom.targetText.dataset.sessionState = value;
    const isBusy = value === "pending" || value === "running" || value === "connecting";
    dom.sourceText.setAttribute("aria-busy", String(isBusy));
    dom.targetText.setAttribute("aria-busy", String(isBusy));
    sourceSessionState = ensureSessionState(dom.sourceText, sourceSessionState);
    targetSessionState = ensureSessionState(dom.targetText, targetSessionState);
    updateSessionStateView(sourceSessionState, value, label);
    updateSessionStateView(targetSessionState, value, label);
}

export function clearText() {
    dom.sourceText.replaceChildren();
    dom.targetText.replaceChildren();
    segmentViews.clear();
    arrivalOrder = 0;
    sourceSessionState = null;
    targetSessionState = null;
    setSessionState("idle");
}
