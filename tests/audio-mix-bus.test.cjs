const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function mixer() {
    let Constructor;
    function Processor() { this.port = { postMessage() {} }; }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/js/mix-worklet.js'), 'utf8'), {
        AudioWorkletProcessor: Processor, sampleRate: 48000,
        registerProcessor(_name, value) { Constructor = value; },
    });
    return new Constructor();
}
function process(original = [], translated = []) {
    const output = new Float32Array(Math.max(original.length, translated.length));
    const voice = new Float32Array(output.length);
    const instance = mixer();
    assert.equal(instance.process([[Float32Array.from(original)], [Float32Array.from(translated)]], [[output], [voice]]), true);
    return { output: Array.from(output), voice: Array.from(voice), clipping: instance.levels.clippedSamples };
}

test('mix processor sums original and translation and exposes translation-only monitoring', () => {
    const value = process([0.25, -0.25, 0.25], [0.5, 0.5, 0]);
    assert.deepEqual(value.output, [0.75, 0.25, 0.25]);
    assert.deepEqual(value.voice, [0.5, 0.5, 0]);
});
test('mix processor bounds both polarities at full scale and counts limited samples', () => {
    const value = process([0.75, -0.75, 0.5], [0.75, -0.75, 0.5]);
    assert.deepEqual(value.output, [1, -1, 1]);
    assert.equal(value.clipping, 2);
});
test('muting either input removes just that signal', () => {
    assert.deepEqual(process([0, 0], [0.25, -0.25]).output, [0.25, -0.25]);
    assert.deepEqual(process([0.5, -0.5], [0, 0]).output, [0.5, -0.5]);
    assert.deepEqual(process([0, 0], [0, 0]).output, [0, 0]);
});
test('device identity retains the exact selection, rebinds one known label, and rejects ambiguous labels', async () => {
    const { resolveAudioDevice, classifyAudioDevices } = await import('../app/js/audio-mix-bus.js');
    const devices = [{ kind: 'audiooutput', deviceId: 'a', label: 'CABLE Input', groupId: '1' }, { kind: 'audiooutput', deviceId: 'b', label: 'Speaker', groupId: '2' }];
    assert.equal(resolveAudioDevice(devices, 'a', 'Speaker').deviceId, 'a');
    assert.equal(resolveAudioDevice(devices, 'old', 'CABLE Input').deviceId, 'a');
    assert.equal(resolveAudioDevice([...devices, { deviceId: 'c', label: 'CABLE Input' }], 'old', 'CABLE Input').missing, true);
    assert.equal(resolveAudioDevice(devices, 'old', 'Gone').missing, true);
    assert.equal(classifyAudioDevices(devices).virtualOutputs.length, 1);
});

test('virtual pair resolver recognizes DDTrans and VB-CABLE aliases', async () => {
    const { resolveDDTransVirtualPair } = await import('../app/js/audio-mix-bus.js');
    for (const [renderLabel, captureLabel] of [
        ['DDTrans Virtual Input', 'DDTrans Virtual Microphone'],
        ['DDTrans Virtual Input (DDTrans Virtual Audio)', 'DDTrans Virtual Microphone (DDTrans Virtual Audio)'],
        ['DDTrans Virtual Input (VB-Audio Virtual Cable)', 'DDTrans Virtual Microphone (VB-Audio Virtual Cable)'],
        ['cable input (vb-audio virtual cable)', 'CABLE OUTPUT (VB-AUDIO VIRTUAL CABLE)'],
        ['CABLE Input (VB-Audio Virtual Cable)', 'DDTrans Virtual Microphone (VB-Audio Virtual Cable)'],
        ['DDTrans Virtual Input (VB-Audio Virtual Cable)', 'CABLE Output (VB-Audio Virtual Cable)'],
    ]) {
        const pair = resolveDDTransVirtualPair({
            outputs: [{ deviceId: 'render', kind: 'audiooutput', label: renderLabel }],
            inputs: [{ deviceId: 'capture', kind: 'audioinput', label: captureLabel }],
        });
        assert.equal(pair.available, true, renderLabel);
        assert.equal(pair.render.deviceId, 'render');
        assert.equal(pair.capture.deviceId, 'capture');
    }
});

