const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const { db, getGameState, updateGameState } = require('./db');
const defaultQuestions = require('./default_questions.json');
let holidayPack2025 = null;
try {
  holidayPack2025 = require('./question_pack_holiday_2025.json');
} catch (e) {
  // If the optional pack file is missing, keep server running with classic defaults.
  holidayPack2025 = null;
}

const QUESTION_PACKS = {
  classic: defaultQuestions,
  holiday2025: Array.isArray(holidayPack2025) ? holidayPack2025 : null,
};

function getIo(req) {
  return req.app.get('io') || null;
}

function emit(io, event, payload) {
  if (!io) return;
  io.emit(event, payload);
}

function listBuzzQueue() {
  return db
    .prepare(
      `SELECT b.id, b.player_id AS playerId, b.buzz_time AS buzzTime,
              p.name AS playerName, p.slug AS playerSlug,
              CASE WHEN p.photo_url IS NULL OR p.photo_url = '' THEN 0 ELSE 1 END AS hasPhoto
       FROM buzz_queue b
       JOIN players p ON p.id = b.player_id
       ORDER BY b.buzz_time ASC`
    )
    .all();
}

function emitBuzzQueue(req) {
  emit(getIo(req), 'buzz:queue', listBuzzQueue());
}

function clearBuzzQueue() {
  db.prepare('DELETE FROM buzz_queue').run();
}

