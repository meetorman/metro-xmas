import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';

process.env.DB_PATH = path.join(process.cwd(), 'tests', 'tmp.db');

// ensure clean db file
const tmpDir = path.join(process.cwd(), 'tests');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
if (fs.existsSync(process.env.DB_PATH)) fs.rmSync(process.env.DB_PATH);

const app = require('../src/server');

describe('API smoke tests', () => {
  let player;

  it('creates a player with slug and returns profile', async () => {
    const res = await request(app)
      .post('/api/players')
      .send({ name: 'John Doe' })
      .expect(201);

    player = res.body;
    expect(player.name).toBe('John Doe');
    expect(player.slug).toBe('johndoe');
    expect(player.id).toBeTruthy();
  });

  it('fetches player by slug', async () => {
    const res = await request(app).get(`/api/players/${player.slug}`).expect(200);
    expect(res.body.id).toBe(player.id);
    expect(res.body.slug).toBe('johndoe');
  });

  it('creates a question for the player', async () => {
    const res = await request(app)
      .post('/api/questions')
      .send({
        playerId: player.id,
        questionText: 'What is Xmas?',
        answer: 'Christmas',
        category: 'Holidays',
        points: 100,
      })
      .expect(201);

    expect(res.body.playerId).toBe(player.id);
    expect(res.body.questionText).toBe('What is Xmas?');
  });

  it('lists questions with player slug', async () => {
    const res = await request(app).get('/api/questions').expect(200);
    const q = res.body[0];
    expect(q.playerSlug).toBe('johndoe');
    expect(q.questionText).toBe('What is Xmas?');
  });

  it('selecting an empty board tile loads a default question when available', async () => {
    const res = await request(app)
      .post('/api/game/select-card')
      .send({ category: 'Disney & Pixar', points: 200 })
      .expect(200);

    expect(res.body.current_is_placeholder).toBe(1);
    expect(res.body.current_category).toBe('Disney & Pixar');
    expect(res.body.current_points).toBe(200);
    expect(String(res.body.current_clue_text || '')).toContain('Frozen');
    expect(res.body.current_answer_text).toBe('Olaf');
  });

  it('admin can seed defaults and they show up in /api/questions', async () => {
    const seed = await request(app).post('/api/admin/seed-defaults').send({}).expect(200);
    expect(seed.body.inserted).toBeGreaterThan(0);

    const res = await request(app).get('/api/questions').expect(200);
    const anyDefault = res.body.find((q) => q.playerName === 'House Questions');
    expect(anyDefault).toBeTruthy();
    expect(anyDefault.selectedForGame).toBe(1);
  });

  it('turn enforcement: only turn player can pick a new card when turn is set', async () => {
    // Create a second player
    const p2 = await request(app).post('/api/players').send({ name: 'Jane Doe' }).expect(201);

    // Seed defaults (selected)
    await request(app).post('/api/admin/seed-defaults').send({}).expect(200);

    // Reset then start game (ensures no active clue and clears turn)
    await request(app).post('/api/game/reset').send({}).expect(200);
    await request(app).post('/api/game/start').send({}).expect(200);

    // Give turn to John (player)
    await request(app).post('/api/admin/set-turn').send({ playerId: player.id }).expect(200);

    // Jane tries to pick -> 403
    await request(app)
      .post('/api/game/select-card')
      .send({ category: 'Disney & Pixar', points: 200, pickerPlayerId: p2.body.id })
      .expect(403);

    // John can pick -> 200
    await request(app)
      .post('/api/game/select-card')
      .send({ category: 'Disney & Pixar', points: 200, pickerPlayerId: player.id })
      .expect(200);
  });
});

