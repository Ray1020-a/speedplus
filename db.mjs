import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'speedplus.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS assets (
  kind    TEXT NOT NULL,            -- car | map | character
  id      TEXT NOT NULL,
  name    TEXT NOT NULL,
  file    TEXT,                     -- relative to models/<kind>s, NULL for procedural characters
  config  TEXT NOT NULL DEFAULT '{}',
  sort    INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS records (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id  TEXT NOT NULL,
  car_id  TEXT NOT NULL,
  mode    TEXT NOT NULL,            -- lap (laps in 10 min, higher=better) | time (total ms, lower=better)
  score   REAL NOT NULL,
  best_lap_ms INTEGER,
  player  TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records ON records (map_id, mode, score);
`);

const parse = (r) => r && { ...r, config: JSON.parse(r.config || '{}') };

export const assets = {
  list: (kind) => db.prepare('SELECT * FROM assets WHERE kind=? ORDER BY sort, name').all(kind).map(parse),
  get: (kind, id) => parse(db.prepare('SELECT * FROM assets WHERE kind=? AND id=?').get(kind, id)),
  byFile: (kind, file) => parse(db.prepare('SELECT * FROM assets WHERE kind=? AND file=?').get(kind, file)),
  upsert: (kind, id, name, file, config, sort = 0) =>
    db.prepare(`INSERT INTO assets (kind,id,name,file,config,sort,updated) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET name=excluded.name, file=excluded.file, config=excluded.config, updated=excluded.updated`)
      .run(kind, id, name, file, JSON.stringify(config), sort, Date.now()),
  setConfig: (kind, id, config, name) =>
    db.prepare('UPDATE assets SET config=?, name=COALESCE(?,name), updated=? WHERE kind=? AND id=?')
      .run(JSON.stringify(config), name ?? null, Date.now(), kind, id),
  remove: (kind, id) => db.prepare('DELETE FROM assets WHERE kind=? AND id=?').run(kind, id),
};

const better = (mode) => (mode === 'time' ? 'ASC' : 'DESC');

export const records = {
  top: (mapId, mode, limit = 20) =>
    db.prepare(`SELECT id,car_id,score,best_lap_ms,player,created FROM records WHERE map_id=? AND mode=? ORDER BY score ${better(mode)}, created LIMIT ?`)
      .all(mapId, mode, limit),
  best: (mapId, mode) => records.top(mapId, mode, 1)[0] || null,
  // true when the score would take 1st place (or the board is empty)
  isRecord: (mapId, mode, score) => {
    const b = records.best(mapId, mode);
    return !b || (mode === 'time' ? score < b.score : score > b.score);
  },
  add: (r) =>
    db.prepare('INSERT INTO records (map_id,car_id,mode,score,best_lap_ms,player,created) VALUES (?,?,?,?,?,?,?)')
      .run(r.map_id, r.car_id, r.mode, r.score, r.best_lap_ms ?? null, r.player, Date.now()),
};
