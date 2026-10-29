const assert = require('node:assert/strict');
const test = require('node:test');

const { createSegmentAssembler } = require('../electron/segments.js');

test('reconciles out-of-order source, translation, and padded audio events into one final segment', () => {
  const published = [];
  const audio = [];
  const assembler = createSegmentAssembler({
    audioEnabled: true,
    onSegment: row => published.push(row),
    onAudio: (key, bytes) => audio.push({ key, bytes }),
  });

  const paddedFirstChunk = Buffer.from([1, 0]).toString('base64');
  assert.match(paddedFirstChunk, /=+$/);

  assembler.accept({
    event_id: 'output-added',
    type: 'response.output_item.added',
    response_id: 'response-1',
    item: { id: 'translation-1' },
  });
  assembler.accept({
    event_id: 'audio-before-link',
    type: 'response.audio.delta',
    response_id: 'response-1',
    item_id: 'translation-1',
    delta: paddedFirstChunk,
  });
  assembler.accept({
    event_id: 'target-delta',
    type: 'response.audio_transcript.delta',
    response_id: 'response-1',
    item_id: 'translation-1',
    delta: 'hello ',
  });
  assembler.accept({
    event_id: 'target-delta',
    type: 'response.audio_transcript.delta',
    response_id: 'response-1',
    item_id: 'translation-1',
    delta: 'hello ',
  });

  assembler.accept({
    event_id: 'source-started',
    type: 'input_audio_buffer.speech_started',
    item_id: 'source-1',
    audio_start_ms: 100,
    speaker_id: 'speaker-a',
  });
  assembler.accept({
    event_id: 'translation-linked',
    type: 'conversation.item.created',
    previous_item_id: 'source-1',
    item: { id: 'translation-1', type: 'message', content: [{ type: 'audio' }] },
  });
  assembler.accept({
    event_id: 'audio-after-link',
    type: 'response.audio.delta',
    response_id: 'response-1',
    item_id: 'translation-1',
    delta: Buffer.from([2, 0]).toString('base64'),
  });
  assembler.accept({
    event_id: 'response-done',
    type: 'response.done',
    response: {
      id: 'response-1',
      status: 'completed',
      output: [{ id: 'translation-1', content: [{ type: 'audio', transcript: 'hello world' }] }],
    },
  });
  assembler.accept({
    event_id: 'source-completed',
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'source-1',
    transcript: 'original sentence',
  });
  assembler.accept({
    event_id: 'audio-done',
    type: 'response.audio.done',
    response_id: 'response-1',
    item_id: 'translation-1',
  });

  const rows = assembler.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    segment_key: 'source-1',
    source_item_id: 'source-1',
    translation_item_id: 'translation-1',
    response_id: 'response-1',
    sequence_order: 0,
    speaker_id: 'speaker-a',
    start_ms: 100,
    end_ms: null,
    source_text: 'original sentence',
    target_text: 'hello world',
    source_done: true,
    response_done: true,
    audio_done: true,
    interrupted: false,
    status: 'final',
  });
  assert.deepEqual(audio.map(({ key, bytes }) => [key, [...bytes]]), [
    ['source-1', [1, 0]],
    ['source-1', [2, 0]],
  ]);
  assert.equal(published.at(-1).status, 'final');
  assert.equal(assembler.counts['response.audio_transcript.delta'], 1);
});

test('marks a non-completed response interrupted without creating a second source segment', () => {
  const warnings = [];
  const assembler = createSegmentAssembler({ onWarning: message => warnings.push(message) });

  assembler.accept({ type: 'input_audio_buffer.speech_started', item_id: 'source-a', speaker_id: 3 });
  assembler.accept({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source-a', transcript: 'one' });
  assembler.accept({ type: 'response.output_item.added', response_id: 'response-a', item: { id: 'target-a' } });
  assembler.accept({ type: 'conversation.item.created', previous_item_id: 'source-a', item: { id: 'target-a', type: 'message' } });
  assembler.accept({
    type: 'response.done',
    response: { id: 'response-a', status: 'cancelled', output: [{ id: 'target-a', content: [{ type: 'text', text: 'one translated' }] }] },
  });

  const [row] = assembler.rows();
  assert.equal(assembler.rows().length, 1);
  assert.equal(row.speaker_id, 3);
  assert.equal(row.target_text, 'one translated');
  assert.equal(row.status, 'interrupted');
  assert.equal(row.interrupted, true);
  assert.equal(warnings.length, 1);
});
