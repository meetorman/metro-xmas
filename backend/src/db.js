const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const providedPath = process.env.DB_PATH;
const dbPath = providedPath || path.join(__dirname, '..', 'data', 'game.db');

if (dbPath !== ':memory:') {
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  score INTEGER DEFAULT 0,
  photo_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  question_text TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT,
  points INTEGER,
  selected_for_game INTEGER DEFAULT 0,
  used_in_game INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS game_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT DEFAULT 'waiting', -- waiting | active | ended
  current_question_id TEXT,
  current_category TEXT,
  current_points INTEGER,
  current_is_placeholder INTEGER DEFAULT 0,
  current_clue_text TEXT,
  current_answer_text TEXT,
  turn_player_id TEXT,
  buzzer_locked INTEGER DEFAULT 0,
  last_buzz_player_id TEXT,
  last_buzz_time TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS buzz_queue (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  buzz_time TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS sfx_files (
  name TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO game_state (id) VALUES (1)
  ON CONFLICT(id) DO NOTHING;
`);

// Migration: ensure slug column exists on players (and uniqueness enforced via index)
const playerColumns = db
  .prepare(`PRAGMA table_info(players)`)
  .all()
  .map((c) => c.name);
if (!playerColumns.includes('slug')) {
  // SQLite cannot add a UNIQUE column via ALTER; add plain column then create index.
  db.exec(`ALTER TABLE players ADD COLUMN slug TEXT;`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_players_slug ON players(slug);`);

if (!playerColumns.includes('score')) {
  db.exec(`ALTER TABLE players ADD COLUMN score INTEGER DEFAULT 0;`);
}

// Migration: ensure used_in_game exists on questions
const questionColumns = db
  .prepare(`PRAGMA table_info(questions)`)
  .all()
  .map((c) => c.name);
if (!questionColumns.includes('used_in_game')) {
  db.exec(`ALTER TABLE questions ADD COLUMN used_in_game INTEGER DEFAULT 0;`);
}

// Migration: ensure current tile info exists on game_state
const gameColumns = db
  .prepare(`PRAGMA table_info(game_state)`)
  .all()
  .map((c) => c.name);
if (!gameColumns.includes('current_category')) {
  db.exec(`ALTER TABLE game_state ADD COLUMN current_category TEXT;`);
}
if (!gameColumns.includes('current_points')) {
  db.exec(`ALTER TABLE game_state ADD COLUMN current_points INTEGER;`);
}
if (!gameColumns.includes('current_is_placeholder')) {
  db.exec(
    `ALTER TABLE game_state ADD COLUMN current_is_placeholder INTEGER DEFAULT 0;`
  );
}
if (!gameColumns.includes('current_clue_text')) {
  db.exec(`ALTER TABLE game_state ADD COLUMN current_clue_text TEXT;`);
}
if (!gameColumns.includes('current_answer_text')) {
  db.exec(`ALTER TABLE game_state ADD COLUMN current_answer_text TEXT;`);
}
if (!gameColumns.includes('turn_player_id')) {
  db.exec(`ALTER TABLE game_state ADD COLUMN turn_player_id TEXT;`);
}

// Migration: ensure events table exists (older DBs)
db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);
`);

// Migration: ensure buzz_queue table exists (older DBs)
db.exec(`
CREATE TABLE IF NOT EXISTS buzz_queue (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  buzz_time TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);
CREATE INDEX IF NOT EXISTS idx_buzz_queue_time ON buzz_queue(buzz_time);
`);

// Migration: ensure sfx_files table exists (older DBs)
db.exec(`
CREATE TABLE IF NOT EXISTS sfx_files (
  name TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
`);

// Migration: ensure game_history table exists
db.exec(`
CREATE TABLE IF NOT EXISTS game_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_number INTEGER NOT NULL UNIQUE,
  question_set_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_game_history_number ON game_history(game_number);
`);

// Migration: ensure question_usage table exists
db.exec(`
CREATE TABLE IF NOT EXISTS question_usage (
  question_text TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT,
  points INTEGER,
  first_used_in_game INTEGER,
  last_used_in_game INTEGER,
  use_count INTEGER DEFAULT 1,
  PRIMARY KEY (question_text, answer, category, points)
);
CREATE INDEX IF NOT EXISTS idx_question_usage_game ON question_usage(last_used_in_game);
`);

// Migration: ensure question_audio table exists
db.exec(`
CREATE TABLE IF NOT EXISTS question_audio (
  question_id TEXT PRIMARY KEY,
  audio_data BLOB NOT NULL,
  mime TEXT NOT NULL DEFAULT 'audio/mpeg',
  created_at TEXT NOT NULL
);
`);

// Migration: ensure question_reading exists on game_state
const gameStateColumns = db
  .prepare(`PRAGMA table_info(game_state)`)
  .all()
  .map((c) => c.name);
if (!gameStateColumns.includes('question_reading')) {
  db.exec(`ALTER TABLE game_state ADD COLUMN question_reading INTEGER DEFAULT 0;`);
}

// Backfill slugs for any existing players without one
function backfillSlugs() {
  const slugify = (name) =>
    (name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 40) || 'player';

  const playersWithoutSlug = db
    .prepare("SELECT id, name FROM players WHERE slug IS NULL OR slug = ''")
    .all();

  for (const p of playersWithoutSlug) {
    let base = slugify(p.name);
    let slug = base;
    let counter = 1;
    while (
      db
        .prepare('SELECT 1 FROM players WHERE slug = ?')
        .get(slug)
    ) {
      counter += 1;
      slug = `${base}-${counter}`;
    }
    db.prepare('UPDATE players SET slug = ? WHERE id = ?').run(slug, p.id);
  }
}

backfillSlugs();

module.exports = {
  db,
  getGameState,
  updateGameState,
};

function getGameState() {
  return db
    .prepare(
      `SELECT id, status, current_question_id, current_category, current_points, current_is_placeholder,
              current_clue_text, current_answer_text,
              turn_player_id,
              buzzer_locked, last_buzz_player_id, last_buzz_time,
              question_reading
       FROM game_state WHERE id = 1`
    )
    .get();
}

function updateGameState(patch = {}) {
  const entries = Object.entries(patch);
  if (!entries.length) return getGameState();

  const setters = entries.map(([key]) => `${key}=@${key}`).join(', ');
  db.prepare(`UPDATE game_state SET ${setters} WHERE id = 1`).run(patch);
  return getGameState();
}

module.exports = {
  db,
  getGameState,
  updateGameState,
};

