/**
 * 语言选择模块
 */

import * as dom from './dom.js';
import * as state from './state.js';
import { LANG_DATA } from './config.js';

export function initLangDropdown(type, dropdown, trigger, menu, nameEl, nativeEl) {
    // 渲染菜单项
    menu.innerHTML = "";
    LANG_DATA.forEach((lang) => {
        const item = document.createElement("div");
        item.className = "custom-select-item";
        item.dataset.code = lang.code;
        item.innerHTML = `
            <span class="item-name">${lang.name}</span>
            <span class="item-native">${lang.native}</span>
            <span class="item-check"><i class="ri-check-line"></i></span>
        `;
        item.addEventListener("click", () => {
            selectLang(type, lang.code);
            closeAllLangDropdowns();
        });
        menu.appendChild(item);
    });

    // 点击 trigger 打开/关闭
    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        if (trigger.classList.contains("disabled")) return;
        const isOpen = menu.classList.contains("show");
        closeAllLangDropdowns();
        if (!isOpen) {
            menu.classList.add("show");
            dropdown.classList.add("open");
            highlightActiveItem(menu, type === "source" ? state.currentSourceLang : state.currentTargetLang);
        }
    });
}

function highlightActiveItem(menu, code) {
    menu.querySelectorAll(".custom-select-item").forEach((item) => {
        item.classList.toggle("active", item.dataset.code === code);
    });
}

export function closeAllLangDropdowns() {
    dom.sourceLangMenu.classList.remove("show");
    dom.sourceLangDropdown.classList.remove("open");
    dom.targetLangMenu.classList.remove("show");
    dom.targetLangDropdown.classList.remove("open");
}

export function selectLang(type, code) {
    if (type === "source") {
        state.setCurrentSourceLang(code);
    } else {
        state.setCurrentTargetLang(code);
    }
    validateLangSelection();
    updateLangDisplay();
}

export function setLangDropdownDisabled(disabled) {
    dom.sourceLangTrigger.classList.toggle("disabled", disabled);
    dom.targetLangTrigger.classList.toggle("disabled", disabled);
}

function validateLangSelection() {
    if (state.currentSourceLang === state.currentTargetLang) {
        const other = LANG_DATA.find((l) => l.code !== state.currentSourceLang);
        if (other) {
            state.setCurrentTargetLang(other.code);
        }
    }
}

export function swapLanguages() {
    const temp = state.currentSourceLang;
    state.setCurrentSourceLang(state.currentTargetLang);
    state.setCurrentTargetLang(temp);
    updateLangDisplay();
}

export function updateLangDisplay() {
    const sourceLang = LANG_DATA.find((l) => l.code === state.currentSourceLang);
    const targetLang = LANG_DATA.find((l) => l.code === state.currentTargetLang);

    if (sourceLang) {
        dom.sourceLangName.textContent = sourceLang.name;
        dom.sourceLangNative.textContent = sourceLang.native;
    }
    if (targetLang) {
        dom.targetLangName.textContent = targetLang.name;
        dom.targetLangNative.textContent = targetLang.native;
    }
}
