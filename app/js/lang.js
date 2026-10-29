import * as dom from './dom.js';
import * as state from './state.js';
import { LANG_DATA } from './config.js';

export function initLangDropdown(type, dropdown, trigger, menu) {
    if (type !== 'target') return;
    menu.replaceChildren();
    for (const language of LANG_DATA) {
        const item = document.createElement('button');
        item.type = 'button'; item.className = 'custom-select-item'; item.dataset.code = language.code;
        const name = document.createElement('span'); name.className = 'item-name'; name.textContent = language.name;
        const native = document.createElement('span'); native.className = 'item-native'; native.textContent = language.native;
        item.append(name, native);
        item.addEventListener('click', () => { selectLang('target', language.code); closeAllLangDropdowns(); });
        menu.append(item);
    }
    trigger.addEventListener('click', event => {
        event.stopPropagation(); if (state.isRunning) return;
        const show = !menu.classList.contains('show'); closeAllLangDropdowns();
        menu.classList.toggle('show', show); dropdown.classList.toggle('open', show);
        menu.querySelectorAll('[data-code]').forEach(item => item.classList.toggle('active', item.dataset.code === state.currentTargetLang));
    });
}
export function closeAllLangDropdowns() { dom.targetLangMenu.classList.remove('show'); dom.targetLangDropdown.classList.remove('open'); }
export function selectLang(type, code) {
    if (type !== 'target' || !LANG_DATA.some(language => language.code === code) || state.isRunning) return;
    state.setCurrentTargetLang(code); updateLangDisplay();
    document.dispatchEvent(new Event('target-language-changed'));
}
export function setLangDropdownDisabled(disabled) {
    dom.targetLangTrigger.classList.toggle('disabled', disabled);
    dom.targetLangTrigger.setAttribute('aria-disabled', String(disabled));
    if (disabled) closeAllLangDropdowns();
}
export function updateLangDisplay() {
    dom.sourceLangName.textContent = '自动识别'; dom.sourceLangNative.textContent = 'Auto';
    const language = LANG_DATA.find(item => item.code === state.currentTargetLang);
    if (language) { dom.targetLangName.textContent = language.name; dom.targetLangNative.textContent = language.native; }
}
