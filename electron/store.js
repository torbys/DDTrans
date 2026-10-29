const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 3;
const SEGMENT_STATUSES = new Set(['pending', 'final', 'interrupted']);
const SESSION_FINISH_STATUSES = new Set(['completed', 'interrupted', 'failed']);
const SEGMENT_FIELDS = [
  'item_id',
  'source_item_id',
  'translation_item_id',
  'response_id',
  'speaker_id',
  'source_text',
  'target_text',
  'start_ms',
  'end_ms',
  'status',
  'sequence_order',
  'raw_audio_path',
  'tts_audio_path',
  'raw_duration_ms',
  'tts_duration_ms',
];

function createStore({ dbPath, mediaDir }) {
  if (typeof dbPath !== 'string' || !dbPath) {
    throw new TypeError('dbPath is required');
  }
  if (typeof mediaDir !== 'string' || !mediaDir) {
    throw new TypeError('mediaDir is required');
  }

  const resolvedDbPath = path.resolve(dbPath);
  const resolvedMediaDir = path.resolve(mediaDir);
  fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
  fs.mkdirSync(resolvedMediaDir, { recursive: true });

  const db = new DatabaseSync(resolvedDbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    migrate();
    interruptAbandonedSessions();
  } catch (error) {
    db.close();
    throw error;
  }

  function migrate() {
    const hasSchemaMeta = tableExists('schema_meta');
    const schemaVersion = hasSchemaMeta ? readSchemaVersion() : null;
    if (schemaVersion != null && schemaVersion > SCHEMA_VERSION) {
      throw new Error(`database schema version ${schemaVersion} is newer than supported version ${SCHEMA_VERSION}`);
    }
    const legacySegmentsWithoutStatus = tableExists('segments') && !tableColumns('segments').has('status');
    const legacySessionsWithoutStatus = tableExists('sessions') && !tableColumns('sessions').has('status');
    if (!hasSchemaMeta && hasLegacyRows()) {
      const backupPath = `${resolvedDbPath}.pre-node-store.sqlite`;
      if (!fs.existsSync(backupPath)) {
        db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
      }
    }

    transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          source_lang TEXT,
          target_lang TEXT,
          started_at TEXT,
          ended_at TEXT,
          duration_seconds INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          status TEXT NOT NULL DEFAULT 'completed',
          model TEXT,
          transport TEXT,
          config_json TEXT NOT NULL DEFAULT '{}',
          accepted_config_json TEXT NOT NULL DEFAULT '{}',
          metrics_json TEXT NOT NULL DEFAULT '{}',
          usage_json TEXT NOT NULL DEFAULT '[]',
          event_counts_json TEXT NOT NULL DEFAULT '{}',
          raw_audio_path TEXT,
          source_detected TEXT,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS segments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          segment_key TEXT,
          item_id TEXT,
          source_item_id TEXT,
          translation_item_id TEXT,
          response_id TEXT,
          speaker_id TEXT,
          source_text TEXT,
          target_text TEXT,
          start_ms INTEGER,
          end_ms INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          sequence_order INTEGER NOT NULL DEFAULT 0,
          raw_audio_path TEXT,
          tts_audio_path TEXT,
          raw_duration_ms INTEGER NOT NULL DEFAULT 0,
          tts_duration_ms INTEGER NOT NULL DEFAULT 0,
          raw_audio_wav BLOB,
          tts_audio_wav BLOB,
          raw_audio_duration_ms INTEGER DEFAULT 0,
          tts_audio_duration_ms INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
      `);

      ensureColumns('sessions', {
        status: "TEXT NOT NULL DEFAULT 'completed'",
        model: 'TEXT',
        transport: 'TEXT',
        config_json: "TEXT NOT NULL DEFAULT '{}'",
        accepted_config_json: "TEXT NOT NULL DEFAULT '{}'",
        metrics_json: "TEXT NOT NULL DEFAULT '{}'",
        usage_json: "TEXT NOT NULL DEFAULT '[]'",
        event_counts_json: "TEXT NOT NULL DEFAULT '{}'",
        raw_audio_path: 'TEXT',
        source_detected: 'TEXT',
        error: 'TEXT',
      });
      ensureColumns('segments', {
        segment_key: 'TEXT',
        source_item_id: 'TEXT',
        translation_item_id: 'TEXT',
        response_id: 'TEXT',
        speaker_id: 'TEXT',
        start_ms: 'INTEGER',
        end_ms: 'INTEGER',
        status: "TEXT NOT NULL DEFAULT 'pending'",
        raw_audio_path: 'TEXT',
        tts_audio_path: 'TEXT',
        raw_duration_ms: 'INTEGER NOT NULL DEFAULT 0',
        tts_duration_ms: 'INTEGER NOT NULL DEFAULT 0',
        updated_at: 'TEXT',
      });
      ensureColumns('notes', { updated_at: 'TEXT' });

      db.prepare("UPDATE sessions SET status = CASE WHEN ended_at IS NULL OR ended_at = '' THEN 'interrupted' ELSE 'completed' END WHERE status IS NULL OR status = ''").run();
      db.prepare("UPDATE sessions SET config_json = '{}' WHERE config_json IS NULL OR config_json = ''").run();
      db.prepare("UPDATE sessions SET accepted_config_json = '{}' WHERE accepted_config_json IS NULL OR accepted_config_json = ''").run();
      db.prepare("UPDATE sessions SET metrics_json = '{}' WHERE metrics_json IS NULL OR metrics_json = ''").run();
      db.prepare("UPDATE sessions SET usage_json = '[]' WHERE usage_json IS NULL OR usage_json = ''").run();
      db.prepare("UPDATE sessions SET event_counts_json = '{}' WHERE event_counts_json IS NULL OR event_counts_json = ''").run();
      db.prepare('UPDATE segments SET raw_duration_ms = COALESCE(NULLIF(raw_duration_ms, 0), raw_audio_duration_ms, 0)').run();
      db.prepare('UPDATE segments SET tts_duration_ms = COALESCE(NULLIF(tts_duration_ms, 0), tts_audio_duration_ms, 0)').run();
      if (legacySegmentsWithoutStatus) {
        db.prepare(`
          UPDATE segments
          SET status = CASE
            WHEN COALESCE(TRIM(source_text), '') <> '' AND COALESCE(TRIM(target_text), '') <> '' THEN 'final'
            ELSE 'interrupted'
          END
        `).run();
      } else {
        db.prepare("UPDATE segments SET status = 'final' WHERE status IS NULL OR status = ''").run();
      }
      if (legacySessionsWithoutStatus) {
        db.exec(`
          UPDATE sessions SET status = CASE
            WHEN ended_at IS NULL OR ended_at = '' OR EXISTS (
              SELECT 1 FROM segments WHERE segments.session_id = sessions.id AND segments.status <> 'final'
            ) THEN 'interrupted' ELSE 'completed' END
        `);
      }
      db.prepare('UPDATE segments SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL').run();
      db.prepare('UPDATE notes SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL').run();
      populateLegacySegmentKeys();

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_session_key ON segments(session_id, segment_key);
        CREATE INDEX IF NOT EXISTS idx_segments_session_order ON segments(session_id, sequence_order, id);
        CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id, id);
        CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
      `);
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
    });
  }

  function tableExists(name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  function readSchemaVersion() {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    if (!row) return null;
    const version = Number(row.value);
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`invalid database schema version: ${row.value}`);
    }
    return version;
  }

  function tableColumns(table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  }

  function hasLegacyRows() {
    for (const table of ['sessions', 'segments', 'notes']) {
      if (tableExists(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
        return true;
      }
    }
    return false;
  }

  function ensureColumns(table, columns) {
    const existing = tableColumns(table);
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  function populateLegacySegmentKeys() {
    const rows = db.prepare('SELECT id, session_id, item_id, segment_key FROM segments ORDER BY id').all();
    const used = new Set();
    const update = db.prepare('UPDATE segments SET segment_key = ? WHERE id = ?');
    for (const row of rows) {
      const base = typeof row.item_id === 'string' && row.item_id.trim() ? row.item_id : `legacy:${row.id}`;
      let key = row.segment_key || base;
      let suffix = 1;
      while (used.has(`${row.session_id}\u0000${key}`)) {
        key = `${base}:${row.id}:${suffix++}`;
      }
      used.add(`${row.session_id}\u0000${key}`);
      if (row.segment_key !== key) {
        update.run(key, row.id);
      }
    }
  }

  function interruptAbandonedSessions() {
    const now = nowIso();
    transaction(() => {
      db.prepare(`
        UPDATE segments
        SET status = 'interrupted', updated_at = ?
        WHERE status = 'pending'
          AND session_id IN (SELECT id FROM sessions WHERE status = 'running')
      `).run(now);
      db.prepare(`
        UPDATE sessions
        SET status = 'interrupted',
            ended_at = COALESCE(NULLIF(ended_at, ''), ?),
            duration_seconds = COALESCE(MAX(0, CAST((julianday(COALESCE(NULLIF(ended_at, ''), ?)) - julianday(started_at)) * 86400 AS INTEGER)), 0),
            error = COALESCE(NULLIF(error, ''), 'Interrupted after previous shutdown')
        WHERE status = 'running'
      `).run(now, now);
    });
  }

  function createSession({ name, source_lang = null, target_lang = null, model = null, transport = null, config = {} } = {}) {
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO sessions (name, source_lang, target_lang, started_at, created_at, status, model, transport, config_json)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(requiredText(name, 'name'), nullableText(source_lang), nullableText(target_lang), now, now, nullableText(model), nullableText(transport), toJson(config));
    return getSession(Number(result.lastInsertRowid));
  }

  function upsertSegment(sessionId, segment) {
    const id = positiveInteger(sessionId, 'sessionId');
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
      throw new TypeError('segment must be an object');
    }
    const segmentKey = deriveSegmentKey(segment);
    const existing = db.prepare('SELECT id FROM segments WHERE session_id = ? AND segment_key = ?').get(id, segmentKey);
    const now = nowIso();
    const values = segmentValues(segment);

    if (!existing) {
      const fields = ['session_id', 'segment_key', 'created_at', 'updated_at'];
      const params = [id, segmentKey, now, now];
      for (const field of SEGMENT_FIELDS) {
        if (Object.hasOwn(values, field)) {
          fields.push(field);
          params.push(values[field]);
        }
      }
      if (!Object.hasOwn(values, 'status')) {
        fields.push('status');
        params.push('pending');
      }
      const placeholders = fields.map(() => '?').join(', ');
      const result = db.prepare(`INSERT INTO segments (${fields.join(', ')}) VALUES (${placeholders})`).run(...params);
      return getSegment(Number(result.lastInsertRowid));
    }

    const fields = [];
    const params = [];
    for (const field of SEGMENT_FIELDS) {
      if (Object.hasOwn(values, field)) {
        fields.push(`${field} = ?`);
        params.push(values[field]);
      }
    }
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now, existing.id);
      db.prepare(`UPDATE segments SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    }
    return getSegment(existing.id);
  }

  function segmentValues(segment) {
    const values = {};
    for (const field of SEGMENT_FIELDS) {
      if (!Object.hasOwn(segment, field)) continue;
      const value = segment[field];
      if (field === 'status') {
        if (!SEGMENT_STATUSES.has(value)) {
          throw new RangeError(`invalid segment status: ${value}`);
        }
        values[field] = value;
      } else if (field === 'raw_audio_path' || field === 'tts_audio_path') {
        values[field] = normalizeMediaPath(value);
      } else if (['start_ms', 'end_ms', 'sequence_order', 'raw_duration_ms', 'tts_duration_ms'].includes(field)) {
        values[field] = nullableInteger(value, field);
      } else if (field === 'speaker_id') {
        values[field] = nullableSpeakerId(value);
      } else {
        values[field] = nullableText(value);
      }
    }
    return values;
  }

  function deriveSegmentKey(segment) {
    const value = segment.segment_key ?? segment.item_id ?? segment.source_item_id ?? segment.translation_item_id;
    return requiredText(value, 'segment.segment_key');
  }

  function getSession(id) {
    return normalizeSession(db.prepare(`
      SELECT id, name, source_lang, target_lang, started_at, ended_at, duration_seconds, created_at,
             status, model, transport, config_json, accepted_config_json, metrics_json, usage_json, event_counts_json,
             raw_audio_path, source_detected, error,
             CASE WHEN raw_audio_path IS NOT NULL AND raw_audio_path <> '' THEN 1 ELSE 0 END AS has_raw_audio
      FROM sessions WHERE id = ?
    `).get(positiveInteger(id, 'id')));
  }

  function getSegments(sessionId) {
    return db.prepare(`${segmentSelect()} WHERE session_id = ? ORDER BY sequence_order ASC, id ASC`).all(positiveInteger(sessionId, 'sessionId')).map(normalizeSegment);
  }

  function getSegment(id) {
    return normalizeSegment(db.prepare(`${segmentSelect()} WHERE id = ?`).get(positiveInteger(id, 'id')));
  }

  function segmentSelect() {
    return `
      SELECT id, session_id, segment_key, item_id, source_item_id, translation_item_id, response_id, speaker_id,
             source_text, target_text, start_ms, end_ms, status, sequence_order, raw_audio_path, tts_audio_path,
             raw_duration_ms, tts_duration_ms, created_at, updated_at,
             CASE WHEN (raw_audio_path IS NOT NULL AND raw_audio_path <> '') OR raw_audio_wav IS NOT NULL THEN 1 ELSE 0 END AS has_raw_audio,
             CASE WHEN (tts_audio_path IS NOT NULL AND tts_audio_path <> '') OR tts_audio_wav IS NOT NULL THEN 1 ELSE 0 END AS has_tts_audio
      FROM segments
    `;
  }

  function getSegmentAudio(id, type) {
    if (type !== 'raw' && type !== 'tts') {
      throw new RangeError('type must be raw or tts');
    }
    const row = db.prepare(`
      SELECT ${type}_audio_path AS audio_path, ${type}_audio_wav AS audio_blob, start_ms, end_ms
      FROM segments WHERE id = ?
    `).get(positiveInteger(id, 'id'));
    if (!row) return null;
    const audioPath = storedMediaPath(row.audio_path);
    if (audioPath) {
      return { path: audioPath, start_ms: row.start_ms, end_ms: row.end_ms };
    }
    return row.audio_blob == null ? null : { data: Buffer.from(row.audio_blob) };
  }

  function listSessions({ limit = 50, offset = 0, search = '', sort = 'newest' } = {}) {
    const safeLimit = boundedInteger(limit, 'limit', 1, 1000);
    const safeOffset = boundedInteger(offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const orderBy = {
      newest: 'COALESCE(ended_at, started_at, created_at) DESC, id DESC',
      oldest: 'COALESCE(started_at, created_at) ASC, id ASC',
      name: 'name COLLATE NOCASE ASC, id ASC',
    }[sort];
    if (!orderBy) throw new RangeError('sort must be newest, oldest, or name');
    const searchText = typeof search === 'string' ? search : String(search);
    const like = `%${searchText.replace(/[\\%_]/g, '\\$&')}%`;
    const where = "WHERE name LIKE ? ESCAPE '\\'";
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM sessions ${where}`).get(like).count);
    const sessions = db.prepare(`
      SELECT id, name, source_lang, target_lang, started_at, ended_at, duration_seconds, created_at,
             status, model, transport, config_json, accepted_config_json, metrics_json, usage_json, event_counts_json,
             raw_audio_path, source_detected, error,
             CASE WHEN raw_audio_path IS NOT NULL AND raw_audio_path <> '' THEN 1 ELSE 0 END AS has_raw_audio
      FROM sessions ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `).all(like, safeLimit, safeOffset).map(normalizeSession);
    return { sessions, total, limit: safeLimit, offset: safeOffset };
  }

  function updateSession(id, { name } = {}) {
    const sessionId = positiveInteger(id, 'id');
    if (!Object.hasOwn(arguments[1] || {}, 'name')) {
      throw new TypeError('name is required');
    }
    db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(requiredText(name, 'name'), sessionId);
    return getSession(sessionId);
  }

  function updateSessionTelemetry(id, telemetry = {}) {
    const sessionId = positiveInteger(id, 'id');
    if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)) {
      throw new TypeError('telemetry must be an object');
    }
    const fields = [];
    const params = [];
    for (const [input, column] of Object.entries({
      accepted_config: 'accepted_config_json',
      metrics: 'metrics_json',
      usage: 'usage_json',
      event_counts: 'event_counts_json',
    })) {
      if (Object.hasOwn(telemetry, input)) {
        fields.push(`${column} = ?`);
        params.push(toJson(telemetry[input]));
      }
    }
    if (!fields.length) return getSession(sessionId);
    params.push(sessionId);
    db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return getSession(sessionId);
  }

  function finishSession(id, status = 'completed', error = null) {
    const sessionId = positiveInteger(id, 'id');
    if (!SESSION_FINISH_STATUSES.has(status)) {
      throw new RangeError('status must be completed, interrupted, or failed');
    }
    const now = nowIso();
    db.prepare(`
      UPDATE sessions
      SET status = ?, error = ?, ended_at = ?,
          duration_seconds = COALESCE(MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400 AS INTEGER)), 0)
      WHERE id = ? AND status = 'running'
    `).run(status, error == null ? null : String(error), now, now, sessionId);
    return getSession(sessionId);
  }

  function setSessionAudio(id, relativePath) {
    const sessionId = positiveInteger(id, 'id');
    db.prepare('UPDATE sessions SET raw_audio_path = ? WHERE id = ?').run(normalizeMediaPath(relativePath), sessionId);
    return getSession(sessionId);
  }

  function saveNote(sessionId, content, noteId) {
    const parentId = positiveInteger(sessionId, 'sessionId');
    const noteContent = requiredText(content, 'content');
    const now = nowIso();
    if (noteId == null) {
      const result = db.prepare('INSERT INTO notes (session_id, content, created_at, updated_at) VALUES (?, ?, ?, ?)').run(parentId, noteContent, now, now);
      return getNote(Number(result.lastInsertRowid));
    }
    const targetId = positiveInteger(noteId, 'noteId');
    const result = db.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ? AND session_id = ?').run(noteContent, now, targetId, parentId);
    return result.changes > 0 ? getNote(targetId) : null;
  }

  function getNotes(sessionId) {
    return db.prepare('SELECT id, session_id, content, created_at, updated_at FROM notes WHERE session_id = ? ORDER BY created_at ASC, id ASC').all(positiveInteger(sessionId, 'sessionId'));
  }

  function getNote(id) {
    return db.prepare('SELECT id, session_id, content, created_at, updated_at FROM notes WHERE id = ?').get(id) || null;
  }

  function deleteNote(sessionId, noteId) {
    const result = db.prepare('DELETE FROM notes WHERE id = ? AND session_id = ?').run(positiveInteger(noteId, 'noteId'), positiveInteger(sessionId, 'sessionId'));
    return result.changes > 0;
  }

  function deleteSession(id) {
    const sessionId = positiveInteger(id, 'id');
    const mediaPaths = transaction(() => {
      const session = db.prepare('SELECT raw_audio_path FROM sessions WHERE id = ?').get(sessionId);
      if (!session) return null;
      const segments = db.prepare('SELECT raw_audio_path, tts_audio_path FROM segments WHERE session_id = ?').all(sessionId);
      const paths = [session.raw_audio_path, ...segments.flatMap((segment) => [segment.raw_audio_path, segment.tts_audio_path])];
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      return paths;
    });
    if (!mediaPaths) return false;
    for (const mediaPath of new Set(mediaPaths.map(storedMediaPath).filter(Boolean))) {
      if (!mediaPathInUse(mediaPath)) removeOwnedMedia(mediaPath);
    }
    return true;
  }

  function mediaPathInUse(mediaPath) {
    const session = db.prepare('SELECT 1 FROM sessions WHERE raw_audio_path = ? LIMIT 1').get(mediaPath);
    const segment = db.prepare('SELECT 1 FROM segments WHERE raw_audio_path = ? OR tts_audio_path = ? LIMIT 1').get(mediaPath, mediaPath);
    return Boolean(session || segment);
  }

  function removeOwnedMedia(mediaPath) {
    const fullPath = path.resolve(resolvedMediaDir, mediaPath);
    if (!isInsideMediaDir(fullPath)) return;
    try {
      if (fs.lstatSync(fullPath).isFile() || fs.lstatSync(fullPath).isSymbolicLink()) {
        fs.unlinkSync(fullPath);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function normalizeMediaPath(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') throw new TypeError('media path must be a string');
    if (path.isAbsolute(value)) throw new RangeError('media path must be relative to mediaDir');
    const fullPath = path.resolve(resolvedMediaDir, value);
    if (!isInsideMediaDir(fullPath)) throw new RangeError('media path must stay inside mediaDir');
    return path.relative(resolvedMediaDir, fullPath).split(path.sep).join('/');
  }

  function storedMediaPath(value) {
    try {
      return normalizeMediaPath(value);
    } catch {
      return null;
    }
  }

  function isInsideMediaDir(fullPath) {
    const relative = path.relative(resolvedMediaDir, fullPath);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    createSession,
    upsertSegment,
    getSession,
    getSegments,
    getSegment,
    getSegmentAudio,
    listSessions,
    updateSession,
    updateSessionTelemetry,
    finishSession,
    setSessionAudio,
    saveNote,
    getNotes,
    deleteNote,
    deleteSession,
    close: () => db.close(),
  };
}

function normalizeSession(row) {
  return row ? { ...row, has_raw_audio: Boolean(row.has_raw_audio) } : null;
}

function normalizeSegment(row) {
  return row ? { ...row, has_raw_audio: Boolean(row.has_raw_audio), has_tts_audio: Boolean(row.has_tts_audio) } : null;
}

function nowIso() {
  return new Date().toISOString();
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function nullableText(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new TypeError('text value must be a string');
  return value;
}

function nullableSpeakerId(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value;
  throw new TypeError('speaker_id must be a finite number or string');
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nullableInteger(value, name) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be an integer`);
  return value;
}

function boundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} is out of range`);
  return value;
}

function toJson(value) {
  const json = JSON.stringify(value == null ? {} : value);
  if (json == null) throw new TypeError('config must be JSON serializable');
  return json;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

module.exports = { createStore };
