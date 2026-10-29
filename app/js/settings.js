import { LANG_DATA } from './config.js';
import { normalizeAudioRouting } from './audio-routing-config.js';

const api = window.electronAPI;
const byId = id => document.getElementById(id);
const ranges = ['originalGain', 'translatedGain', 'ttsVolume', 'monitorVolume'];
const checks = ['ttsEnabled', 'monitorEnabled', 'virtualOutputEnabled'];
const selects = { monitorDevice: 'monitorDeviceId', virtualRenderDevice: 'virtualRenderDeviceId', virtualCaptureDevice: 'virtualCaptureDeviceId' };
let settings = normalizeAudioRouting(api?.audioSettings), snapshot = {}, devices = { inputs: [], outputs: [], virtualInputs: [], virtualOutputs: [] };
let pending = {}, sending = {}, saving, saveTimer, devicesLoaded = false, failedSave = false;
const values = () => ({ ...settings, ...sending, ...pending });
const percent = value => `${Math.round(value * 100)}%`;
const busy = () => ['starting', 'pausing', 'stopping'].includes(snapshot.phase);

function status(id, message, error = false) { const node = byId(id); node.textContent = message; node.dataset.error = String(error); }
function saveStatus(message, error = false) { failedSave = error; status('saveStatus', message, error); }
function applySnapshot(next) {
    snapshot = { ...snapshot, ...next };
    if (next.audioRouting) settings = normalizeAudioRouting(next.audioRouting);
    renderControls(); renderStatus();
}
function fillSelect(id, options, selected, label) {
    const node = byId(id), isMonitor = id === 'monitorDevice';
    const placeholder = new Option(isMonitor ? '系统默认播放设备' : '请选择设备', isMonitor ? 'default' : '');
    const choices = [placeholder, ...options.filter(device => device.deviceId !== 'default').map(device => new Option((device.label || '未命名设备') + (device.likelyVirtual ? ' · 虚拟设备候选' : ''), device.deviceId))];
    if (selected && !choices.some(item => item.value === selected)) choices.push(new Option((label || '上次选择的设备') + '（已断开）', selected));
    node.replaceChildren(...choices); node.value = selected;
}
function renderDevices() {
    const value = values();
    fillSelect('monitorDevice', devices.outputs, value.monitorDeviceId, value.monitorDeviceLabel);
    fillSelect('virtualRenderDevice', devices.outputs, value.virtualRenderDeviceId, value.virtualRenderDeviceLabel);
    fillSelect('virtualCaptureDevice', devices.inputs, value.virtualCaptureDeviceId, value.virtualCaptureDeviceLabel);
    renderStatus();
}
function renderControls() {
    const value = values();
    for (const key of ranges) {
        if (document.activeElement !== byId(key)) byId(key).value = String(Math.round(value[key] * 100));
        byId(key + 'Value').textContent = percent(value[key]);
        byId(key).setAttribute('aria-valuetext', value[key] === 0 ? '静音' : percent(value[key]));
    }
    for (const key of checks) byId(key).checked = value[key];
    for (const [id, key] of Object.entries(selects)) if (document.activeElement !== byId(id)) byId(id).value = value[key];
    byId('monitorMode').value = value.monitorMode;
    byId('mixOriginalPreview').textContent = percent(value.originalGain);
    byId('mixTranslatedPreview').textContent = percent(value.ttsEnabled ? value.translatedGain * value.ttsVolume : 0);
    byId('targetLanguage').value = snapshot.config?.targetLanguage || 'zh';
    byId('targetLanguage').disabled = busy();
    byId('monitorVolume').disabled = !value.monitorEnabled;
    byId('monitorMode').disabled = !value.monitorEnabled;
}
function virtualStatus() {
    const value = values(), runtime = snapshot.audioRouting || {};
    const render = devices.outputs.find(device => device.deviceId === value.virtualRenderDeviceId);
    const input = devices.inputs.find(device => device.deviceId === value.virtualCaptureDeviceId);
    if (!devicesLoaded) return ['idle', '正在读取', '正在读取音频设备', '稍后可以选择输出和配对的麦克风。'];
    if (value.virtualRenderDeviceId && !render) return ['error', '设备已断开', '上次选择的输出设备不可用', '重新连接设备，或在下方选择新的输出。'];
    if (runtime.virtualError) return ['error', '输出不可用', '暂时无法打开输出设备', runtime.virtualError];
    if (!devices.virtualOutputs.length && !render) return ['warning', '未检测到虚拟设备', '未找到可识别的虚拟音频设备', '安装并启用虚拟音频线缆后，点击“刷新设备”。已有其他品牌设备也可以手动选择并检测连接。'];
    if (!render) return ['warning', '请选择输出', '先选择声音发送到哪里', '虚拟线缆通常使用 Input 作为播放端；下方“外部软件选择”通常是对应的 Output。'];
    if (!render.likelyVirtual) return ['warning', '普通输出试播', '已选播放设备：' + (render.label || '未命名设备'), '目前只确认了播放设备。这不会创建新的系统麦克风；可以先试播，再选择虚拟设备。'];
    if (value.virtualCaptureDeviceId && !input) return ['warning', '输入已断开', '配对的虚拟麦克风不可用', '请重新选择外部软件需要使用的输入设备。'];
    if (!value.virtualOutputEnabled) return ['idle', '未启用', '设备已选好，发送开关尚未开启', '开启“虚拟输出”后，同传声音会按下方音量发送。'];
    if (runtime.status === 'blocked') return ['error', '输出已暂停', '需要检查采集设置', runtime.error];
    if (runtime.lastTest?.captureVerified) return ['ready', '连接检测通过', '配对输入已收到测试音', `在会议或游戏中选择“${input?.label || '配对麦克风'}”。${runtime.virtualOutputReady ? '当前正在发送同传声音。' : '开始同传后会发送声音。'}`];
    return runtime.virtualOutputReady
        ? ['outputting', '正在发送', '声音正在发送到：' + render.label, '播放端已打开。点击“检测虚拟麦克风连接”可以确认外部软件使用的输入是否收到声音。']
        : ['warning', '等待同传', '输出已启用，开始同传后发送', '原声和译音会使用下方设置；连接检测可以在同传前进行。'];
}
function renderStatus() {
    const [state, label, title, detail] = virtualStatus();
    byId('virtualStatus').textContent = label; byId('virtualStatus').dataset.state = state;
    byId('virtualStatusPanel').dataset.state = state;
    byId('virtualStatusTitle').textContent = title; byId('virtualStatusDetail').textContent = detail;
    const runtime = snapshot.audioRouting || {}, value = values();
    const labels = { idle: '待命', waiting: '等待同传', 'needs-device': '等待选择设备', monitoring: '监听中', outputting: '正在发送', error: '输出不可用', blocked: '输出已暂停' };
    byId('diagnosticStatus').textContent = labels[runtime.status] || '待命';
    byId('diagnosticSampleRate').textContent = `${(runtime.sampleRate || 48000) / 1000} kHz · 单声道`;
    byId('diagnosticLatency').textContent = runtime.estimatedLatencyMs == null ? '—' : `${runtime.estimatedLatencyMs} ms`;
    byId('diagnosticBuffer').textContent = `${Math.round(runtime.bufferedMs || 0)} ms`;
    byId('diagnosticClipping').textContent = String(runtime.levels?.clippedSamples || 0);
    byId('diagnosticVirtual').textContent = runtime.virtualOutputReady ? '已打开' : value.virtualOutputEnabled ? '等待输出' : '未启用';
    byId('mixLevel').value = runtime.levels?.mix || 0;
    byId('ttsSessionNote').textContent = snapshot.config?.audioEnabled === false && ['running', 'paused'].includes(snapshot.phase) ? '当前会话只请求了文字。开启播报的设置已保存，将在下次开始同传时生效。' : '译音总音量同时作用于监听和发送；关闭播报不会停止翻译或字幕保存。';
    byId('diagnosticError').hidden = !runtime.error;
    byId('diagnosticError').textContent = runtime.error || '';
    if (runtime.monitorError) status('monitorStatus', runtime.monitorError, true);
    else if (runtime.error && runtime.status === 'blocked') status('monitorStatus', runtime.error, true);
    else status('monitorStatus', !value.monitorEnabled ? '监听已关闭，虚拟输出仍可继续。' : runtime.monitorOutputReady ? '监听设备已打开。' : '开始同传或点击“试播监听”来检查设备。');
}
function change(patch, immediate = false) {
    Object.assign(pending, patch); renderControls(); renderStatus();
    saveStatus('正在应用…'); clearTimeout(saveTimer);
    if (immediate) void flush().catch(() => {});
    else saveTimer = setTimeout(() => void flush().catch(() => {}), 100);
}
async function flush() {
    clearTimeout(saveTimer);
    if (saving) return saving;
    saving = (async () => {
        while (Object.keys(pending).length) {
            sending = pending; pending = {};
            try {
                const result = await api.mediaCommand('set-audio-routing', sending);
                settings = normalizeAudioRouting(result.audioRouting); snapshot = { ...snapshot, ...result };
                sending = {}; renderControls(); renderStatus();
            } catch (error) {
                pending = { ...sending, ...pending }; sending = {};
                saveStatus('未保存：' + error.message + '。点击此处重试。', true);
                throw error;
            }
        }
        saveStatus('已应用并保存');
    })().finally(() => { saving = null; });
    return saving;
}
async function refreshDevices() {
    try { devices = await api.mediaCommand('enumerate-devices'); devicesLoaded = true; renderDevices(); }
    catch (error) { status('routeTestStatus', '无法读取设备：' + error.message, true); }
}
async function testOutput(target, verifyCapture = false) {
    const button = byId(target === 'monitor' ? 'testRouteBtn' : verifyCapture ? 'verifyVirtualBtn' : 'testVirtualBtn');
    const id = target === 'monitor' ? 'monitorStatus' : 'routeTestStatus';
    button.disabled = true; status(id, verifyCapture ? '正在检测配对输入，约需一秒…' : '正在播放短测试音…');
    try {
        await flush();
        const result = await api.mediaCommand('audio-routing-test', { target, verifyCapture });
        status(id, result.captureVerified ? '检测通过：配对的虚拟麦克风已收到测试音。' : '输出端已打开并播放测试音；请确认所选设备能听到。');
    } catch (error) { status(id, error.message, true); }
    finally { button.disabled = false; }
}
async function initialize() {
    for (const language of LANG_DATA) byId('targetLanguage').add(new Option(language.name + ' · ' + language.native, language.code));
    if (!api) { status('saveStatus', '请在 DDTrans 桌面应用中打开音频设置。', true); document.querySelectorAll('input, select, button').forEach(node => { node.disabled = true; }); return; }
    for (const key of ranges) {
        byId(key).addEventListener('input', event => change({ [key]: Number(event.target.value) / 100 }));
        byId(key).addEventListener('change', () => void flush().catch(() => {}));
    }
    for (const key of checks) byId(key).addEventListener('change', event => change({ [key]: event.target.checked }, true));
    for (const [id, key] of Object.entries(selects)) byId(id).addEventListener('change', event => {
        const list = id === 'virtualCaptureDevice' ? devices.inputs : devices.outputs;
        const labelKey = key.replace('Id', 'Label');
        const label = list.find(device => device.deviceId === event.target.value)?.label || '';
        change({ [key]: event.target.value, [labelKey]: label }, true);
    });
    byId('monitorMode').addEventListener('change', event => change({ monitorMode: event.target.value }, true));
    byId('targetLanguage').addEventListener('change', async event => {
        const value = event.target.value; event.target.disabled = true;
        try { await flush(); applySnapshot(await api.mediaCommand('set-target', { targetLanguage: value })); }
        catch (error) { status('routeTestStatus', error.message, true); }
        finally { byId('targetLanguage').disabled = busy(); }
    });
    byId('refreshDevicesBtn').addEventListener('click', () => void refreshDevices());
    byId('permissionBtn').addEventListener('click', async () => {
        try { const result = await api.mediaCommand('request-audio-permission'); status('routeTestStatus', result.message, !result.granted); if (!result.granted) byId('permissionSettingsBtn').hidden = false; await refreshDevices(); }
        catch (error) { status('routeTestStatus', error.message, true); }
    });
    byId('testRouteBtn').addEventListener('click', () => void testOutput('monitor'));
    byId('testVirtualBtn').addEventListener('click', () => void testOutput('virtual'));
    byId('verifyVirtualBtn').addEventListener('click', () => void testOutput('virtual', true));
    byId('openSystemAudioBtn').addEventListener('click', () => void api.openSystemAudioSettings());
    byId('permissionSettingsBtn').addEventListener('click', () => void api.openPermissionSettings());
    byId('minimizeBtn').addEventListener('click', () => void api.minimizeWindow());
    byId('closeBtn').addEventListener('click', async () => { try { await flush(); await api.closeWindow(); } catch (_) {} });
    byId('saveStatus').addEventListener('click', () => { if (failedSave) void flush().catch(() => {}); });
    const unsubscribe = api.onMediaEvent(event => {
        if (event.type === 'snapshot') applySnapshot(event.snapshot);
        if (event.type === 'audio-routing') applySnapshot({ audioRouting: event.audioRouting });
        if (event.type === 'audio-devices') { devices = event.devices; devicesLoaded = true; renderDevices(); }
    });
    window.addEventListener('pagehide', () => { unsubscribe(); if (Object.keys(pending).length) void flush().catch(() => {}); }, { once: true });
    try { settings = await api.getAudioSettings(); applySnapshot(await api.getMediaSnapshot()); await refreshDevices(); renderDevices(); }
    catch (error) { saveStatus(error.message, true); }
}
void initialize();
