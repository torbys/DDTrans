class PcmCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        const processorOptions = options.processorOptions || {};
        this.targetSampleRate = processorOptions.targetSampleRate || 16000;
        this.inputSampleRate = processorOptions.inputSampleRate || sampleRate;
        this.frameSamples = processorOptions.frameSamples || 320;
        this.paused = false;
        this.input = [];
        this.inputStart = 0;
        this.inputEnd = 0;
        this.nextInputPosition = 0;
        this.outputSampleOffset = 0;
        this.frame = new Int16Array(this.frameSamples);
        this.frameOffset = 0;
        this.frameStartOffset = 0;
        this.frameEnergy = 0;
        this.step = this.inputSampleRate / this.targetSampleRate;
        this.needsResample = this.inputSampleRate !== this.targetSampleRate;
        this.halfTaps = 32;
        this.cutoff = Math.min(1, this.targetSampleRate / this.inputSampleRate) * 0.47;

        this.port.onmessage = (event) => {
            if (event.data && event.data.type === 'pause') {
                this.paused = Boolean(event.data.paused);
            }
        };
    }

    process(inputs, outputs) {
        const output = outputs[0] && outputs[0][0];
        if (output) output.fill(0);

        const channels = inputs[0];
        if (!channels || channels.length === 0 || channels[0].length === 0) return true;

        const sampleCount = channels[0].length;
        for (let index = 0; index < sampleCount; index += 1) {
            let mixed = 0;
            for (let channel = 0; channel < channels.length; channel += 1) {
                mixed += channels[channel][index] || 0;
            }
            this.input.push(mixed / channels.length);
            this.inputEnd += 1;
        }

        if (this.needsResample) {
            this.emitResampledSamples();
        } else {
            this.emitNativeSamples();
        }
        this.trimInput();
        return true;
    }

    emitNativeSamples() {
        while (this.nextInputPosition < this.inputEnd) {
            const sample = this.readInput(Math.floor(this.nextInputPosition));
            this.nextInputPosition += 1;
            this.pushOutputSample(sample);
        }
    }

    emitResampledSamples() {
        while (Math.floor(this.nextInputPosition) + this.halfTaps < this.inputEnd) {
            const sample = this.filterAt(this.nextInputPosition);
            this.nextInputPosition += this.step;
            this.pushOutputSample(sample);
        }
    }

    filterAt(position) {
        const center = Math.floor(position);
        let sum = 0;
        let weightSum = 0;

        for (let offset = -this.halfTaps + 1; offset <= this.halfTaps; offset += 1) {
            const distance = center + offset - position;
            const normalized = distance / this.halfTaps;
            if (Math.abs(normalized) >= 1) continue;

            const sincArgument = 2 * this.cutoff * distance;
            const sinc = sincArgument === 0
                ? 1
                : Math.sin(Math.PI * sincArgument) / (Math.PI * sincArgument);
            const window = 0.5 + 0.5 * Math.cos(Math.PI * normalized);
            const weight = 2 * this.cutoff * sinc * window;
            sum += this.readInput(center + offset) * weight;
            weightSum += weight;
        }

        return weightSum === 0 ? 0 : sum / weightSum;
    }

    readInput(index) {
        if (index < this.inputStart || index >= this.inputEnd) return 0;
        return this.input[index - this.inputStart] || 0;
    }

    pushOutputSample(sample) {
        const clamped = Math.max(-1, Math.min(1, sample));
        if (this.frameOffset === 0) this.frameStartOffset = this.outputSampleOffset;
        this.frame[this.frameOffset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        this.frameEnergy += clamped * clamped;
        this.frameOffset += 1;
        this.outputSampleOffset += 1;

        if (this.frameOffset === this.frameSamples) {
            this.flushFrame();
        }
    }

    flushFrame() {
        const pcm = this.frame.buffer;
        const level = Math.sqrt(this.frameEnergy / this.frameSamples);
        const message = {
            type: 'pcm',
            pcm,
            sampleOffset: this.frameStartOffset,
            sampleCount: this.frameSamples,
            level,
        };

        if (!this.paused) this.port.postMessage(message, [pcm]);

        this.frame = new Int16Array(this.frameSamples);
        this.frameOffset = 0;
        this.frameEnergy = 0;
    }

    trimInput() {
        const keepFrom = Math.max(this.inputStart, Math.floor(this.nextInputPosition) - this.halfTaps - 2);
        const discard = keepFrom - this.inputStart;
        if (discard > 0) {
            this.input.splice(0, discard);
            this.inputStart = keepFrom;
        }
    }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