function enqueueBuzz(playerId, buzzTime) {
  const exists = db
    .prepare('SELECT 1 FROM buzz_queue WHERE player_id = ?')
    .get(playerId);
  if (exists) return { queued: false, reason: 'already_queued' };

  db.prepare(
    `INSERT INTO buzz_queue (id, player_id, buzz_time, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(uuidv4(), playerId, buzzTime, new Date().toISOString());
  return { queued: true };
}

function dequeueNextBuzz() {
  const next = db
    .prepare(
      `SELECT id, player_id AS playerId, buzz_time AS buzzTime
       FROM buzz_queue
       ORDER BY buzz_time ASC
       LIMIT 1`
    )
    .get();
  if (!next) return null;
  db.prepare('DELETE FROM buzz_queue WHERE id = ?').run(next.id);
  return next;
}

function listPlayers() {
  return db
    .prepare(
      `SELECT id, name, slug, score,
              CASE WHEN photo_url IS NULL OR photo_url = '' THEN 0 ELSE 1 END AS hasPhoto,
              created_at AS createdAt
       FROM players ORDER BY created_at DESC`
    )
    .all();
}

function listQuestions(selected) {
  let query = `SELECT q.id, q.player_id AS playerId, q.question_text AS questionText,
                      q.answer, q.category, q.points, q.selected_for_game AS selectedForGame,
                      q.used_in_game AS usedInGame,
                      q.created_at AS createdAt,
                      p.name AS playerName, p.slug AS playerSlug
               FROM questions q
               JOIN players p ON p.id = q.player_id`;

  if (selected === true) query += ' WHERE q.selected_for_game = 1';
  if (selected === false) query += ' WHERE q.selected_for_game = 0';
  query += ' ORDER BY q.created_at DESC';
  return db.prepare(query).all();
}

function listEvents(limit = 100) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  return db
    .prepare(
      `SELECT id, type, message, data_json AS dataJson, created_at AS createdAt
       FROM events
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(lim);
}

function normalizeSfxName(name) {
  const raw = String(name || '').trim().toLowerCase();
  const base = raw.endsWith('.wav') ? raw.slice(0, -4) : raw;
  if (!['buzzer', 'tick', 'countdown', 'timeout', 'correct', 'wrong', 'winner'].includes(base)) return null;
  return base;
}

function listSfxMeta() {
  return db
    .prepare('SELECT name, mime, updated_at AS updatedAt FROM sfx_files ORDER BY name ASC')
    .all();
}

function getSfxFile(name) {
  return db
    .prepare('SELECT name, mime, data, updated_at AS updatedAt FROM sfx_files WHERE name = ?')
    .get(name);
}

function logEvent(req, type, message, data = null) {
  const evt = {
    id: uuidv4(),
    type,
    message,
    data_json: data ? JSON.stringify(data) : null,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO events (id, type, message, data_json, created_at)
     VALUES (@id, @type, @message, @data_json, @created_at)`
  ).run(evt);

  // prune old events
  db.prepare(
    `DELETE FROM events WHERE id NOT IN (
       SELECT id FROM events ORDER BY created_at DESC LIMIT 300
     )`
  ).run();

  const io = getIo(req);
  if (io) {
    io.emit('events:new', {
      id: evt.id,
      type: evt.type,
      message: evt.message,
      dataJson: evt.data_json,
      createdAt: evt.created_at,
    });
  }
  return evt;
}

function findDefaultQuestion(category, points) {
  if (!category || !Number.isFinite(points)) return null;
  const cat = String(category).trim().toLowerCase();
  const pts = Math.trunc(points);
  const pool = QUESTION_PACKS.holiday2025 || defaultQuestions;
  return (
    pool.find(
      (q) => String(q.category).trim().toLowerCase() === cat && q.points === pts
    ) || null
  );
}

function ensureSystemPlayer() {
  const slug = 'house';
  const existing = db
    .prepare(
      `SELECT id, name, slug, score, photo_url AS photoUrl, created_at AS createdAt
       FROM players WHERE slug = ?`
    )
    .get(slug);
  if (existing) return existing;

  const player = {
    id: uuidv4(),
    name: 'House Questions',
    slug,
    photo_url: null,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO players (id, name, slug, photo_url, created_at)
     VALUES (@id, @name, @slug, @photo_url, @created_at)`
  ).run(player);
  return {
    id: player.id,
    name: player.name,
    slug: player.slug,
    score: 0,
    photoUrl: null,
    createdAt: player.created_at,
  };
}

function getNextGameNumber() {
  const max = db.prepare('SELECT MAX(game_number) as max FROM game_history').get();
  return (max?.max || 0) + 1;
}

function checkQuestionUsed(questionText, answer, category, points) {
  return db
    .prepare(
      `SELECT first_used_in_game, last_used_in_game, use_count
       FROM question_usage
       WHERE question_text = ? AND answer = ? AND category IS ? AND points IS ?`
    )
    .get(questionText, answer, category, points);
}

function recordQuestionUsage(questionText, answer, category, points, gameNumber) {
  const existing = checkQuestionUsed(questionText, answer, category, points);
  if (existing) {
    db.prepare(
      `UPDATE question_usage
       SET last_used_in_game = ?, use_count = use_count + 1
       WHERE question_text = ? AND answer = ? AND category IS ? AND points IS ?`
    ).run(gameNumber, questionText, answer, category, points);
  } else {
    db.prepare(
      `INSERT INTO question_usage (question_text, answer, category, points, first_used_in_game, last_used_in_game, use_count)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(questionText, answer, category, points, gameNumber, gameNumber);
  }
}

function seedDefaultQuestions({ selectForGame = true, pack = 'holiday2025', gameNumber = null } = {}) {
  const system = ensureSystemPlayer();
  let inserted = 0;
  let skipped = 0;
  const pool = QUESTION_PACKS[pack] || QUESTION_PACKS.holiday2025 || defaultQuestions;
  
  // Get or create game number
  const gameNum = gameNumber || getNextGameNumber();
  
  // Store question set in game history
  const questionSetJson = JSON.stringify(pool);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO game_history (game_number, question_set_json, created_at)
     VALUES (?, ?, ?)`
  ).run(gameNum, questionSetJson, now);

  const existsStmt = db.prepare(
    `SELECT 1 FROM questions
     WHERE player_id = ? AND question_text = ? AND answer = ? AND category IS ? AND points IS ?`
  );
  const insertStmt = db.prepare(
    `INSERT INTO questions (id, player_id, question_text, answer, category, points, selected_for_game, used_in_game, created_at)
     VALUES (@id, @player_id, @question_text, @answer, @category, @points, @selected_for_game, 0, @created_at)`
  );

  const tx = db.transaction(() => {
    for (const q of pool) {
      const cat = q.category ? String(q.category).trim() : null;
      const pts = Number.isFinite(q.points) ? Math.trunc(q.points) : null;
      const qText = String(q.questionText || '').trim();
      const ans = String(q.answer || '').trim();
      if (!qText || !ans || !cat || !pts) continue;

      // Check if question already exists in DB
      const exists = existsStmt.get(system.id, qText, ans, cat, pts);
      if (exists) {
        skipped += 1;
        continue;
      }

      // Check if question was used before (duplicate check)
      const used = checkQuestionUsed(qText, ans, cat, pts);
      if (used) {
        skipped += 1;
        continue; // Skip duplicates
      }

      insertStmt.run({
        id: uuidv4(),
        player_id: system.id,
        question_text: qText,
        answer: ans,
        category: cat,
        points: pts,
        selected_for_game: selectForGame ? 1 : 0,
        created_at: now,
      });
      
      // Record question usage
      recordQuestionUsage(qText, ans, cat, pts, gameNum);
      inserted += 1;
    }
  });
  tx();

  return { inserted, skipped, player: system, gameNumber: gameNum };
}

function slugify(name) {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '') // remove separators entirely for /johndoe
      .slice(0, 40) || 'player';
  return base;
}

function ensureUniqueSlug(baseSlug) {
  let slug = baseSlug;
  let counter = 1;
  while (
    db
      .prepare('SELECT 1 FROM players WHERE slug = ?')
      .get(slug)
  ) {
    counter += 1;
    slug = `${baseSlug}-${counter}`;
  }
  return slug;
}

function findPlayerBySlug(slug) {
  return db
    .prepare(
      `SELECT id, name, slug, score, photo_url AS photoUrl, created_at AS createdAt
       FROM players WHERE slug = ?`
    )
    .get(slug);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 4000;

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

app.get('/api/players', (req, res) => {
  res.json(listPlayers());
});

app.get('/api/players/:slug', (req, res) => {
  const player = findPlayerBySlug(req.params.slug);
  if (!player) {
    return res.status(404).json({ error: 'Player not found' });
  }
  res.json(player);
});

// Serve player photo as binary to avoid huge JSON payloads in /api/players.
app.get('/api/players/:id/photo', (req, res) => {
  const { id } = req.params;
  const row = db.prepare('SELECT photo_url FROM players WHERE id = ?').get(id);
  if (!row || !row.photo_url) return res.status(404).end();

  const s = String(row.photo_url);
  const m = s.match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    const mime = m[1] || 'image/jpeg';
    const b64 = m[2];
    try {
      const buf = Buffer.from(b64, 'base64');
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(buf);
    } catch {
      return res.status(400).end();
    }
  }

  // If stored as a plain URL, redirect.
  if (s.startsWith('http://') || s.startsWith('https://')) {
    return res.redirect(302, s);
  }

  return res.status(404).end();
});

app.patch('/api/players/:slug', (req, res) => {
  const current = findPlayerBySlug(req.params.slug);
  if (!current) {
    return res.status(404).json({ error: 'Player not found' });
  }

  const { name, photoUrl } = req.body || {};
  const updates = {};
  if (typeof name === 'string' && name.trim()) {
    updates.name = name.trim();
    const baseSlug = slugify(updates.name);
    updates.slug = ensureUniqueSlug(baseSlug);
  }
  if (photoUrl !== undefined) {
    updates.photo_url = photoUrl || null;
  }
  // score updates are admin-only; keep patch focused on profile fields
  if (Object.keys(updates).length === 0) {
    return res.json(current);
  }

  const sets = Object.keys(updates).map((k) => `${k}=@${k}`).join(', ');
  db.prepare(`UPDATE players SET ${sets} WHERE id = @id`).run({
    ...updates,
    id: current.id,
  });

  const updated = findPlayerBySlug(updates.slug || current.slug);
  emit(getIo(req), 'players:updated', listPlayers());
  res.json(updated);
});

app.post('/api/players', (req, res) => {
  const { name, photoUrl } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Name is required' });
  }

  const baseSlug = slugify(name);
  const slug = ensureUniqueSlug(baseSlug);

  const player = {
    id: uuidv4(),
    name: name.trim(),
    slug,
    photo_url: photoUrl || null,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO players (id, name, slug, photo_url, created_at)
     VALUES (@id, @name, @slug, @photo_url, @created_at)`
  ).run(player);

  emit(getIo(req), 'players:updated', listPlayers());
  res.status(201).json({
    id: player.id,
    name: player.name,
    slug: player.slug,
    photoUrl: player.photo_url,
    createdAt: player.created_at,
  });
});

app.get('/api/questions', (req, res) => {
  const { selected } = req.query;
  const sel =
    selected === 'true' ? true : selected === 'false' ? false : undefined;
  res.json(listQuestions(sel));
});

app.post('/api/questions', (req, res) => {
  const { playerId, questionText, answer, category, points } = req.body || {};
  if (!playerId || !questionText || !answer) {
    return res
      .status(400)
      .json({ error: 'playerId, questionText, and answer are required' });
  }

  const player = db
    .prepare('SELECT id FROM players WHERE id = ?')
    .get(playerId);
  if (!player) {
    return res.status(404).json({ error: 'Player not found' });
  }

  const question = {
    id: uuidv4(),
    player_id: playerId,
    question_text: questionText.trim(),
    answer: answer.trim(),
    category: category ? category.trim() : null,
    points: Number.isFinite(points) ? points : null,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO questions (id, player_id, question_text, answer, category, points, created_at)
     VALUES (@id, @player_id, @question_text, @answer, @category, @points, @created_at)`
  ).run(question);

  emit(getIo(req), 'questions:updated', listQuestions());
  res.status(201).json({
    id: question.id,
    playerId: question.player_id,
    questionText: question.question_text,
    answer: question.answer,
    category: question.category,
    points: question.points,
    selectedForGame: 0,
    createdAt: question.created_at,
  });
});

