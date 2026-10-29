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
