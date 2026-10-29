const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createProcessor({ inputSampleRate, targetSampleRate = 16000, frameSamples = 320 }) {
    let Processor;

    class FakeAudioWorkletProcessor {
        constructor() {
            this.port = {
                messages: [],
                onmessage: null,
                postMessage: (message) => {
                    this.port.messages.push({
                        ...message,
                        pcm: message.pcm.slice(0),
                    });
                },
            };
        }
    }

    const sandbox = {
        AudioWorkletProcessor: FakeAudioWorkletProcessor,
        Float32Array,
        Int16Array,
        Math,
        sampleRate: inputSampleRate,
        registerProcessor: (_name, constructor) => { Processor = constructor; },
    };
    const source = fs.readFileSync(path.join(__dirname, '../app/js/pcm-worklet.js'), 'utf8');
    vm.runInNewContext(source, sandbox, { filename: 'pcm-worklet.js' });
    return new Processor({
        processorOptions: { inputSampleRate, targetSampleRate, frameSamples },
    });
}

function processSamples(processor, samples, blockSize) {
    for (let offset = 0; offset < samples.length; offset += blockSize) {
        const input = samples.subarray(offset, Math.min(offset + blockSize, samples.length));
        const output = new Float32Array(input.length);
        assert.equal(processor.process([[input]], [[output]]), true);
        assert.deepEqual(Array.from(output), Array(input.length).fill(0));
    }
}

function toInt16(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    return Math.trunc(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

test('48 kHz multi-block capture keeps continuous resampling phase', () => {
    const processor = createProcessor({ inputSampleRate: 48000 });
    const input = new Float32Array(144000);
    input.fill(0.25);
    processSamples(processor, input, 128);

    const idealOutputSamples = input.length / 3;
    const fixedLatencySamples = idealOutputSamples - processor.outputSampleOffset;

    assert.ok(fixedLatencySamples >= 0 && fixedLatencySamples <= 32,
        `expected only fixed filter latency, got ${fixedLatencySamples} lost samples`);
    assert.equal(processor.port.messages.length, Math.floor(processor.outputSampleOffset / 320));
    for (const [index, frame] of processor.port.messages.entries()) {
        assert.equal(frame.pcm.byteLength, 640);
        assert.equal(frame.sampleCount, 320);
        assert.equal(frame.sampleOffset, index * 320);
    }
});

test('16 kHz capture passes PCM through without resampling', () => {
    const processor = createProcessor({ inputSampleRate: 16000 });
    const input = new Float32Array(320);
    const pattern = [-1, -0.5, 0, 0.25, 0.75, 1];
    for (let index = 0; index < input.length; index += 1) input[index] = pattern[index % pattern.length];
    processSamples(processor, input, 128);

    assert.equal(processor.port.messages.length, 1);
    const actual = new Int16Array(processor.port.messages[0].pcm);
    const expected = Array.from(input, toInt16);
    assert.deepEqual(Array.from(actual), expected);
    assert.equal(processor.port.messages[0].sampleOffset, 0);
});

test('paused frames are discarded and resume does not emit an old frame', () => {
    const processor = createProcessor({ inputSampleRate: 16000 });
    processor.port.onmessage({ data: { type: 'pause', paused: true } });
    processSamples(processor, new Float32Array(640).fill(0.5), 128);
    assert.equal(processor.port.messages.length, 0);

    processor.port.onmessage({ data: { type: 'pause', paused: false } });
    processSamples(processor, new Float32Array(320).fill(0.5), 128);

    assert.equal(processor.port.messages.length, 1);
    assert.equal(processor.port.messages[0].sampleOffset, 640);
    assert.equal(processor.port.messages[0].sampleCount, 320);
});