test('virtual pair resolver does not mix custom-driver and VB-CABLE endpoints', async () => {
    const { resolveDDTransVirtualPair } = await import('../app/js/audio-mix-bus.js');
    const pair = resolveDDTransVirtualPair({
        outputs: [{ deviceId: 'custom-render', kind: 'audiooutput', label: 'DDTrans Virtual Input (DDTrans Virtual Audio)' }],
        inputs: [{ deviceId: 'vb-capture', kind: 'audioinput', label: 'DDTrans Virtual Microphone (VB-Audio Virtual Cable)' }],
    });
    assert.equal(pair.status, 'missing');
});

test('virtual pair resolver fails closed for missing, 16-channel, and ambiguous devices', async () => {
    const { resolveDDTransVirtualPair } = await import('../app/js/audio-mix-bus.js');
    const capture = { deviceId: 'capture', kind: 'audioinput', label: 'CABLE Output (VB-Audio Virtual Cable)' };
    assert.equal(resolveDDTransVirtualPair({ outputs: [], inputs: [capture] }).status, 'missing');
    assert.equal(resolveDDTransVirtualPair({
        outputs: [{ deviceId: '16ch', kind: 'audiooutput', label: 'CABLE Input 16 Ch (VB-Audio Virtual Cable)' }],
        inputs: [capture],
    }).status, 'missing');
    assert.equal(resolveDDTransVirtualPair({
        outputs: [
            { deviceId: 'dd-render', kind: 'audiooutput', label: 'DDTrans Virtual Input' },
            { deviceId: 'cable-render', kind: 'audiooutput', label: 'CABLE Input (VB-Audio Virtual Cable)' },
        ],
        inputs: [
            { deviceId: 'dd-capture', kind: 'audioinput', label: 'DDTrans Virtual Microphone' },
            capture,
        ],
    }).status, 'ambiguous');
});

test('virtual pair resolver uses an exact persisted pair only when it is known', async () => {
    const { resolveDDTransVirtualPair } = await import('../app/js/audio-mix-bus.js');
    const devices = {
        outputs: [
            { deviceId: 'dd-render', kind: 'audiooutput', label: 'DDTrans Virtual Input' },
            { deviceId: 'cable-render', kind: 'audiooutput', label: 'CABLE Input (VB-Audio Virtual Cable)' },
        ],
        inputs: [
            { deviceId: 'dd-capture', kind: 'audioinput', label: 'DDTrans Virtual Microphone' },
            { deviceId: 'cable-capture', kind: 'audioinput', label: 'CABLE Output (VB-Audio Virtual Cable)' },
        ],
    };
    const selected = resolveDDTransVirtualPair(devices, { virtualRenderDeviceId: 'cable-render', virtualCaptureDeviceId: 'cable-capture' });
    assert.equal(selected.available, true);
    assert.equal(selected.render.deviceId, 'cable-render');
    assert.equal(selected.capture.deviceId, 'cable-capture');
    assert.equal(resolveDDTransVirtualPair(devices, { virtualRenderDeviceId: 'cable-render', virtualCaptureDeviceId: 'dd-capture' }).status, 'ambiguous');
});


test('VB-CABLE pairs localized and customized endpoint labels without choosing the 16-channel input', async () => {
    const { classifyAudioDevices, resolveDDTransVirtualPair } = await import('../app/js/audio-mix-bus.js');
    const devices = classifyAudioDevices([
        { kind: 'audiooutput', deviceId: 'render-localized', label: '扬声器 (VB-Audio Virtual Cable)' },
        { kind: 'audiooutput', deviceId: 'render-16', label: 'CABLE In 16 Ch (VB-Audio Virtual Cable)' },
        { kind: 'audioinput', deviceId: 'capture-custom', label: '会议译音 (VB-Audio Virtual Cable)' },
    ]);
    const pair = resolveDDTransVirtualPair(devices);
    assert.equal(pair.available, true);
    assert.equal(pair.render.deviceId, 'render-localized');
    assert.equal(pair.capture.deviceId, 'capture-custom');
});
