const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, ipcMain } = require('electron');
const { loadConfig, buildSessionConfig } = require('../electron/config');
const { runProbe, readPcm16 } = require('./probe-realtime.cjs');

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const config = loadConfig();
const output = path.resolve(value('--out') || 'data/probes/transports/latest.json');
const pcm = readPcm16(path.resolve(value('--input') || 'data/probes/fixtures/two-speakers-16k.pcm'));
const session = buildSessionConfig({ target_language: 'en', audio_enabled: true });
const signalUrl = new URL(config.endpoint);
signalUrl.protocol = 'https:';
signalUrl.pathname = '/api/v1/webrtc/realtime';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = { date: new Date().toISOString(), model: config.model, input_ms: pcm.length / 32, trials: [] };
app.on('window-all-closed', () => {});

function observe(result, event, elapsed) {
  result.counts[event.type] = (result.counts[event.type] || 0) + 1;
  if (event.type === 'session.updated') result.accepted = event.session;
  if (event.type === 'conversation.item.input_audio_transcription.delta') result.timings_ms.first_source ??= elapsed();
  if (['response.text.delta', 'response.audio_transcript.delta'].includes(event.type)) result.timings_ms.first_translation ??= elapsed();
  if (event.type === 'conversation.item.input_audio_transcription.completed') result.source.push(event.transcript);
  if (['response.text.done', 'response.audio_transcript.done'].includes(event.type)) result.translation.push(event.text ?? event.transcript);
  if (event.type === 'error') result.errors.push(event.error || { message: event.message });
}

async function probeAoq() {
  const result = { transport: 'aoq', timings_ms: {}, counts: {}, errors: [], source: [], translation: [], output_audio_bytes: 0, sdk_calls: [] };
  const streamMode = value('--aoq-mode') === 'stream';
  const outputRate = streamMode ? 48000 : 24000;
  result.downlink_mode = streamMode ? 'stream' : 'segment';
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let engine, ended = false, timer;
  try {
    const sdk = require(path.resolve(value('--aoq-sdk')));
    engine = sdk.createAoqClientEngine();
    result.sdk_version = engine.getVersion();
    const call = (method, ...params) => {
      const code = engine[method](...params);
      result.sdk_calls.push({ method, code });
      if (code !== 0) throw new Error(method + ' returned ' + code);
    };
    fs.mkdirSync(path.join(path.dirname(output), 'aoq-logs'), { recursive: true });
    call('createEngine', { workDir: path.join(path.dirname(output), 'aoq-logs'), enableDumpAudio: false });
    call('setAudioEncoderConfig', { trackType: 0, codecType: 2, sampleRate: 16000, channel: 1, bitrate: 32000 });
    call('setAudioDecoderConfig', { trackType: 0, codecType: 2, sampleRate: outputRate, channel: 1 });
    call('setAudioFrameObserver', true);
    call('startAudioCapture', { isExternal: true, channel: 1 });
    call('enableSendMediaStream', 0, false);
    call('startAudioPlayer', { isExternal: true, channel: 1 });
    call('enableAudioFrameObserver', { enabled: true, audioSource: 3, sampleRate: outputRate, channels: 1 });
    call('addAudioExternalStream', { streamId: 'probe', trackType: 0, codecType: 1, channels: 1, sampleRate: 16000, publishVolume: 100, playoutVolume: 0, enable3A: false, maxBufferDuration: 200 });
    const response = await fetch(signalUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json', 'x-dashscope-rtc-transport': 'moq' }, body: '{}', signal: AbortSignal.timeout(15000) });
    result.credential_http_status = response.status;
    if (!response.ok) throw new Error('AOQ credentials HTTP ' + response.status);
    const credentials = await response.json();
    result.timings_ms.credentials = elapsed();
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('AOQ timeout')), 45000);
      engine.on('onError', (code, message) => reject(new Error('AOQ ' + code + ': ' + message)));
      engine.on('onWarning', (code, message) => { (result.warnings ??= []).push({ code, message }); });
      engine.on('onStats', stats => { result.stats = stats; });
      engine.on('onConnectionStatusChange', status => { if (status === 2) result.timings_ms.connected = elapsed(); if (status === 3) reject(new Error('AOQ connection failed')); });
      engine.on('onPlaybackAudioFrame', frame => {
        (result.frames ??= []).length < 3 && result.frames.push({ ...frame, buffer: frame.buffer?.byteLength });
        if (frame.autoGenMute) return;
        const bytes = Buffer.from(frame.buffer);
        let audible = false;
        for (let i = 0; i + 1 < bytes.length; i += 2) if (Math.abs(bytes.readInt16LE(i)) > 10) { audible = true; break; }
        if (audible) result.timings_ms.first_audio ??= elapsed();
        result.output_audio_bytes += bytes.length;
      });
      engine.on('onDataMsg', bytes => {
        try {
          const event = JSON.parse(Buffer.from(bytes).toString());
          observe(result, event, elapsed);
          if (event.type === 'session.created') call('sendDataMsg', JSON.stringify({ type: 'session.update', session }));
          if (event.type === 'session.updated' && !result.timings_ms.audio_start) {
            result.timings_ms.configured = elapsed();
            call('enableSendMediaStream', 0, true);
            result.timings_ms.audio_start = elapsed();
            void (async () => {
              const origin = performance.now();
              for (let offset = 0; offset < pcm.length && !ended; offset += 640) {
                const frame = pcm.subarray(offset, offset + 640);
                const code = engine.pushAudioExternalStreamData({ streamId: 'probe', numOfSamples: frame.length / 2, bytesPerSample: 2, numOfChannels: 1, samplesPerSec: 16000, pushSequence: offset / 640 }, frame);
                if (code !== 0) throw new Error('AOQ audio input returned ' + code);
                await sleep(Math.max(0, origin + (offset + frame.length) / 32 - performance.now()));
              }
              if (!ended) call('sendDataMsg', JSON.stringify({ type: 'session.finish' }));
            })().catch(reject);
          }
          if (event.type === 'error') reject(new Error(event.error?.message || 'AOQ model error'));
          if (event.type === 'session.finished') { result.timings_ms.finished = elapsed(); resolve(); }
        } catch (error) { reject(error); }
      });
      call('connect', { token: credentials.aoqTokenForClient, sid: credentials.sid, certFingerprint: credentials.clientRelayCertFingerprint, relayEndpoints: credentials.clientRelayEndpoints.map((entry, i) => ({ ...entry, routeIndex: entry.route_index ?? i })), workspaceIdHash: credentials.extraInfo?.workspaceIdHash, publishTracks: [{ trackType: 0 }, { trackType: 2 }], subscribeTracks: [{ trackType: 0, trackMode: streamMode ? 1 : 0 }, { trackType: 2 }] });
    });
  } catch (error) { result.failure = error.message; }
  finally { ended = true; clearTimeout(timer); engine?.disconnect(); engine?.stopAudioCapture(); engine?.stopAudioPlayer(); engine?.destroy(); }
  return result;
}