app.post('/api/admin/questions/:id/select', (req, res) => {
  const { id } = req.params;
  const { selected } = req.body || {};
  if (typeof selected !== 'boolean') {
    return res.status(400).json({ error: 'selected must be boolean' });
  }

  const info = db
    .prepare('UPDATE questions SET selected_for_game = ? WHERE id = ?')
    .run(selected ? 1 : 0, id);

  if (info.changes === 0) {
    return res.status(404).json({ error: 'Question not found' });
  }

  emit(getIo(req), 'questions:updated', listQuestions());
  res.json({ id, selectedForGame: selected });
});

app.post('/api/admin/seed-defaults', (req, res) => {
  const { selectForGame, pack } = req.body || {};
  const result = seedDefaultQuestions({
    selectForGame: selectForGame === undefined ? true : !!selectForGame,
    pack: pack || 'holiday2025',
  });
  emit(getIo(req), 'players:updated', listPlayers());
  emit(getIo(req), 'questions:updated', listQuestions());
  logEvent(req, 'seed_defaults', `Seeded default questions (+${result.inserted}, skipped ${result.skipped || 0})`, {
    inserted: result.inserted,
    skipped: result.skipped || 0,
    gameNumber: result.gameNumber,
    selectForGame: selectForGame === undefined ? true : !!selectForGame,
    pack: pack || 'holiday2025',
  });
  res.json(result);
});

app.get('/api/admin/question-packs', (req, res) => {
  res.json(
    Object.keys(QUESTION_PACKS).map((k) => ({
      key: k,
      count: Array.isArray(QUESTION_PACKS[k]) ? QUESTION_PACKS[k].length : 0,
    }))
  );
});

