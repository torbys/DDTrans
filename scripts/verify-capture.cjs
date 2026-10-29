const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

process.env.SERVER_PORT = '0';
process.env.DDTRANS_TEST_USER_DATA = path.resolve(__dirname, '../data/probes/capture-user');
process.env.DDTRANS_DATA_DIR = path.resolve(__dirname, '../data/probes/capture-data');
fs.mkdirSync(process.env.DDTRANS_TEST_USER_DATA, { recursive: true });
let verified = false;
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => void (async () => {
    const result = await window.webContents.executeJavaScript('(' + (async function () {
      const { createAudioCapture } = await import('/js/audio-capture.js');
      const result = { source: 'system-loopback', frames: 0, frame_samples: [], sample_rates: [], errors: [] };
      const capture = await createAudioCapture({
        useSystemAudio: true, useMicAudio: false,
        onFrame(frame) {
          result.frames++;
          if (!result.frame_samples.includes(frame.pcm.length)) result.frame_samples.push(frame.pcm.length);
          if (!result.sample_rates.includes(frame.sampleRate)) result.sample_rates.push(frame.sampleRate);
        },
        onError(error) { result.errors.push(error.message); },
      });
      result.isolated_system_audio = capture.isolatedSystemAudio;
      const tracks = capture.stream.getTracks();
      await new Promise(resolve => setTimeout(resolve, 500));
      await capture.stop();
      result.released = tracks.every(track => track.readyState === 'ended');
      return result;
    }).toString() + ')()', true);
    assert.ok(result.frames > 0);
    assert.deepEqual(result.frame_samples, [320]);
    assert.deepEqual(result.sample_rates, [16000]);
    assert.deepEqual(result.errors, []);
    assert.ok(result.released);
    assert.ok(result.isolated_system_audio);
    fs.mkdirSync(path.resolve(__dirname, '../data/probes'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../data/probes/system-capture.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    verified = true;
    app.quit();
  })().catch(error => { console.error(error); process.exitCode = 1; app.quit(); }));
});
setTimeout(() => { if (!verified) { console.error('系统声采集验证超时'); process.exitCode = 1; app.quit(); } }, 20000).unref();
app.on('will-quit', event => { if (!verified) { event.preventDefault(); app.exit(1); } });
require('../electron/main.js');