async function rtcRenderer({ samples, session }) {
  const { ipcRenderer } = require('electron');
  const result = { transport: 'webrtc', timings_ms: {}, counts: {}, errors: [], source: [], translation: [], output_audio_samples: 0 };
  const origin = performance.now(), elapsed = () => Math.round(performance.now() - origin);
  const pc = new RTCPeerConnection({ iceServers: [] });
  const context = new AudioContext({ sampleRate: 48000 });
  const sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
  const destination = context.createMediaStreamDestination();
  const channels = new Set();
  let channel, created = false, configured = false, updated = false, source, poll, timer;
  let finish, fail;
  const complete = new Promise((resolve, reject) => { finish = resolve; fail = reject; timer = setTimeout(() => reject(new Error('WebRTC timeout')), 45000); });
  complete.catch(() => {});
  function initialize() {
    if (created && channel?.readyState === 'open' && !updated) { updated = true; channel.send(JSON.stringify({ type: 'session.update', session })); }
  }
  function bind(dc) {
    channels.add(dc);
    dc.onopen = () => { if (!channel || dc.label === 'txt') channel = dc; initialize(); };
    dc.onmessage = async message => {
      try {
        const event = JSON.parse(message.data);
        result.counts[event.type] = (result.counts[event.type] || 0) + 1;
        if (event.type === 'session.created') { created = true; initialize(); }
        if (event.type === 'conversation.item.input_audio_transcription.delta') result.timings_ms.first_source ??= elapsed();
        if (['response.text.delta', 'response.audio_transcript.delta'].includes(event.type)) result.timings_ms.first_translation ??= elapsed();
        if (event.type === 'conversation.item.input_audio_transcription.completed') result.source.push(event.transcript);
        if (['response.text.done', 'response.audio_transcript.done'].includes(event.type)) result.translation.push(event.text ?? event.transcript);
        if (event.type === 'session.updated' && !configured) {
          configured = true; result.accepted = event.session; result.timings_ms.configured = elapsed();
          await sender.replaceTrack(destination.stream.getAudioTracks()[0]);
          const buffer = context.createBuffer(1, samples.length, 16000);
          buffer.copyToChannel(Float32Array.from(samples, sample => sample / 32768), 0);
          source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
          source.onended = () => { if (channel?.readyState === 'open') channel.send(JSON.stringify({ type: 'session.finish' })); };
          result.timings_ms.audio_start = elapsed(); source.start();
        }
        if (event.type === 'error') { result.errors.push(event.error || event); fail(new Error(event.error?.message || 'WebRTC model error')); }
        if (event.type === 'session.finished') { result.timings_ms.finished = elapsed(); finish(); }
      } catch (error) { fail(error); }
    };
  }
  pc.ondatachannel = event => bind(event.channel);
  bind(pc.createDataChannel('oai-events'));
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'connected') result.timings_ms.connected = elapsed(); if (pc.connectionState === 'failed') fail(new Error('WebRTC ICE/DTLS connection failed')); };
  pc.ontrack = event => {
    const stream = new MediaStream([event.track]);
    const audio = document.createElement('audio'); audio.muted = true; audio.srcObject = stream; document.body.append(audio); void audio.play();
    const input = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser(); analyser.fftSize = 512; input.connect(analyser);
    const zero = context.createGain(); zero.gain.value = 0; analyser.connect(zero); zero.connect(context.destination);
    const data = new Float32Array(512);
    poll = setInterval(() => { analyser.getFloatTimeDomainData(data); if (data.some(value => Math.abs(value) > 0.0003)) { result.timings_ms.first_audio ??= elapsed(); result.output_audio_samples += data.length; } }, 10);
  };
  try {
    await context.resume();
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ICE gathering timeout')), 15000);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); } };
    });
    const response = await ipcRenderer.invoke('probe-sdp', pc.localDescription.sdp);
    result.sdp_http_status = response.status; result.timings_ms.sdp = elapsed();
    if (response.status !== 200) throw new Error('WebRTC SDP HTTP ' + response.status);
    await pc.setRemoteDescription({ type: 'answer', sdp: response.sdp });
    await complete;
    result.rtc_stats = [];
    for (const stat of (await pc.getStats()).values()) if (['inbound-rtp', 'outbound-rtp', 'candidate-pair'].includes(stat.type)) result.rtc_stats.push({ type: stat.type, kind: stat.kind, state: stat.state, packetsLost: stat.packetsLost, jitter: stat.jitter, roundTripTime: stat.currentRoundTripTime, bytesSent: stat.bytesSent, bytesReceived: stat.bytesReceived });
  } catch (error) { result.failure = error.message; }
  finally { clearTimeout(timer); clearInterval(poll); for (const dc of channels) dc.close(); pc.close(); source?.disconnect(); destination.stream.getTracks().forEach(track => track.stop()); await context.close(); complete.catch(() => {}); }
  return result;
}

