import * as dom from './dom.js';
import * as state from './state.js';
import { LANG_DATA } from './config.js';

export function initLanguageSelect() {
    for (const language of LANG_DATA) {
        dom.targetLanguageSelect.add(new Option(language.name + ' · ' + language.native, language.code));
    }
    updateLangDisplay();
    dom.targetLanguageSelect.addEventListener('change', () => {
        if (state.isRunning) return;
        state.setCurrentTargetLang(dom.targetLanguageSelect.value);
        document.dispatchEvent(new Event('target-language-changed'));
    });
}
export function setLangDropdownDisabled(disabled) {
    dom.targetLanguageSelect.disabled = disabled;
}
export function updateLangDisplay() {
    dom.targetLanguageSelect.value = state.currentTargetLang;
}
