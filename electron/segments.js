function createSegmentAssembler({ audioEnabled = false, onSegment = () => {}, onAudio = () => {}, onUsage = () => {}, onWarning = () => {} } = {}) {
  const sources = new Map();
  const translations = new Map();
  const responseItems = new Map();
  const seen = new Set();
  const counts = {};
  let sequence = 0;

  function source(id) {
    if (!sources.has(id)) sources.set(id, { segment_key: id, source_item_id: id, translation_item_id: null, response_id: null, sequence_order: sequence++, speaker_id: null, start_ms: null, end_ms: null, source_text: '', target_text: '', source_done: false, response_done: false, audio_done: !audioEnabled, interrupted: false, status: 'pending' });
    return sources.get(id);
  }
  function translation(id) {
    if (!translations.has(id)) translations.set(id, { id, sourceId: null, text: '', responseId: null, responseDone: false, audioDone: !audioEnabled, interrupted: false, audio: [] });
    return translations.get(id);
  }
  function publish(row) {
    row.status = row.interrupted ? 'interrupted' : row.source_done && row.response_done && row.audio_done ? 'final' : 'pending';
    onSegment({ ...row });
  }
  function sync(item) {
    if (!item.sourceId) return;
    const row = source(item.sourceId);
    row.translation_item_id = item.id;
    row.response_id = item.responseId;
    row.target_text = item.text;
    row.response_done = item.responseDone;
    row.audio_done = item.audioDone;
    row.interrupted ||= item.interrupted;
    if (item.audio.length) {
      for (const bytes of item.audio) onAudio(row.segment_key, bytes);
      item.audio = [];
    }
    publish(row);
  }
  function link(itemId, sourceId) {
    const item = translation(itemId);
    if (item.sourceId && item.sourceId !== sourceId) throw new Error('译文消息关联到不同原文，已停止以保护记录');
    item.sourceId = sourceId;
    sync(item);
  }
  function setResponse(itemId, responseId) {
    const item = translation(itemId);
    item.responseId = responseId || item.responseId;
    if (responseId) {
      if (!responseItems.has(responseId)) responseItems.set(responseId, new Set());
      responseItems.get(responseId).add(itemId);
    }
    return item;
  }
  function contentText(content = []) {
    return content.map(part => part.text ?? part.transcript ?? '').join('');
  }
  function accept(event) {
    if (event.event_id) {
      if (seen.has(event.event_id)) return;
      seen.add(event.event_id);
      if (seen.size > 20000) {
        let remaining = 1000;
        for (const key of seen) { seen.delete(key); if (--remaining === 0) break; }
      }
    }
    counts[event.type] = (counts[event.type] || 0) + 1;
    switch (event.type) {
      case 'input_audio_buffer.speech_started': {
        const row = source(event.item_id);
        row.start_ms = event.audio_start_ms ?? row.start_ms;
        row.speaker_id = event.speaker_id ?? row.speaker_id;
        publish(row);
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        const row = source(event.item_id);
        row.end_ms = event.audio_end_ms ?? row.end_ms;
        publish(row);
        break;
      }
      case 'conversation.item.created': {
        const item = event.item;
        if (!item?.id) break;
        if (item.content?.some(part => part.type === 'input_audio') || sources.has(item.id)) {
          source(item.id);
        } else if (event.previous_item_id) {
          link(item.id, event.previous_item_id);
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.delta': {
        const row = source(event.item_id);
        row.source_text += event.delta || '';
        publish(row);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const row = source(event.item_id);
        row.source_text = event.transcript ?? row.source_text;
        row.source_done = true;
        publish(row);
        break;
      }
      case 'response.output_item.added': {
        if (event.item?.id) setResponse(event.item.id, event.response_id);
        break;
      }
      case 'response.text.delta':
      case 'response.audio_transcript.delta': {
        const item = setResponse(event.item_id, event.response_id);
        item.text += event.delta || '';
        sync(item);
        break;
      }
      case 'response.text.done':
      case 'response.audio_transcript.done': {
        const item = setResponse(event.item_id, event.response_id);
        item.text = event.text ?? event.transcript ?? item.text;
        sync(item);
        break;
      }
      case 'response.audio.delta': {
        const item = setResponse(event.item_id, event.response_id);
        const bytes = Buffer.from(event.delta || '', 'base64');
        if (bytes.length % 2) throw new Error('模型返回了不完整的16-bit PCM音频帧');
        if (item.sourceId) onAudio(item.sourceId, bytes);
        else {
          item.audio.push(bytes);
          if (item.audio.reduce((sum, part) => sum + part.length, 0) > 1024 * 1024) throw new Error('未关联的译音超过缓冲限制');
        }
        break;
      }
      case 'response.audio.done': {
        const item = setResponse(event.item_id, event.response_id);
        item.audioDone = true;
        sync(item);
        break;
      }
      case 'response.output_item.done': {
        if (!event.item?.id) break;
        const item = setResponse(event.item.id, event.response_id);
        const text = contentText(event.item.content);
        if (text) item.text = text;
        sync(item);
        break;
      }
      case 'response.done': {
        const response = event.response || {};
        for (const output of Array.isArray(response.output) ? response.output : []) {
          const item = setResponse(output.id, response.id);
          const text = contentText(output.content);
          if (text) item.text = text;
        }
        for (const itemId of responseItems.get(response.id) || []) {
          const item = translation(itemId);
          item.responseDone = true;
          item.interrupted = response.status !== 'completed';
          sync(item);
        }
        onUsage({ response_id: response.id, status: response.status, usage: response.usage || {} });
        if (response.status !== 'completed') onWarning('模型响应未完整完成：' + response.status);
        break;
      }
      case 'conversation.item.input_audio_transcription.failed': {
        const row = source(event.item_id);
        row.interrupted = true;
        publish(row);
        onWarning(event.error?.message || '原文识别失败，已保留收到的内容');
        break;
      }
      case 'session.finished':
        finalize();
        break;
    }
  }
  function finalize() {
    for (const item of translations.values()) {
      if (!item.sourceId && (item.text || item.audio.length)) {
        item.sourceId = 'unlinked:' + item.id;
        const row = source(item.sourceId);
        row.interrupted = true;
        onWarning('一段译文未获得原文关联，已单独保留');
        sync(item);
      }
    }
    for (const row of sources.values()) {
      if (!(row.source_done && row.response_done && row.audio_done)) row.interrupted = true;
      publish(row);
    }
  }
  return { accept, finalize, rows: () => [...sources.values()].map(row => ({ ...row })), counts };
}
module.exports = { createSegmentAssembler };
