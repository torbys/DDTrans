class DDTransMixProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.frames = 0;
        this.levels = { original: 0, translated: 0, mix: 0, clippedSamples: 0 };
    }
    process(inputs, outputs) {
        const original = inputs[0]?.[0], translated = inputs[1]?.[0];
        const mix = outputs[0][0], voice = outputs[1][0];
        for (let i = 0; i < mix.length; i++) {
            const a = original?.[i] || 0, b = translated?.[i] || 0, sum = a + b;
            mix[i] = Math.max(-1, Math.min(1, sum));
            voice[i] = Math.max(-1, Math.min(1, b));
            this.levels.original = Math.max(this.levels.original, Math.abs(a));
            this.levels.translated = Math.max(this.levels.translated, Math.abs(b));
            this.levels.mix = Math.max(this.levels.mix, Math.abs(mix[i]));
            if (Math.abs(sum) > 1) this.levels.clippedSamples++;
        }
        this.frames += mix.length;
        if (this.frames >= sampleRate / 10) {
            this.port.postMessage({ type: 'level', levels: { ...this.levels } });
            this.frames = 0;
            this.levels.original = this.levels.translated = this.levels.mix = 0;
        }
        return true;
    }
}
registerProcessor('ddtrans-mix', DDTransMixProcessor);