app.post('/api/admin/reset-for-new-game', (req, res) => {
  // Keep players/photos, but reset everything else.
  db.prepare('UPDATE players SET score = 0').run();
  db.prepare('DELETE FROM questions').run();
  clearBuzzQueue();

  const state = updateGameState({
    status: 'waiting',
    current_question_id: null,
    current_category: null,
    current_points: null,
    current_is_placeholder: 0,
    current_clue_text: null,
    current_answer_text: null,
    turn_player_id: null,
    buzzer_locked: 0,
    last_buzz_player_id: null,
    last_buzz_time: null,
  });

  emit(getIo(req), 'players:updated', listPlayers());
  emit(getIo(req), 'questions:updated', listQuestions());
  emit(getIo(req), 'game:state', state);
  emitBuzzQueue(req);
  logEvent(req, 'reset_new_game', 'Reset questions + scores (kept players/photos)', {});
  res.json({ ok: true, state });
});

app.post('/api/admin/set-turn', (req, res) => {
  const { playerId } = req.body || {};
  if (!playerId) return res.status(400).json({ error: 'playerId is required' });

  const exists = db.prepare('SELECT id FROM players WHERE id = ?').get(playerId);
  if (!exists) return res.status(404).json({ error: 'Player not found' });

  const state = updateGameState({ turn_player_id: playerId });
  emit(getIo(req), 'game:state', state);
  const p = db.prepare('SELECT name, slug FROM players WHERE id = ?').get(playerId);
  logEvent(req, 'turn_set', `Turn set to ${p?.name || playerId}`, { playerId, playerName: p?.name });
  res.json(state);
});

app.post('/api/admin/players/:id/score', (req, res) => {
  const { id } = req.params;
  const { delta, score } = req.body || {};

  const player = db
    .prepare(
      `SELECT id, name, slug, score, photo_url AS photoUrl, created_at AS createdAt
       FROM players WHERE id = ?`
    )
    .get(id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  let newScore;
  let appliedDelta = 0;

  if (score !== undefined && score !== null) {
    const s = Number(score);
    if (!Number.isFinite(s)) return res.status(400).json({ error: 'score must be a number' });
    newScore = Math.trunc(s);
    db.prepare('UPDATE players SET score = ? WHERE id = ?').run(newScore, id);
  } else {
    const d = Number(delta);
    if (!Number.isFinite(d)) return res.status(400).json({ error: 'delta must be a number' });
    appliedDelta = Math.trunc(d);
    db.prepare('UPDATE players SET score = score + ? WHERE id = ?').run(appliedDelta, id);
    newScore = db.prepare('SELECT score FROM players WHERE id = ?').get(id).score;
  }

  emit(getIo(req), 'players:updated', listPlayers());
  logEvent(
    req,
    'score_adjust',
    `Admin adjusted ${player.name}: ${appliedDelta ? (appliedDelta > 0 ? '+' : '') + appliedDelta : 'set'} → ${newScore}`,
    { playerId: id, playerName: player.name, delta: appliedDelta, score: newScore }
  );
  res.json({ playerId: id, score: newScore });
});

app.get('/api/sfx/:name', (req, res) => {
  const name = normalizeSfxName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid sfx name' });
  const row = getSfxFile(name);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', row.mime || 'audio/wav');
  res.setHeader('Cache-Control', 'no-store');
  res.send(row.data);
});

// TTS endpoint using Google Translate TTS (free, better quality than Web Speech API)
app.post('/api/tts/speak', async (req, res) => {
  const { text, questionId } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Text is required' });
  }

  try {
    // Check if audio is already cached
    if (questionId) {
      const cached = db
        .prepare('SELECT audio_data, mime FROM question_audio WHERE question_id = ?')
        .get(questionId);
      if (cached) {
        res.setHeader('Content-Type', cached.mime || 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(cached.audio_data);
        return;
      }
    }

    // Google Translate TTS API (free, no auth required)
    // Provides much better quality than browser Web Speech API
    const encodedText = encodeURIComponent(text.trim().slice(0, 200)); // Limit length
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=en&client=tw-ob`;
    
    const fetch = require('node-fetch');
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://translate.google.com/'
      }
    });
    
    if (!response.ok) {
      throw new Error(`TTS service returned ${response.status}`);
    }
    
    const audioBuffer = await response.buffer();
    
    // Cache audio if questionId provided
    if (questionId) {
      db.prepare(
        `INSERT OR REPLACE INTO question_audio (question_id, audio_data, mime, created_at)
         VALUES (?, ?, 'audio/mpeg', ?)`
      ).run(questionId, audioBuffer, new Date().toISOString());
    }
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'Failed to generate speech' });
  }
});

// Pre-generate audio for all questions
app.post('/api/admin/pregenerate-audio', async (req, res) => {
  const questions = listQuestions(true); // Get selected questions
  const fetch = require('node-fetch');
  let generated = 0;
  let errors = 0;

  for (const q of questions) {
    if (!q.questionText || q.questionText === 'N/A') continue;
    
    try {
      // Check if already cached
      const cached = db
        .prepare('SELECT 1 FROM question_audio WHERE question_id = ?')
        .get(q.id);
      if (cached) {
        generated += 1;
        continue;
      }

      const encodedText = encodeURIComponent(q.questionText.trim().slice(0, 200));
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=en&client=tw-ob`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://translate.google.com/'
        }
      });
      
      if (response.ok) {
        const audioBuffer = await response.buffer();
        db.prepare(
          `INSERT OR REPLACE INTO question_audio (question_id, audio_data, mime, created_at)
           VALUES (?, ?, 'audio/mpeg', ?)`
        ).run(q.id, audioBuffer, new Date().toISOString());
        generated += 1;
      } else {
        errors += 1;
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (err) {
      console.error(`Error generating audio for question ${q.id}:`, err);
      errors += 1;
    }
  }

  res.json({ generated, errors, total: questions.length });
});

