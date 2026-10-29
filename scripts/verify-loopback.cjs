const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
process.env.SERVER_PORT = '0';
process.env.DDTRANS_TEST_USER_DATA ||= path.resolve(__dirname, '../data/probes/loopback-user');
process.env.DDTRANS_DATA_DIR ||= path.resolve(__dirname, '../data/probes/loopback-data');
fs.mkdirSync(process.env.DDTRANS_TEST_USER_DATA, { recursive: true });
let verified = false;
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    if (!window.webContents.getURL().endsWith('/media-host.html')) return;
    void window.webContents.executeJavaScript('(' + (async function () {
      const context = new AudioContext({ sampleRate: 16000 }); await context.resume();
      const oscillator = context.createOscillator(); oscillator.frequency.value = 997;
      const output = context.createGain(); output.gain.value = 0.035;
      oscillator.connect(output); output.connect(context.destination);
      const streams = [];
      let player;
      try {
        async function analyzer(restrictOwnAudio) {
          const stream = await navigator.mediaDevices.getDisplayMedia({ audio: { restrictOwnAudio, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: true });
          streams.push(stream); stream.getVideoTracks().forEach(track => track.stop());
          const source = context.createMediaStreamSource(stream), node = context.createAnalyser(), zero = context.createGain();
          node.fftSize = 4096; zero.gain.value = 0;
          source.connect(node); node.connect(zero); zero.connect(context.destination);
          return { node, settings: stream.getAudioTracks()[0].getSettings() };
        }
        const restricted = await analyzer(true), control = await analyzer(false);
        oscillator.start();
        await new Promise(resolve => setTimeout(resolve, 450));
        const restrictedAmplitudes = [], controlAmplitudes = [];
        function amplitude(node) {
          const samples = new Float32Array(node.fftSize); node.getFloatTimeDomainData(samples);
          let real = 0, imag = 0;
          for (let i = 0; i < samples.length; i++) { const angle = 2 * Math.PI * 997 * i / context.sampleRate; real += samples[i] * Math.cos(angle); imag += samples[i] * Math.sin(angle); }
          return 2 * Math.hypot(real, imag) / samples.length;
        }
        for (let i = 0; i < 14; i++) {
          restrictedAmplitudes.push(amplitude(restricted.node)); controlAmplitudes.push(amplitude(control.node));
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
        oscillator.stop(); output.disconnect();
        const { createPcmPlayer } = await import('/js/audio-engine.js');
        player = createPcmPlayer({ sampleRate: 24000, volume: 1 });
        const pcm = new Int16Array(24000 * 3);
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(2 * Math.PI * 997 * i / 24000) * 1100);
        player.append(new Uint8Array(pcm.buffer));
        await new Promise(resolve => setTimeout(resolve, 750));
        const full = amplitude(control.node);
        player.setVolume(0.2);
        await new Promise(resolve => setTimeout(resolve, 750));
        const fifth = amplitude(control.node);
        player.setVolume(0);
        await new Promise(resolve => setTimeout(resolve, 750));
        const muted = amplitude(control.node);
        await player.stop();
        return { player_volume: { full_amplitude: full, fifth_amplitude: fifth, muted_amplitude: muted, ratio: fifth / full }, supports_restrict_own_audio: Boolean(navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio), restricted_settings: restricted.settings, control_settings: control.settings, restricted_amplitude_997hz: mean(restrictedAmplitudes), control_amplitude_997hz: mean(controlAmplitudes) };
      } finally { await player?.stop(); streams.flatMap(stream => stream.getTracks()).forEach(track => track.stop()); oscillator.stop(); await context.close(); }
    }).toString() + ')()', true).then(result => {
      assert.equal(result.supports_restrict_own_audio, true);
      assert.equal(result.restricted_settings.restrictOwnAudio, true);
      assert.ok(result.control_amplitude_997hz > 0.001, 'unrestricted loopback did not hear the test tone');
      result.exclusion_ratio = result.restricted_amplitude_997hz / result.control_amplitude_997hz;
      assert.ok(result.exclusion_ratio < 0.1, 'DDTrans output leaked into restricted capture');
      console.log('Native audio measures:', JSON.stringify(result));
      assert.ok(result.player_volume.full_amplitude > 0.001);
      assert.ok(Math.abs(result.player_volume.ratio - 0.2) < 0.08);
      assert.ok(result.player_volume.muted_amplitude < result.player_volume.full_amplitude * 0.02);
      fs.writeFileSync(path.resolve(__dirname, '../data/probes/loopback-isolation.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2)); verified = true; app.quit();
    }).catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
  });
});
setTimeout(() => { if (!verified) { console.error('loopback verification timeout'); process.exitCode = 1; app.quit(); } }, 25000).unref();
app.on('will-quit',event=>{if(!verified){event.preventDefault();app.exit(1)}});
require('../electron/main.js');
