const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createStore } = require('../electron/store.js');

function temporaryStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddtrans-store-'));
  return {
    root,
    dbPath: path.join(root, 'translation.db'),
    mediaDir: path.join(root, 'media'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function createLegacyDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source_lang TEXT,
      target_lang TEXT,
      started_at TIMESTAMP,
      ended_at TIMESTAMP,
      duration_seconds INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      item_id TEXT,
      source_text TEXT,
      target_text TEXT,
      raw_audio_wav BLOB,
      tts_audio_wav BLOB,
      raw_audio_duration_ms INTEGER DEFAULT 0,
      tts_audio_duration_ms INTEGER DEFAULT 0,
      sequence_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
  const session = db.prepare("INSERT INTO sessions (name, source_lang, target_lang, started_at, ended_at, duration_seconds) VALUES ('legacy', 'en', 'zh', '2026-01-01 10:00:00', '2026-01-01 10:00:08', 8)").run();
  db.prepare('INSERT INTO segments (session_id, item_id, source_text, raw_audio_wav, raw_audio_duration_ms, sequence_order) VALUES (?, ?, ?, ?, ?, ?)').run(
    Number(session.lastInsertRowid), 'legacy-item', 'legacy source', Buffer.from([1, 2, 3]), 120, 0
  );
  db.prepare('INSERT INTO notes (session_id, content) VALUES (?, ?)').run(Number(session.lastInsertRowid), 'legacy note');
  db.close();
}

test('migrates legacy data with a VACUUM backup and never returns BLOB metadata', (t) => {
  const { dbPath, mediaDir, cleanup } = temporaryStore(t);
  createLegacyDatabase(dbPath);
  const store = createStore({ dbPath, mediaDir });
  t.after(() => store.close());
  t.after(cleanup);

  const backup = `${dbPath}.pre-node-store.sqlite`;
  assert.ok(fs.existsSync(backup));
  const backupDb = new DatabaseSync(backup, { readOnly: true });
  assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM segments').get().count, 1);
  backupDb.close();

  const session = store.getSession(1);
  assert.equal(session.status, 'interrupted');
  const [segment] = store.getSegments(1);
  assert.equal(segment.segment_key, 'legacy-item');
  assert.equal(segment.raw_duration_ms, 120);
  assert.equal(segment.status, 'interrupted');
  assert.notEqual(segment.status, 'pending');
  assert.equal(segment.has_raw_audio, true);
  assert.equal('raw_audio_wav' in segment, false);
  assert.equal(JSON.stringify(segment).includes('AQID'), false);
  assert.deepEqual(store.getSegmentAudio(segment.id, 'raw').data, Buffer.from([1, 2, 3]));
  assert.equal(store.getNotes(1)[0].content, 'legacy note');
});

test('refuses a database schema newer than this store supports', (t) => {
  const { dbPath, mediaDir, cleanup } = temporaryStore(t);
  const store = createStore({ dbPath, mediaDir });
  store.close();
  t.after(cleanup);
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE schema_meta SET value = '999' WHERE key = 'schema_version'").run();
  db.close();

  assert.throws(
    () => createStore({ dbPath, mediaDir }),
    /newer than supported version/
  );
});

test('upserts partial segments without freezing final state and separates active sessions', (t) => {
  const { dbPath, mediaDir, cleanup } = temporaryStore(t);
  const firstStore = createStore({ dbPath, mediaDir });
  const secondStore = createStore({ dbPath, mediaDir });
  t.after(() => firstStore.close());
  t.after(() => secondStore.close());
  t.after(cleanup);

  const first = firstStore.createSession({ name: 'first', source_lang: 'en', target_lang: 'zh', model: 'm1', transport: 'ws', config: { voice: true } });
  const second = secondStore.createSession({ name: 'second' });
  firstStore.upsertSegment(first.id, { segment_key: 'turn-1', source_text: 'hello', source_item_id: 'source-1', speaker_id: 1, sequence_order: 3 });
  secondStore.upsertSegment(second.id, { segment_key: 'turn-1', source_text: 'other', status: 'pending' });
  firstStore.upsertSegment(first.id, { segment_key: 'turn-1', target_text: '你好', translation_item_id: 'target-1', status: 'final' });
  firstStore.upsertSegment(first.id, { segment_key: 'turn-1', target_text: '您好', status: 'interrupted' });

  const firstSegments = firstStore.getSegments(first.id);
  assert.equal(firstSegments.length, 1);
  assert.equal(firstSegments[0].source_text, 'hello');
  assert.equal(firstSegments[0].target_text, '您好');
  assert.equal(firstSegments[0].status, 'interrupted');
  assert.equal(firstSegments[0].speaker_id, '1');
  assert.equal(firstSegments[0].item_id, null);
  assert.equal(secondStore.getSegments(second.id)[0].source_text, 'other');
  assert.equal(firstStore.getSession(second.id).name, 'second');
  assert.equal(firstStore.finishSession(first.id).status, 'completed');
  assert.equal(secondStore.getSession(second.id).status, 'running');
});

test('handles CRUD, time accounting, metadata audio, and list paging', (t) => {
  const { dbPath, mediaDir, cleanup } = temporaryStore(t);
  const store = createStore({ dbPath, mediaDir });
  t.after(() => store.close());
  t.after(cleanup);

  const alpha = store.createSession({ name: 'Alpha', config: { source: 'test' } });
  const beta = store.createSession({ name: 'Beta' });
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE sessions SET started_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(alpha.id);
  db.close();

  const rawPath = path.join(mediaDir, 'alpha', 'raw.wav');
  const ttsPath = path.join(mediaDir, 'alpha', 'tts.wav');
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  fs.writeFileSync(rawPath, 'raw');
  fs.writeFileSync(ttsPath, 'tts');
  const segment = store.upsertSegment(alpha.id, {
    segment_key: 'one',
    item_id: 'compat-item',
    start_ms: 4,
    end_ms: 16,
    raw_audio_path: 'alpha/raw.wav',
    tts_audio_path: 'alpha/tts.wav',
    raw_duration_ms: 12,
    tts_duration_ms: 8,
    status: 'final',
  });
  assert.equal(segment.has_raw_audio, true);
  assert.equal(segment.has_tts_audio, true);
  assert.deepEqual(store.getSegmentAudio(segment.id, 'raw'), { path: 'alpha/raw.wav', start_ms: 4, end_ms: 16 });
  assert.equal(store.setSessionAudio(alpha.id, 'alpha/raw.wav').has_raw_audio, true);
  assert.throws(() => store.upsertSegment(alpha.id, { segment_key: 'outside', raw_audio_path: '../outside.wav' }), /mediaDir/);

  const finished = store.finishSession(alpha.id, 'completed');
  assert.ok(finished.duration_seconds > 0);
  const repeatedFinish = store.finishSession(alpha.id, 'failed', 'must not overwrite');
  assert.equal(repeatedFinish.status, 'completed');
  assert.equal(repeatedFinish.ended_at, finished.ended_at);
  assert.equal(repeatedFinish.error, null);
  assert.throws(() => store.finishSession(beta.id, 'running'), /completed, interrupted, or failed/);
  const telemetry = store.updateSessionTelemetry(alpha.id, {
    accepted_config: { accepted: true },
    usage: [{ response_id: 'response-1', usage: { input_tokens: 3 } }],
  });
  assert.equal(telemetry.accepted_config_json, '{"accepted":true}');
  assert.equal(telemetry.metrics_json, '{}');
  assert.equal(telemetry.usage_json, '[{"response_id":"response-1","usage":{"input_tokens":3}}]');
  assert.equal(store.updateSessionTelemetry(alpha.id, { metrics: { latency_ms: 12 } }).accepted_config_json, '{"accepted":true}');
  assert.equal(store.updateSession(beta.id, { name: 'Beta renamed' }).name, 'Beta renamed');
  const note = store.saveNote(alpha.id, 'initial');
  assert.equal(store.saveNote(beta.id, 'cross-session update', note.id), null);
  assert.equal(store.getNotes(alpha.id)[0].content, 'initial');
  assert.equal(store.saveNote(alpha.id, 'edited', note.id).content, 'edited');
  assert.equal(store.getNotes(alpha.id).length, 1);
  assert.equal(store.deleteNote(alpha.id, note.id), true);
  assert.equal(store.getNotes(alpha.id).length, 0);

  assert.deepEqual(store.listSessions({ search: 'beta', sort: 'name', limit: 1, offset: 0 }).sessions.map((row) => row.name), ['Beta renamed']);
  assert.equal(store.listSessions({ limit: 1, offset: 1, sort: 'oldest' }).total, 2);
});

test('interrupts abandoned sessions and only deletes owned, unreferenced media', (t) => {
  const { root, dbPath, mediaDir, cleanup } = temporaryStore(t);
  let store = createStore({ dbPath, mediaDir });
  const abandoned = store.createSession({ name: 'abandoned' });
  const pending = store.upsertSegment(abandoned.id, { segment_key: 'pending' });
  store.close();
  store = createStore({ dbPath, mediaDir });
  t.after(() => store.close());
  t.after(cleanup);
  assert.equal(store.getSession(abandoned.id).status, 'interrupted');
  assert.equal(store.getSegment(pending.id).status, 'interrupted');

  const session = store.createSession({ name: 'delete me' });
  const owned = path.join(mediaDir, 'owned.wav');
  const external = path.join(root, 'external.wav');
  fs.writeFileSync(owned, 'owned');
  fs.writeFileSync(external, 'external');
  const segment = store.upsertSegment(session.id, { segment_key: 'delete', raw_audio_path: 'owned.wav' });
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE segments SET tts_audio_path = ? WHERE id = ?').run(external, segment.id);
  db.close();

  assert.equal(store.deleteSession(session.id), true);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(external), true);
  assert.equal(store.deleteSession(session.id), false);
});