app.get('/api/admin/sfx', (req, res) => {
  res.json(listSfxMeta());
});

// Game history endpoints
app.get('/api/admin/game-history', (req, res) => {
  const history = db
    .prepare(
      `SELECT id, game_number AS gameNumber, question_set_json AS questionSetJson,
              created_at AS createdAt, completed_at AS completedAt
       FROM game_history
       ORDER BY game_number DESC
       LIMIT 50`
    )
    .all();
  res.json(history);
});

app.post('/api/admin/game-history/:gameNumber/load', (req, res) => {
  const gameNum = parseInt(req.params.gameNumber, 10);
  if (!Number.isFinite(gameNum) || gameNum < 1) {
    return res.status(400).json({ error: 'Invalid game number' });
  }

  const history = db
    .prepare('SELECT question_set_json FROM game_history WHERE game_number = ?')
    .get(gameNum);
  
  if (!history) {
    return res.status(404).json({ error: 'Game not found in history' });
  }

  const questionSet = JSON.parse(history.question_set_json);
  const system = ensureSystemPlayer();
  const now = new Date().toISOString();
  
  // Clear existing questions
  db.prepare('DELETE FROM questions WHERE player_id = ?').run(system.id);
  
  const insertStmt = db.prepare(
    `INSERT INTO questions (id, player_id, question_text, answer, category, points, selected_for_game, used_in_game, created_at)
     VALUES (@id, @player_id, @question_text, @answer, @category, @points, @selected_for_game, 0, @created_at)`
  );

  const tx = db.transaction(() => {
    for (const q of questionSet) {
      const cat = q.category ? String(q.category).trim() : null;
      const pts = Number.isFinite(q.points) ? Math.trunc(q.points) : null;
      const qText = String(q.questionText || '').trim();
      const ans = String(q.answer || '').trim();
      if (!qText || !ans || !cat || !pts) continue;

      insertStmt.run({
        id: uuidv4(),
        player_id: system.id,
        question_text: qText,
        answer: ans,
        category: cat,
        points: pts,
        selected_for_game: 1,
        created_at: now,
      });
      
      recordQuestionUsage(qText, ans, cat, pts, gameNum);
    }
  });
  tx();

  emit(getIo(req), 'questions:updated', listQuestions());
  res.json({ ok: true, gameNumber: gameNum, loaded: questionSet.length });
});