async function probeWebRtc() {
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  ipcMain.handle('probe-sdp', async (event, sdp) => {
    if (event.sender !== window.webContents) throw new Error('Invalid probe sender');
    const response = await fetch(signalUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/sdp' }, body: sdp, signal: AbortSignal.timeout(20000) });
    return { status: response.status, sdp: response.ok ? await response.text() : '' };
  });
  try {
    await window.loadURL('data:text/html,<title>DDTrans transport probe</title>');
    return await window.webContents.executeJavaScript('(' + rtcRenderer.toString() + ')(' + JSON.stringify({ session, samples: [...new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)] }) + ')');
  } finally { ipcMain.removeHandler('probe-sdp'); window.destroy(); }
}

app.whenReady().then(async () => {
  const transports = (value('--transports') || 'websocket,webrtc,aoq').split(',');
  for (const transport of transports) {
    let result;
    if (transport === 'websocket') { result = await runProbe({ url: config.endpoint, apiKey: config.apiKey, session, pcm, logFile: path.join(path.dirname(output), 'websocket-events.json') }); result.transport = transport; result.timings_ms.audio_start = result.timings_ms.configured; }
    else if (transport === 'webrtc') result = await probeWebRtc();
    else if (transport === 'aoq') result = await probeAoq();
    else throw new Error('Unknown transport: ' + transport);
    results.trials.push(result);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ transport, failure: result.failure, timings_ms: result.timings_ms, errors: result.errors }));
  }
  app.exit();
}).catch(error => { console.error(error.message.replaceAll(config.apiKey, '[redacted]')); app.exit(1); });
