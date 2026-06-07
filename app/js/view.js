/**
 * 视图模式与字号控制
 */

import * as dom from './dom.js';
import * as state from './state.js';
import { MIN_FONT_SIZE, MAX_FONT_SIZE } from './config.js';

export function setViewMode(mode) {
    state.setCurrentViewMode(mode);

    // 更新下拉菜单显示
    dom.viewModeLabel.textContent = mode === "bilingual" ? "双语" : mode === "source" ? "原文" : "译文";
    dom.viewModeMenu.querySelectorAll(".dropdown-item").forEach((item) => {
        item.classList.toggle("active", item.dataset.mode === mode);
    });

    if (state.isRunning) {
        applyViewMode();
    }
}

export function applyViewMode() {
    dom.sourceArea.classList.remove("show");
    dom.targetArea.classList.remove("show");
    dom.bilingualContent.classList.remove("single-view");

    switch (state.currentViewMode) {
        case "bilingual":
            dom.sourceArea.classList.add("show");
            dom.targetArea.classList.add("show");
            break;
        case "source":
            dom.sourceArea.classList.add("show");
            dom.bilingualContent.classList.add("single-view");
            break;
        case "target":
            dom.targetArea.classList.add("show");
            dom.bilingualContent.classList.add("single-view");
            break;
    }
}

export function increaseFontSize() {
    if (state.currentFontSize < MAX_FONT_SIZE) {
        state.setCurrentFontSize(state.currentFontSize + 1);
        updateFontSize();
    }
}

export function decreaseFontSize() {
    if (state.currentFontSize > MIN_FONT_SIZE) {
        state.setCurrentFontSize(state.currentFontSize - 1);
        updateFontSize();
    }
}

export function updateFontSize() {
    dom.sourceText.style.fontSize = `${state.currentFontSize}px`;
    dom.targetText.style.fontSize = `${state.currentFontSize}px`;
}

export function setLayout(layout) {
    state.setCurrentLayout(layout);

    // 更新下拉菜单显示
    dom.layoutLabel.textContent = layout === "horizontal" ? "上下分区" : "左右分区";
    dom.layoutMenu.querySelectorAll(".dropdown-item").forEach((item) => {
        item.classList.toggle("active", item.dataset.layout === layout);
    });

    // 应用布局
    applyLayout();
}

export function applyLayout() {
    const content = dom.bilingualContent;
    content.classList.remove("layout-horizontal", "layout-vertical");

    if (state.currentLayout === "vertical") {
        content.classList.add("layout-vertical");
    } else {
        content.classList.add("layout-horizontal");
    }
}
