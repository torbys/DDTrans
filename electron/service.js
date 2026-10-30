const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { loadConfig, transportCapabilities, validateEndpoint } = require('./config');
const { createStore } = require('./store');
const { createTranslationSession } = require('./session');
const { wavHeader } = require('./pcm-writer');

async function startService(config, dependencies = {}) {
  let runtimeConfig = config;
  const mediaDir = path.join(config.dataDir, 'media');
  const store = createStore({ dbPath: path.join(config.dataDir, 'translation.db'), mediaDir });
  const clients = new Set();
  const active = new Map();
  let origin;
  let closing;
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }
  async function body(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new Error('请求内容过大'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }
  function mediaPath(relative) {
    const full = path.resolve(mediaDir, relative || '');
    const inside = path.relative(mediaDir, full);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('无效音频路径');
    return full;
  }
  function serveFile(request, response, file, type = 'audio/wav') {
    const stat = fs.statSync(file);
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    let start = 0, end = stat.size - 1, status = 200;
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    if (range) {
      start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end) { response.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); response.end(); return; }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
      status = 206;
    }
    headers['Content-Length'] = end - start + 1;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(file, { start, end }).on('error', () => response.destroy()).pipe(response);
  }
  function segmentAudio(request, response, id, type) {
    const audio = store.getSegmentAudio(id, type);
    if (!audio) return json(response, 404, { error: '该段暂无音频' });
    if (audio.data) { response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.data.length }); response.end(audio.data); return; }
    const file = mediaPath(audio.path);
    if (type === 'tts' || audio.start_ms == null || audio.end_ms == null) return serveFile(request, response, file);
    const length = Math.max(0, fs.statSync(file).size - 44);
    const start = Math.min(length, Math.max(0, Math.floor(audio.start_ms * 32 / 2) * 2));
    const end = Math.min(length, Math.max(start, Math.floor(audio.end_ms * 32 / 2) * 2));
    response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': 44 + end - start });
    response.write(wavHeader(end - start, 16000));
    if (end > start) fs.createReadStream(file, { start: 44 + start, end: 44 + end - 1 }).on('error', () => response.destroy()).pipe(response);
    else response.end();
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { error: '请求来源不受支持' });
      if (request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: '请求来源不受支持' });
      if (url.pathname === '/api/health') return json(response, 200, { ready: true, model: runtimeConfig.model, active_sessions: active.size });
      if (url.pathname === '/api/capabilities') return json(response, 200, { model: runtimeConfig.model, transports: transportCapabilities(), source_language: 'auto', speaker_detection: true, input_sample_rate: 16000, output_sample_rate: 24000 });
      if (url.pathname === '/api/sessions' && request.method === 'GET') {
        return json(response, 200, store.listSessions({ limit: Number(url.searchParams.get('limit') || 50), offset: Number(url.searchParams.get('offset') || 0), search: url.searchParams.get('search') || '', sort: url.searchParams.get('sort') || 'newest' }));
      }
      let match = url.pathname.match(/^\/api\/sessions\/(\d+)$/);
      if (match) {
        const id = Number(match[1]);
        const session = store.getSession(id);
        if (!session) return json(response, 404, { error: '会议不存在' });
        if (request.method === 'GET') return json(response, 200, { session, segments: store.getSegments(id), notes: store.getNotes(id) });
        if (active.has(id)) return json(response, 409, { error: '请先结束正在进行的同传' });
        if (request.method === 'DELETE') { store.deleteSession(id); return json(response, 200, { success: true }); }
        if (request.method === 'PATCH') {
          const data = await body(request);
          if (typeof data.name !== 'string' || data.name.length > 200) throw new Error('会议名称最多200字');
          return json(response, 200, { session: store.updateSession(id, { name: data.name.trim() }) });
        }
      }
      match = url.pathname.match(/^\/api\/sessions\/(\d+)\/audio$/);
      if (match && request.method === 'GET') {
        const session = store.getSession(Number(match[1]));
        if (!session?.raw_audio_path) return json(response, 404, { error: '暂无原始录音' });
        return serveFile(request, response, mediaPath(session.raw_audio_path));
      }
      match = url.pathname.match(/^\/api\/audio\/(\d+)$/);
      if (match && request.method === 'GET') return segmentAudio(request, response, Number(match[1]), url.searchParams.get('type') || 'tts');
      match = url.pathname.match(/^\/api\/sessions\/(\d+)\/notes(?:\/(\d+))?$/);
      if (match) {
        const sessionId = Number(match[1]);
        if (!store.getSession(sessionId)) return json(response, 404, { error: '会议不存在' });
        const noteId = match[2] ? Number(match[2]) : undefined;
        if (request.method === 'GET') return json(response, 200, { notes: store.getNotes(sessionId) });
        if (request.method === 'DELETE' && noteId) return json(response, 200, { success: store.deleteNote(sessionId, noteId) });
        if (request.method === 'POST' || request.method === 'PATCH' && noteId) {
          const data = await body(request);
          if (typeof data.content !== 'string' || data.content.length > 20000) throw new Error('笔记最多20000字');
          const note = store.saveNote(sessionId, data.content, noteId);
          return json(response, note ? 200 : 404, note ? { note } : { error: '笔记不存在' });
        }
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: '接口不存在' });
      if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: '请求方式不支持' });
      const resource = url.pathname.startsWith('/resources/');
      const base = path.join(config.root, resource ? 'resources' : 'app');
      const relative = decodeURIComponent(resource ? url.pathname.slice('/resources/'.length) : url.pathname === '/' ? 'home.html' : url.pathname.slice(1));
      const file = path.resolve(base, relative);
      const inside = path.relative(base, file);
      if (inside.startsWith('..') || path.isAbsolute(inside)) return json(response, 403, { error: '无效路径' });
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'");
      return serveFile(request, response, file, types[path.extname(file)] || 'application/octet-stream');
    } catch (error) {
      if (response.headersSent) return response.destroy();
      json(response, error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? '文件不存在' : error.message });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    if (closing || request.url !== '/ws/translate' || request.headers.origin && request.headers.origin !== origin) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    clients.add(ws);
    let session;
    let control = Promise.resolve();
    let lastPong = Date.now();
    const emit = event => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 512 * 1024) { ws.close(1013, '客户端处理过慢'); return; }
      ws.send(JSON.stringify(event));
    };
    const ping = setInterval(() => { if (Date.now() - lastPong > 45000) ws.terminate(); else if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 15000);
    ping.unref();
    ws.on('pong', () => { lastPong = Date.now(); });
    ws.on('message', (raw, binary) => {
      if (binary) {
        try { session?.sendAudio(raw); } catch (error) { emit({ type: 'error', message: error.message }); void session?.stop({ interrupted: true }).finally(() => active.delete(session.id)); }
        return;
      }
      control = control.then(async () => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'start') {
          if (session) throw new Error('此连接已经创建会话');
          session = createTranslationSession({ options: message, config: runtimeConfig, store, emit, gatewayFactory: dependencies.gatewayFactory });
          active.set(session.id, session);
          await session.start();
        } else if (!session) throw new Error('请先开始同传');
        else if (message.type === 'pause') await session.pause();
        else if (message.type === 'resume') session.resume();
        else if (message.type === 'note') session.saveNote(message.content);
        else if (message.type === 'stop') { await session.stop(); active.delete(session.id); }
        else throw new Error('未知控制消息');
      }).catch(error => { emit({ type: 'error', message: error.message }); if (session?.state === 'stopped') active.delete(session.id); });
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearInterval(ping);
      clients.delete(ws);
      if (session) void control.finally(() => session.stop({ interrupted: session.state !== 'stopped' })).catch(error => console.error('会话收尾失败:', error.message)).finally(() => active.delete(session.id));
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  } catch (error) { store.close(); throw error; }
  origin = 'http://127.0.0.1:' + server.address().port;
  function configure(next, { allowEmptyApiKey = false } = {}) {
    if (active.size > 0) throw new Error('请先停止当前同传，再保存翻译服务配置');
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('无效翻译服务配置');
    const endpoint = validateEndpoint(next.endpoint);
    const apiKey = typeof next.apiKey === 'string' ? next.apiKey.trim() : '';
    if (!apiKey && !allowEmptyApiKey) throw new Error('请输入 API Key');
    runtimeConfig = {
      ...runtimeConfig,
      endpoint,
      apiKey,
    };
    return { endpoint: runtimeConfig.endpoint, hasKey: Boolean(runtimeConfig.apiKey) };
  }
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      await Promise.allSettled([...active.values()].map(session => session.stop()));
      active.clear();
      for (const ws of clients) ws.terminate();
      wss.close();
      await new Promise(resolve => server.close(resolve));
      store.close();
    })();
    return closing;
  }
  return { origin, close, store, configure };
}
module.exports = { startService };
if (require.main === module) {
  let service;
  async function shutdown() {
    await service?.close();
    if (process.parentPort) process.parentPort.postMessage({ type: 'stopped' });
    else process.exit(0);
  }
  if (process.parentPort) process.parentPort.on('message', event => {
    const message = event.data;
    if (message?.type === 'shutdown') void shutdown();
    if (message?.type === 'configure') {
      try {
        const result = service?.configure(message.config, { allowEmptyApiKey: message.allowEmptyApiKey === true });
        if (result) process.parentPort.postMessage({ type: 'configured', requestId: message.requestId, result });
        else process.parentPort.postMessage({ type: 'configure-error', requestId: message.requestId, message: '同传后台尚未就绪' });
      } catch (error) {
        process.parentPort.postMessage({ type: 'configure-error', requestId: message.requestId, message: error.message });
      }
    }
  });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  let initialConfig;
  try { initialConfig = process.env.DDTRANS_SERVICE_CONFIG ? JSON.parse(process.env.DDTRANS_SERVICE_CONFIG) : loadConfig(); }
  catch (error) {
    if (process.parentPort) process.parentPort.postMessage({ type: 'error', message: error.message });
    else console.error(error.message);
    process.exitCode = 1;
  }
  if (initialConfig) {
    startService(initialConfig).then(result => {
      service = result;
      if (process.parentPort) process.parentPort.postMessage({ type: 'ready', origin: service.origin });
      else console.log('DDtrans ready: ' + service.origin);
    }).catch(error => {
      if (process.parentPort) process.parentPort.postMessage({ type: 'error', message: error.message });
      else console.error(error.message);
      process.exitCode = 1;
    });
  }
}