app.post('/api/admin/sfx/:name', (req, res) => {
  const name = normalizeSfxName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid sfx name' });
  const { dataUrl } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') {
    return res.status(400).json({ error: 'dataUrl is required' });
  }

  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'Invalid dataUrl' });
  const mime = m[1];
  const b64 = m[2];

  if (!mime.startsWith('audio/')) {
    return res.status(400).json({ error: 'File must be audio/*' });
  }

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 data' });
  }

  // basic safety limit (keep under JSON limit and avoid huge DB rows)
  if (buf.length > 2_500_000) {
    return res.status(413).json({ error: 'File too large (max ~2.5MB)' });
  }

  const updatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO sfx_files (name, mime, data, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=excluded.updated_at`
  ).run(name, mime, buf, updatedAt);

  const io = getIo(req);
  if (io) io.emit('sfx:meta', listSfxMeta());

  logEvent(req, 'sfx_uploaded', `Uploaded ${name}.wav`, { name, mime, bytes: buf.length });
  res.json({ ok: true, name, updatedAt });
});

app.delete('/api/admin/players/:id', (req, res) => {
  const { id } = req.params;

  const player = db
    .prepare('SELECT id, name, slug FROM players WHERE id = ?')
    .get(id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  // Remove their questions and any queued buzzes
  db.prepare('DELETE FROM questions WHERE player_id = ?').run(id);
  db.prepare('DELETE FROM buzz_queue WHERE player_id = ?').run(id);

  // Clear game state references if needed
  const state = getGameState();
  const patch = {};
  if (state.turn_player_id === id) patch.turn_player_id = null;
  if (state.last_buzz_player_id === id) {
    patch.buzzer_locked = 0;
    patch.last_buzz_player_id = null;
    patch.last_buzz_time = null;
  }
  const updatedState = Object.keys(patch).length ? updateGameState(patch) : state;

  // Finally delete player
  db.prepare('DELETE FROM players WHERE id = ?').run(id);

  emit(getIo(req), 'players:updated', listPlayers());
  emit(getIo(req), 'questions:updated', listQuestions());
  emit(getIo(req), 'game:state', updatedState);
  emitBuzzQueue(req);
  logEvent(req, 'player_deleted', `Admin deleted player ${player.name}`, {
    playerId: id,
    playerName: player.name,
    playerSlug: player.slug,
  });

  res.json({ ok: true });
});

app.get('/api/admin/events', (req, res) => {
  const limit = req.query.limit;
  res.json(listEvents(limit));
});

app.patch('/api/admin/questions/:id/meta', (req, res) => {
  const { id } = req.params;
  const { category, points } = req.body || {};

  const updates = {};
  if (category !== undefined) {
    updates.category = category ? String(category).trim() : null;
  }
  if (points !== undefined) {
    updates.points = Number.isFinite(points) ? Math.trunc(points) : null;
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  const sets = Object.keys(updates).map((k) => `${k}=@${k}`).join(', ');
  const info = db.prepare(`UPDATE questions SET ${sets} WHERE id = @id`).run({
    ...updates,
    id,
  });

  if (info.changes === 0) {
    return res.status(404).json({ error: 'Question not found' });
  }

  const row = db
    .prepare(
      `SELECT id, category, points, selected_for_game AS selectedForGame, used_in_game AS usedInGame
       FROM questions WHERE id = ?`
    )
    .get(id);
  emit(getIo(req), 'questions:updated', listQuestions());
  res.json(row);
});

app.patch('/api/admin/questions/:id/points', (req, res) => {
  const { id } = req.params;
  const { points } = req.body || {};
  const val = Number.isFinite(points) ? Math.trunc(points) : null;
  const info = db
    .prepare('UPDATE questions SET points = ? WHERE id = ?')
    .run(val, id);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Question not found' });
  }
  emit(getIo(req), 'questions:updated', listQuestions());
  res.json({ id, points: val });
});

app.post('/api/game/select-card', (req, res) => {
  const { questionId, category, points, force, pickerPlayerId } = req.body || {};
  const pts = Number.isFinite(points) ? Math.trunc(points) : null;
  const cat = category ? String(category).trim() : null;
  const state0 = getGameState();

  // Only allow selecting a new card when no clue is active (unless force).
  const clueActive = !!state0.current_question_id || !!state0.current_is_placeholder;
  if (clueActive && !force) {
    return res.status(409).json({ error: 'A clue is already active' });
  }

  // If it is someone's turn, enforce that only they can pick (unless force).
  if (state0.turn_player_id && !force) {
    if (!pickerPlayerId || pickerPlayerId !== state0.turn_player_id) {
      return res.status(403).json({ error: 'Not your turn' });
    }
  }

  // Allow selecting an empty tile (no questionId). This sets a placeholder tile.
  if (!questionId) {
    clearBuzzQueue();
    const fallback = findDefaultQuestion(cat, pts);
    const clue = fallback?.questionText || 'N/A';
    const answer = fallback?.answer || 'N/A';
    const state = updateGameState({
      current_question_id: null,
      current_category: cat,
      current_points: pts,
      current_is_placeholder: 1,
      current_clue_text: clue,
      current_answer_text: answer,
      buzzer_locked: 0,
      last_buzz_player_id: null,
      last_buzz_time: null,
    });
    emit(getIo(req), 'game:state', state);
    emitBuzzQueue(req);
    logEvent(req, 'card_selected', `Selected ${cat || 'Unknown'} $${pts || ''} (default/NA)`, {
      category: cat,
      points: pts,
      placeholder: true,
    });
    return res.json(state);
  }

  const q = db
    .prepare(
      `SELECT id, category, points, selected_for_game AS selectedForGame, used_in_game AS usedInGame
       FROM questions WHERE id = ?`
    )
    .get(questionId);
  if (!q) return res.status(404).json({ error: 'Question not found' });

  if (!force) {
    if (!q.selectedForGame) return res.status(400).json({ error: 'Question not selected' });
    if (q.usedInGame) return res.status(409).json({ error: 'Card already used' });
  }

  db.prepare('UPDATE questions SET used_in_game = 1 WHERE id = ?').run(questionId);
  clearBuzzQueue();

  const state = updateGameState({
    current_question_id: questionId,
    current_category: q.category || cat,
    current_points: Number.isFinite(q.points) ? q.points : pts,
    current_is_placeholder: 0,
    current_clue_text: null,
    current_answer_text: null,
    buzzer_locked: 0,
    last_buzz_player_id: null,
    last_buzz_time: null,
    question_reading: 1, // Mark question as being read
  });
  emit(getIo(req), 'questions:updated', listQuestions());
  emit(getIo(req), 'game:state', state);
  emitBuzzQueue(req);
  logEvent(req, 'card_selected', `Selected ${state.current_category || 'Unknown'} $${state.current_points || ''}`, {
    questionId,
    category: state.current_category,
    points: state.current_points,
    placeholder: false,
  });
  res.json(state);
});

app.post('/api/game/reset-board', (req, res) => {
  db.prepare('UPDATE questions SET used_in_game = 0').run();
  const state = updateGameState({
    current_question_id: null,
    current_category: null,
    current_points: null,
    current_is_placeholder: 0,
    current_clue_text: null,
    current_answer_text: null,
    // keep turn_player_id as-is
    buzzer_locked: 0,
    last_buzz_player_id: null,
    last_buzz_time: null,
  });
  emit(getIo(req), 'questions:updated', listQuestions());
  emit(getIo(req), 'game:state', state);
  res.json(state);
});

app.get('/api/game/state', (req, res) => {
  res.json(getGameState());
});

app.post('/api/game/start', (req, res) => {
  // If there are no selected questions yet, seed defaults and select them.
  const selectedCount = db
    .prepare('SELECT COUNT(1) AS c FROM questions WHERE selected_for_game = 1')
    .get().c;
  if (!selectedCount) {
    seedDefaultQuestions({ selectForGame: true });
  }

  // New game: reset board so no tiles start as "used".
  db.prepare('UPDATE questions SET used_in_game = 0').run();

  const state = updateGameState({
    status: 'active',
    current_question_id: null,
    current_category: null,
    current_points: null,
    current_is_placeholder: 0,
    current_clue_text: null,
    current_answer_text: null,
    turn_player_id: null,
    buzzer_locked: 0,
    last_buzz_player_id: null,
    last_buzz_time: null,
  });
  clearBuzzQueue();
  emit(getIo(req), 'players:updated', listPlayers());
  emit(getIo(req), 'questions:updated', listQuestions());
  emit(getIo(req), 'game:state', state);
  emitBuzzQueue(req);
  logEvent(req, 'game_started', 'Game started', {});
  logEvent(req, 'board_reset', 'Board reset (all tiles unused)', {});
  res.json(state);
});

app.post('/api/game/end', (req, res) => {
  const state = updateGameState({
    status: 'ended',
    buzzer_locked: 1,
  });
  clearBuzzQueue();
  emit(getIo(req), 'game:state', state);
  emitBuzzQueue(req);
  logEvent(req, 'game_ended', 'Game ended', {});
  res.json(state);
});

app.post('/api/game/reset', (req, res) => {
  const state = updateGameState({
    status: 'waiting',
    current_question_id: null,
    current_category: null,
    current_points: null,
    current_is_placeholder: 0,
    current_clue_text: null,
    current_answer_text: null,
    turn_player_id: null,
    buzzer_locked: 0,
    last_buzz_player_id: null,
    last_buzz_time: null,
  });
  clearBuzzQueue();
  emit(getIo(req), 'game:state', state);
  emitBuzzQueue(req);
  logEvent(req, 'game_reset', 'Game reset', {});
  res.json(state);
});

app.post('/api/game/current-question', (req, res) => {
  const { questionId } = req.body || {};
  if (!questionId) {
    return res.status(400).json({ error: 'questionId is required' });
  }

  const exists = db
    .prepare('SELECT id FROM questions WHERE id = ?')
    .get(questionId);
  if (!exists) {
    return res.status(404).json({ error: 'Question not found' });
  }

  const state = updateGameState({ current_question_id: questionId });
  emit(getIo(req), 'game:state', state);
  res.json(state);
});

app.post('/api/game/unlock-buzzer', (req, res) => {
  const state = updateGameState({
    buzzer_locked: 0,
    last_buzz_player_id: null,
    last_buzz_time: null,
  });
  clearBuzzQueue();
  emit(getIo(req), 'game:state', state);
  emitBuzzQueue(req);
  res.json(state);
});

app.post('/api/game/set-question-reading', (req, res) => {
  const { reading } = req.body || {};
  if (typeof reading !== 'boolean') {
    return res.status(400).json({ error: 'reading must be boolean' });
  }
  const state = updateGameState({ question_reading: reading ? 1 : 0 });
  emit(getIo(req), 'game:state', state);
  res.json(state);
});

app.post('/api/game/buzz', (req, res) => {
  const { playerId } = req.body || {};
  if (!playerId) {
    return res.status(400).json({ error: 'playerId is required' });
  }

  const player = db
    .prepare('SELECT id, name FROM players WHERE id = ?')
    .get(playerId);
  if (!player) {
    return res.status(404).json({ error: 'Player not found' });
  }

  const state = getGameState();
  if (state.status !== 'active') {
    return res.status(400).json({ error: 'Game is not active' });
  }

  const clueActive = !!state.current_question_id || !!state.current_is_placeholder;
  if (!clueActive) {
    return res.status(400).json({ error: 'No active clue' });
  }

  // Disable buzzer until question has been read
  if (state.question_reading) {
    return res.status(400).json({ error: 'Question is still being read' });
  }

  const now = new Date().toISOString();

  // If already locked (someone is currently up), queue this buzz.
  if (state.buzzer_locked) {
    // don't allow the current responder to queue themselves
    if (state.last_buzz_player_id === playerId) {
      return res.json({ ok: true, queued: false, reason: 'already_current' });
    }
    const r = enqueueBuzz(playerId, now);
    const queue = listBuzzQueue();
    emitBuzzQueue(req);
    if (r.queued) {
      logEvent(req, 'buzz_queued', `${player.name} queued to buzz`, {
        playerId,
        playerName: player.name,
        position: queue.length,
      });
    }
    return res.json({ ok: true, queued: r.queued, reason: r.reason || null, position: queue.length });
  }

  // First buzz wins the lock
  const updated = updateGameState({
    buzzer_locked: 1,
    last_buzz_player_id: playerId,
    last_buzz_time: now,
  });

  emit(getIo(req), 'game:state', updated);
  emitBuzzQueue(req);
  logEvent(req, 'buzz', `${player.name} buzzed first`, { playerId, playerName: player.name });
  res.json({ ok: true, queued: false, state: updated });
});

app.post('/api/admin/skip-current', (req, res) => {
  const state = getGameState();
  if (!state.current_question_id && !state.current_is_placeholder) {
    return res.status(400).json({ error: 'No current question' });
  }

  clearBuzzQueue();
  const updatedState = updateGameState({
    current_question_id: null,
    current_category: null,
    current_points: null,
    current_is_placeholder: 0,
    current_clue_text: null,
    current_answer_text: null,
    buzzer_locked: 0,
    last_buzz_player_id: null,
    last_buzz_time: null,
    // Keep the same turn player so they can pick again
  });
  emit(getIo(req), 'game:state', updatedState);
  emitBuzzQueue(req);
  logEvent(req, 'question_skipped', 'Question skipped (no one knew the answer)', {});
  res.json(updatedState);
});

app.post('/api/admin/resolve-current', (req, res) => {
  const { playerId, correct } = req.body || {};
  if (!playerId || typeof correct !== 'boolean') {
    return res.status(400).json({ error: 'playerId and correct are required' });
  }

  const state = getGameState();
  if (!state.current_question_id && !state.current_is_placeholder) {
    return res.status(400).json({ error: 'No current question' });
  }

  let delta = 0;
  if (state.current_is_placeholder) {
    delta = Number.isFinite(state.current_points) ? state.current_points : 0;
  } else {
    const question = db
      .prepare('SELECT id, points FROM questions WHERE id = ?')
      .get(state.current_question_id);
    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }
    delta = Number.isFinite(question.points) ? question.points : 0;
  }

  let updatedState;
  if (correct) {
    db.prepare('UPDATE players SET score = score + ? WHERE id = ?').run(delta, playerId);
    clearBuzzQueue();
    updatedState = updateGameState({
      current_question_id: null,
      current_category: null,
      current_points: null,
      current_is_placeholder: 0,
      current_clue_text: null,
      current_answer_text: null,
      // In Jeopardy, the player who answered correctly chooses next.
      turn_player_id: playerId,
      buzzer_locked: 0,
      last_buzz_player_id: null,
      last_buzz_time: null,
    });
  } else {
    // Jeopardy rule: incorrect response loses the clue value.
    if (delta) {
      db.prepare('UPDATE players SET score = score - ? WHERE id = ?').run(delta, playerId);
    }
    const next = dequeueNextBuzz();
    if (next) {
      const nextNow = new Date().toISOString();
      updatedState = updateGameState({
        // keep current clue active
        current_question_id: state.current_question_id,
        current_category: state.current_category,
        current_points: state.current_points,
        current_is_placeholder: state.current_is_placeholder,
        current_clue_text: state.current_clue_text,
        current_answer_text: state.current_answer_text,
        buzzer_locked: 1,
        last_buzz_player_id: next.playerId,
        last_buzz_time: nextNow, // give next player a fresh 30s window
      });
      const p = db.prepare('SELECT name FROM players WHERE id = ?').get(next.playerId);
      logEvent(req, 'buzz_advance', `Next up: ${p?.name || next.playerId}`, { playerId: next.playerId, playerName: p?.name });
    } else {
      updatedState = updateGameState({
        // keep current clue active, but reopen buzzing
        current_question_id: state.current_question_id,
        current_category: state.current_category,
        current_points: state.current_points,
        current_is_placeholder: state.current_is_placeholder,
        current_clue_text: state.current_clue_text,
        current_answer_text: state.current_answer_text,
        buzzer_locked: 0,
        last_buzz_player_id: null,
        last_buzz_time: null,
      });
    }
  }

  const scores = db
    .prepare(
      `SELECT id, name, slug, score, photo_url AS photoUrl, created_at AS createdAt
       FROM players ORDER BY score DESC, created_at ASC`
    )
    .all();

  // Realtime updates
  emit(getIo(req), 'players:updated', listPlayers());
  emit(getIo(req), 'game:state', updatedState);
  emitBuzzQueue(req);
  logEvent(
    req,
    correct ? 'marked_correct' : 'marked_wrong',
    `${correct ? 'Correct' : 'Wrong'}: player ${playerId} (${delta >= 0 ? '+' : ''}${delta} pts)`,
    {
      playerId,
      delta: correct ? delta : -delta,
      questionId: state.current_question_id,
      category: state.current_category,
      points: state.current_points,
      placeholder: !!state.current_is_placeholder,
    }
  );

  res.json({ state: updatedState, scores });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
  });
  app.set('io', io);

  io.on('connection', (socket) => {
    socket.emit('players:updated', listPlayers());
    socket.emit('questions:updated', listQuestions());
    socket.emit('game:state', getGameState());
    socket.emit('events:init', listEvents(100));
    socket.emit('buzz:queue', listBuzzQueue());
    socket.emit('sfx:meta', listSfxMeta());
  });

  httpServer.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;

