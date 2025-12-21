import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import axios from 'axios';
import { io as ioClient } from 'socket.io-client';
import {
  Link,
  Route,
  Routes,
  Navigate,
  useNavigate,
  useParams,
  useLocation,
} from 'react-router-dom';
import './App.css';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const PUBLIC_JOIN_URL = import.meta.env.VITE_PUBLIC_JOIN_URL;
const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  `${window.location.protocol}//${window.location.hostname}:4000`;

function useSfx() {
  const [unlocked, setUnlocked] = useState(false);
  const audioRef = useRef(null);
  const metaRef = useRef({});

  function srcFor(name) {
    const meta = metaRef.current?.[name];
    if (meta?.updatedAt) return `/api/sfx/${name}?v=${encodeURIComponent(meta.updatedAt)}`;
    return `/sfx/${name}.wav`;
  }

  function ensureAudio() {
    if (!audioRef.current) {
      audioRef.current = {
        buzzer: new Audio(srcFor('buzzer')),
        tick: new Audio(srcFor('tick')),
        correct: new Audio(srcFor('correct')),
        wrong: new Audio(srcFor('wrong')),
      };
      // keep short SFX snappy
      Object.values(audioRef.current).forEach((a) => {
        a.preload = 'auto';
        a.volume = 1.0;
      });
    }
    return audioRef.current;
  }

  function setMeta(metaList) {
    const m = {};
    (metaList || []).forEach((row) => {
      if (row?.name) m[row.name] = row;
    });
    metaRef.current = m;
    // refresh sources so next play uses updated audio
    if (audioRef.current) {
      audioRef.current.buzzer.src = srcFor('buzzer');
      audioRef.current.tick.src = srcFor('tick');
      audioRef.current.correct.src = srcFor('correct');
      audioRef.current.wrong.src = srcFor('wrong');
    }
  }

  async function unlock() {
    try {
      const a = ensureAudio();
      // attempt to play/pause a silent tick to satisfy autoplay policies
      a.tick.currentTime = 0;
      const p = a.tick.play();
      if (p && typeof p.then === 'function') {
        await p;
      }
      a.tick.pause();
      a.tick.currentTime = 0;
      setUnlocked(true);
      return true;
    } catch {
      setUnlocked(false);
      return false;
    }
  }

  function play(name) {
    if (!unlocked) return;
    const a = ensureAudio();
    const el = a[name];
    if (!el) return;
    try {
      el.currentTime = 0;
      el.play().catch(() => {});
    } catch {
      // ignore
    }
  }

  return {
    unlock,
    isUnlocked: unlocked,
    setMeta,
    buzz: () => play('buzzer'),
    tick: () => play('tick'),
    correct: () => play('correct'),
    wrong: () => play('wrong'),
  };
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function useToast() {
  const [toast, setToast] = useState(null);
  function showToast(message, type = 'info') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 2500);
  }
  return { toast, showToast };
}

function useGameData(showToast, { enableSfx = false } = {}) {
  const [players, setPlayers] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [gameState, setGameState] = useState(null);
  const [events, setEvents] = useState([]);
  const [buzzQueue, setBuzzQueue] = useState([]);
  const [busy, setBusy] = useState(false);
  const sfx = useSfx();
  const lastBuzzRef = useRef({ playerId: null, time: null });
  const [soundReady, setSoundReady] = useState(false);
  const [sfxMeta, setSfxMeta] = useState([]);

  async function enableSoundNow() {
    const ok = await sfx.unlock();
    setSoundReady(ok);
    if (ok) {
      // audible confirmation
      sfx.correct();
    }
    return ok;
  }

  async function refreshPlayers() {
    const { data } = await axios.get(`${API_BASE}/players`);
    setPlayers(data);
  }

  async function refreshQuestions() {
    const { data } = await axios.get(`${API_BASE}/questions`);
    setQuestions(data);
  }

  async function refreshState() {
    const { data } = await axios.get(`${API_BASE}/game/state`);
    setGameState(data);
  }

  useEffect(() => {
    // Initial load (works even if WS is temporarily down)
    refreshAll();

    // Realtime updates
    const socket = ioClient(SOCKET_URL, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });

    socket.on('players:updated', (p) => setPlayers(Array.isArray(p) ? p : []));
    socket.on('questions:updated', (q) =>
      setQuestions(Array.isArray(q) ? q : [])
    );
    socket.on('game:state', (s) => setGameState(s || null));
    socket.on('events:init', (evts) => setEvents(Array.isArray(evts) ? evts : []));
    socket.on('events:new', (evt) => {
      if (!evt) return;
      setEvents((prev) => [evt, ...prev].slice(0, 200));
    });
    socket.on('events:new', (evt) => {
      if (!evt?.type) return;
      if (!enableSfx) return;
      if (evt.type === 'buzz' || evt.type === 'buzz_advance') sfx.buzz();
      if (evt.type === 'marked_correct') sfx.correct();
      if (evt.type === 'marked_wrong') sfx.wrong();
    });
    socket.on('buzz:queue', (q) => setBuzzQueue(Array.isArray(q) ? q : []));
    socket.on('sfx:meta', (m) => {
      const list = Array.isArray(m) ? m : [];
      setSfxMeta(list);
      sfx.setMeta(list);
    });

    socket.on('connect_error', (err) => {
      console.warn('socket connect_error', err?.message || err);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // TV-only: unlock audio on first user gesture
  useEffect(() => {
    if (!enableSfx) return;
    let cancelled = false;
    const tryUnlock = async () => {
      const ok = await sfx.unlock();
      if (!cancelled) setSoundReady(ok);
    };
    const onGesture = () => tryUnlock();
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('keydown', onGesture);
    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
    };
  }, [enableSfx]);

  // Catch buzzer events even if the activity feed isn't visible:
  useEffect(() => {
    if (!gameState) return;
    if (!enableSfx) return;
    const locked = !!gameState.buzzer_locked;
    const pid = gameState.last_buzz_player_id;
    const t = gameState.last_buzz_time;
    if (locked && pid && (pid !== lastBuzzRef.current.playerId || t !== lastBuzzRef.current.time)) {
      lastBuzzRef.current = { playerId: pid, time: t };
      sfx.buzz();
    }
  }, [enableSfx, gameState?.buzzer_locked, gameState?.last_buzz_player_id, gameState?.last_buzz_time]);

  async function refreshAll() {
    try {
      await Promise.all([refreshPlayers(), refreshQuestions(), refreshState()]);
    } catch (err) {
      console.error(err);
    }
  }

  async function setCurrentQuestion(questionId) {
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/game/current-question`, { questionId });
      await refreshState();
      showToast('Current question set');
    } catch (err) {
      console.error(err);
      showToast('Could not set question', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function selectCard({
    questionId = null,
    category = null,
    points = null,
    force = false,
    pickerPlayerId = null,
  } = {}) {
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/game/select-card`, {
        questionId,
        category,
        points,
        force: !!force,
        pickerPlayerId: pickerPlayerId || null,
      });
    } catch (err) {
      console.error(err);
      showToast('Could not select card', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function startGame() {
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/game/start`);
      await refreshState();
      showToast('Game started');
    } catch (err) {
      console.error(err);
      showToast('Could not start game', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function endGame() {
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/game/end`);
      await refreshState();
      showToast('Game ended');
    } catch (err) {
      console.error(err);
      showToast('Could not end game', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function resetGame() {
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/game/reset`);
      await refreshState();
      showToast('Game reset');
    } catch (err) {
      console.error(err);
      showToast('Could not reset game', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function unlockBuzzer() {
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/game/unlock-buzzer`);
      await refreshState();
      showToast('Buzzer unlocked');
    } catch (err) {
      console.error(err);
      showToast('Could not unlock buzzer', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function buzz(playerId) {
    if (!playerId) return;
    setBusy(true);
    try {
      const { data } = await axios.post(`${API_BASE}/game/buzz`, { playerId });
      await refreshState();
      if (data?.queued) {
        showToast(`Queued (${data.position || 0})`);
      } else {
        showToast('Buzzed!');
      }
    } catch (err) {
      console.error(err);
      const message =
        err.response?.data?.error || 'Could not buzz';
      showToast(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return {
    players,
    questions,
    gameState,
    events,
    buzzQueue,
    soundReady,
    enableSoundNow,
    sfxMeta,
    busy,
    setBusy,
    refreshPlayers,
    refreshQuestions,
    refreshState,
    setCurrentQuestion,
    selectCard,
    startGame,
    endGame,
    resetGame,
    unlockBuzzer,
    buzz,
  };
}

function TvView({ players, questions, gameState, soundReady, enableSoundNow }) {
  const registrationLink = useMemo(() => {
    const base = PUBLIC_JOIN_URL || window.location.origin;
    const url = new URL('/register', base);
    url.searchParams.set('mode', 'player');
    return url.toString();
  }, []);

  // When game is active, show the Jeopardy board on the main TV page.
  if (gameState?.status === 'active') {
  return (
    <>
        {!soundReady && (
          <div className="sound-gate">
            <div className="sound-gate-card">
              <h2>Tap to enable sound</h2>
              <p>
                This TV needs one click/tap before it can play buzzer + countdown audio.
              </p>
              <p className="muted">(Browser autoplay rule — once enabled, you’re set.)</p>
              <button className="sound-gate-btn" onClick={enableSoundNow}>
                Enable Sound
              </button>
            </div>
          </div>
        )}
        <BoardView
          players={players}
          questions={questions}
          gameState={gameState}
          // TV is display-only; picking is done by the current player's phone (or /host).
          selectCard={async () => {}}
          interactive={false}
          tvSound={true}
        />
      </>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
      <div>
          <h2>Scan to Join</h2>
          <p>Players scan this code to register and submit questions.</p>
      </div>
      </div>
      <div className="tv-grid">
        <div className="qr-card">
          <QRCodeSVG value={registrationLink} size={240} />
          <p className="muted">{registrationLink}</p>
        </div>
        <div className="status-card">
          <h3>Game Status</h3>
          <p>
            Status:{' '}
            <strong className={`pill pill-${gameState?.status || 'waiting'}`}>
              {gameState?.status || 'waiting'}
            </strong>
          </p>
          <p>Buzzer locked: {gameState?.buzzer_locked ? 'Yes' : 'No'}</p>
          {gameState?.last_buzz_player_id && (
            <p>
              Last buzz: {gameState.last_buzz_player_id} at{' '}
              {new Date(gameState.last_buzz_time).toLocaleTimeString()}
            </p>
          )}
        </div>
        <div className="list-card">
          <h3>Registered Players</h3>
          <ul className="list">
            {players.map((p) => (
              <li key={p.id}>
                <div className="person">
                  {p.photoUrl ? (
                    <img className="avatar" src={p.photoUrl} alt={p.name} />
                  ) : (
                    <div className="avatar fallback">
                      {p.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <span>{p.name}</span>
                </div>
                <Link className="muted" to={`/${p.slug}`}>
                  /{p.slug}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function PlayerPortal({ refreshPlayers, showToast }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [playerForm, setPlayerForm] = useState({ name: '', photoUrl: '' });
  const [photoFile, setPhotoFile] = useState(null);

  useEffect(() => {
    const prefName = new URLSearchParams(location.search).get('name');
    if (prefName) setPlayerForm((f) => ({ ...f, name: prefName }));
  }, [location.search]);

  async function handleRegister(e) {
    e.preventDefault();
    if (!playerForm.name.trim()) return;
    setBusy(true);
    try {
      let photo = playerForm.photoUrl.trim() || null;
      if (photoFile) {
        photo = await fileToDataUrl(photoFile);
      }

      const { data } = await axios.post(`${API_BASE}/players`, {
        name: playerForm.name.trim(),
        photoUrl: photo,
      });
      setPlayerForm({ name: '', photoUrl: '' });
      setPhotoFile(null);
      await refreshPlayers();
      showToast('Player registered');
      navigate(`/${data.slug}`);
    } catch (err) {
      console.error(err);
      showToast('Could not register player', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid single">
      <div className="panel">
        <div className="panel-header">
      <div>
            <h2>Create Player</h2>
            <p>Register with name and optional photo link.</p>
          </div>
        </div>
        <form className="form" onSubmit={handleRegister}>
          <label>
            Name
            <input
              type="text"
              value={playerForm.name}
              onChange={(e) => setPlayerForm({ ...playerForm, name: e.target.value })}
              required
            />
          </label>
          <label>
            Photo URL (optional)
            <input
              type="url"
              value={playerForm.photoUrl}
              onChange={(e) => setPlayerForm({ ...playerForm, photoUrl: e.target.value })}
              placeholder="https://example.com/photo.jpg"
            />
          </label>
          <label>
            Upload (iPhone camera/library)
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => setPhotoFile(e.target.files?.[0] || null)}
            />
          </label>
          <button type="submit" disabled={busy}>
            Register Player
        </button>
        </form>
      </div>
    </section>
  );
}

function AdminView({
  players,
  questions,
  gameState,
  events,
  buzzQueue,
  sfxMeta,
  refreshQuestions,
  refreshState,
  setCurrentQuestion,
  startGame,
  endGame,
  resetGame,
  unlockBuzzer,
  buzz,
  showToast,
}) {
  const [busy, setBusy] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState('');
  const [draft, setDraft] = useState({});
  const [turnPlayerId, setTurnPlayerId] = useState('');
  const [scorePlayerId, setScorePlayerId] = useState('');
  const [scoreDelta, setScoreDelta] = useState('');
  const [scoreSet, setScoreSet] = useState('');
  const buzzedPlayer = useMemo(() => {
    if (!gameState?.last_buzz_player_id) return null;
    return players.find((p) => p.id === gameState.last_buzz_player_id) || null;
  }, [players, gameState?.last_buzz_player_id]);

  const turnPlayer = useMemo(() => {
    if (!gameState?.turn_player_id) return null;
    return players.find((p) => p.id === gameState.turn_player_id) || null;
  }, [players, gameState?.turn_player_id]);

  async function toggleQuestionSelection(id, selected) {
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/admin/questions/${id}/select`, {
        selected,
      });
      await refreshQuestions();
      showToast(selected ? 'Question selected' : 'Question unselected');
    } catch (err) {
      console.error(err);
      showToast('Could not update question', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function setCurrentQuestion(id) {
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/game/current-question`, { questionId: id });
      await refreshState();
      showToast('Current question set');
    } catch (err) {
      console.error(err);
      showToast('Could not set question', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function updateQuestionMeta(id, category, points) {
    setBusy(true);
    try {
      const payload = {
        category: category === '' ? null : category,
        points: points === '' ? null : Number(points),
      };
      await axios.patch(`${API_BASE}/admin/questions/${id}/meta`, payload);
      await refreshQuestions();
      showToast('Updated');
    } catch (err) {
      console.error(err);
      showToast('Could not update', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function resolveCurrent(correct) {
    if (!gameState?.last_buzz_player_id) return;
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/admin/resolve-current`, {
        playerId: gameState.last_buzz_player_id,
        correct,
      });
      await Promise.all([refreshState(), refreshQuestions()]);
      showToast(correct ? 'Marked correct' : 'Marked wrong');
    } catch (err) {
      console.error(err);
      showToast('Could not resolve', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function seedDefaults() {
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/admin/seed-defaults`, { selectForGame: true });
      await refreshQuestions();
      showToast('Default questions added');
    } catch (err) {
      console.error(err);
      showToast('Could not add defaults', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function setTurn() {
    if (!turnPlayerId) return;
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/admin/set-turn`, { playerId: turnPlayerId });
      await refreshState();
      showToast('Turn updated');
    } catch (err) {
      console.error(err);
      showToast('Could not set turn', 'error');
    } finally {
      setBusy(false);
    }
  }

  const gameStatus = gameState?.status || 'unknown';
  const gameRunning = gameStatus === 'active';

  async function applyScoreDelta() {
    if (!scorePlayerId) return;
    const d = Number(scoreDelta);
    if (!Number.isFinite(d) || d === 0) return;
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/admin/players/${scorePlayerId}/score`, { delta: d });
      showToast('Score updated');
      setScoreDelta('');
    } catch (err) {
      console.error(err);
      showToast(err.response?.data?.error || 'Could not update score', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function applyScoreSet() {
    if (!scorePlayerId) return;
    const s = Number(scoreSet);
    if (!Number.isFinite(s)) return;
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/admin/players/${scorePlayerId}/score`, { score: s });
      showToast('Score set');
    } catch (err) {
      console.error(err);
      showToast(err.response?.data?.error || 'Could not set score', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function deletePlayer(id, name) {
    if (!id) return;
    const ok = window.confirm(
      `Delete player "${name}"?\n\nThis removes their profile, questions, and queued buzzes.`
    );
    if (!ok) return;
    setBusy(true);
    try {
      await axios.delete(`${API_BASE}/admin/players/${id}`);
      showToast('Player deleted');
      if (scorePlayerId === id) setScorePlayerId('');
      if (turnPlayerId === id) setTurnPlayerId('');
    } catch (err) {
      console.error(err);
      showToast(err.response?.data?.error || 'Could not delete player', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function uploadSfx(name, file) {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      await axios.post(`${API_BASE}/admin/sfx/${name}`, { dataUrl });
      showToast(`Uploaded ${name}`);
    } catch (err) {
      console.error(err);
      showToast(err.response?.data?.error || 'Could not upload sound', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function testSfx(name) {
    try {
      const meta = (sfxMeta || []).find((m) => m.name === name);
      const url = meta?.updatedAt
        ? `${API_BASE}/sfx/${name}?v=${encodeURIComponent(meta.updatedAt)}`
        : `/sfx/${name}.wav`;
      const a = new Audio(url);
      a.volume = 1.0;
      await a.play();
      showToast(`Played ${name}`);
    } catch (err) {
      console.error(err);
      showToast('Sound blocked by browser (click once then retry)', 'error');
    }
  }

  const selectedQuestions = useMemo(
    () => questions.filter((q) => q.selectedForGame),
    [questions]
  );

  const boardByCategory = useMemo(() => {
    const grouped = {};
    selectedQuestions.forEach((q) => {
      const cat = q.category || 'Uncategorized';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(q);
    });
    Object.values(grouped).forEach((arr) =>
      arr.sort((a, b) => (b.points || 0) - (a.points || 0))
    );
    return grouped;
  }, [selectedQuestions]);

  return (
    <section className="grid admin">
      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Game Control</h2>
            <p>Start, end, or reset the game and manage buzzer.</p>
          </div>
        </div>
        <div className="button-row">
          {!gameRunning && (
            <button onClick={startGame} disabled={busy}>
              Start Game
            </button>
          )}
          {gameRunning && (
            <button onClick={endGame} disabled={busy}>
              End Game
            </button>
          )}
          <button onClick={resetGame} disabled={busy}>
            Reset
          </button>
          <button onClick={unlockBuzzer} disabled={busy}>
            Unlock Buzzer
        </button>
        </div>
        <div className="state-block">
          <p>
            Status:{' '}
            <strong className={`pill pill-${gameStatus}`}>
              {gameStatus}
            </strong>
          </p>
          <p>Buzzer locked: {gameState?.buzzer_locked ? 'Yes' : 'No'}</p>
          <p>Current question: {gameState?.current_question_id || 'Not selected'}</p>
          <p>
            Turn:{' '}
            {turnPlayer ? (
              <strong>{turnPlayer.name}</strong>
            ) : (
              <span className="muted">Not set</span>
            )}
          </p>
          <p>
            Last buzz:{' '}
            {gameState?.last_buzz_player_id
              ? `${gameState.last_buzz_player_id} at ${new Date(
                  gameState.last_buzz_time
                ).toLocaleTimeString()}`
              : '—'}
          </p>
          {gameState?.last_buzz_player_id &&
            (gameState?.current_question_id || gameState?.current_is_placeholder) && (
            <div className="button-row">
              <button onClick={() => resolveCurrent(true)} disabled={busy}>
                Mark {buzzedPlayer?.name || gameState.last_buzz_player_id} Correct
              </button>
              <button onClick={() => resolveCurrent(false)} disabled={busy}>
                Mark {buzzedPlayer?.name || gameState.last_buzz_player_id} Wrong
              </button>
      </div>
          )}
        </div>

        <div className="panel-sub">
          <h4>Manual Score Adjust</h4>
          <div className="chip-row">
            <select
              value={scorePlayerId}
              onChange={(e) => setScorePlayerId(e.target.value)}
              disabled={busy}
            >
              <option value="">Choose player</option>
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.score || 0})
                </option>
              ))}
            </select>
            <input
              type="number"
              placeholder="+/- points"
              value={scoreDelta}
              onChange={(e) => setScoreDelta(e.target.value)}
              disabled={busy || !scorePlayerId}
              style={{ width: 140 }}
            />
            <button
              onClick={applyScoreDelta}
              disabled={busy || !scorePlayerId || !scoreDelta}
            >
              Apply Δ
            </button>
          </div>
          <div className="chip-row" style={{ marginTop: 8 }}>
            <input
              type="number"
              placeholder="set exact score"
              value={scoreSet}
              onChange={(e) => setScoreSet(e.target.value)}
              disabled={busy || !scorePlayerId}
              style={{ width: 180 }}
            />
            <button
              onClick={applyScoreSet}
              disabled={busy || !scorePlayerId || scoreSet === ''}
            >
              Set Score
            </button>
          </div>
        </div>

        <div className="panel-sub">
          <h4>Set Turn (first pick)</h4>
          <div className="chip-row">
            <select
              value={turnPlayerId}
              onChange={(e) => setTurnPlayerId(e.target.value)}
              disabled={busy}
            >
              <option value="">Choose player</option>
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button onClick={setTurn} disabled={busy || !turnPlayerId}>
              Set Turn
            </button>
          </div>
        </div>
      </div>

      {gameState?.last_buzz_player_id && (
        <div className="panel attention">
          <div className="panel-header">
            <div>
              <h2>Buzzed In</h2>
              <p>First buzz wins. Mark their answer.</p>
            </div>
          </div>
          <div className="attention-row">
            <div className="person">
              {buzzedPlayer?.photoUrl ? (
                <img className="avatar big" src={buzzedPlayer.photoUrl} alt={buzzedPlayer.name} />
              ) : (
                <div className="avatar fallback big">
                  {(buzzedPlayer?.name || '??').slice(0, 2).toUpperCase()}
                </div>
              )}
              <div>
                <div className="attention-name">{buzzedPlayer?.name || gameState.last_buzz_player_id}</div>
                <div className="muted">
                  {gameState.last_buzz_time
                    ? new Date(gameState.last_buzz_time).toLocaleTimeString()
                    : ''}
                </div>
              </div>
            </div>
            <div className="button-row">
              <button
                onClick={() => resolveCurrent(true)}
                disabled={
                  busy ||
                  !(gameState?.current_question_id || gameState?.current_is_placeholder)
                }
              >
                Correct ({buzzedPlayer?.name || gameState.last_buzz_player_id})
              </button>
              <button
                onClick={() => resolveCurrent(false)}
                disabled={
                  busy ||
                  !(gameState?.current_question_id || gameState?.current_is_placeholder)
                }
              >
                Wrong ({buzzedPlayer?.name || gameState.last_buzz_player_id})
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Buzz Queue</h2>
            <p>Queued buzzes (used when the current answer is wrong).</p>
          </div>
        </div>
        <ul className="list compact">
          {buzzQueue?.length ? (
            buzzQueue.map((b, idx) => (
              <li key={b.id}>
                <div className="person">
                  {b.photoUrl ? (
                    <img className="avatar" src={b.photoUrl} alt={b.playerName} />
                  ) : (
                    <div className="avatar fallback">
                      {(b.playerName || '??').slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <span>
                    {idx + 1}. {b.playerName || b.playerId}
                  </span>
                </div>
              </li>
            ))
          ) : (
            <li className="muted">No queued buzzes.</li>
          )}
        </ul>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Activity Feed</h2>
            <p>Live game events.</p>
          </div>
        </div>
        <div className="list-card scroll">
          <ul className="list compact">
            {events?.length ? (
              events.map((e) => (
                <li key={e.id}>
                  <div>
                    <div className="muted">
                      {e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : ''} ·{' '}
                      {e.type}
                    </div>
                    <div>{e.message}</div>
                  </div>
                </li>
              ))
            ) : (
              <li className="muted">No activity yet.</li>
            )}
          </ul>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Sound Effects</h2>
            <p>Upload WAV files and test playback.</p>
          </div>
        </div>
        {['buzzer', 'tick', 'correct', 'wrong'].map((name) => (
          <div key={name} className="row" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <strong style={{ width: 90, textTransform: 'capitalize' }}>{name}</strong>
            <input
              type="file"
              accept="audio/wav,audio/*"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadSfx(name, f);
                e.target.value = '';
              }}
            />
            <button onClick={() => testSfx(name)} disabled={busy}>
              Test
            </button>
            <span className="muted">
              {(sfxMeta || []).find((m) => m.name === name)?.updatedAt ? 'Custom uploaded' : 'Using default'}
            </span>
          </div>
        ))}
        <div className="muted">
          Tip: upload small WAVs. If playback is blocked, click once anywhere on the page then press Test again.
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Scoreboard</h2>
            <p>Live scores by player.</p>
          </div>
        </div>
        <ul className="list compact">
          {[...players]
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .map((p) => (
              <li key={p.id}>
                <div className="person">
                  {p.photoUrl ? (
                    <img className="avatar" src={p.photoUrl} alt={p.name} />
                  ) : (
                    <div className="avatar fallback">
                      {p.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <span>{p.name}</span>
                </div>
                <div className="button-row">
                  <span className="muted">{p.score || 0} pts</span>
                  <button className="danger" onClick={() => deletePlayer(p.id, p.name)} disabled={busy}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
        </ul>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Questions</h2>
            <p>Select which questions make it to the board.</p>
          </div>
        </div>
        {questions.length === 0 && (
          <div className="state-block">
            <p>No questions yet.</p>
            <div className="button-row" style={{ marginTop: 10 }}>
              <button onClick={seedDefaults} disabled={busy}>
                Add Default Questions
              </button>
            </div>
          </div>
        )}
        <div className="list-card scroll">
          <ul className="list">
            {questions.map((q) => (
              <li key={q.id}>
                <div>
                  <p className="muted">
                    {q.category || 'No category'}
                  </p>
                  <p className="question">{q.questionText}</p>
                  <p className="muted">Answer: {q.answer}</p>
                  <p className="muted">
                    Submitted by <Link to={`/${q.playerSlug}`}>{q.playerName}</Link>
                  </p>
                  <div className="chip-row">
                    <input
                      type="text"
                      placeholder="Category"
                      value={
                        draft[`${q.id}:category`] !== undefined
                          ? draft[`${q.id}:category`]
                          : q.category ?? ''
                      }
                      onChange={(e) =>
                        setDraft({ ...draft, [`${q.id}:category`]: e.target.value })
                      }
                      className="category-input"
                    />
                    <input
                      type="number"
                      placeholder="Points"
                      value={
                        draft[`${q.id}:points`] !== undefined
                          ? draft[`${q.id}:points`]
                          : q.points ?? ''
                      }
                      onChange={(e) =>
                        setDraft({ ...draft, [`${q.id}:points`]: e.target.value })
                      }
                      className="points-input"
                    />
                    <button
                      onClick={() =>
                        updateQuestionMeta(
                          q.id,
                          draft[`${q.id}:category`] ?? q.category ?? '',
                          draft[`${q.id}:points`] ?? q.points ?? ''
                        )
                      }
                      disabled={busy}
                    >
                      Save
                    </button>
                  </div>
                </div>
                <div className="chip-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={!!q.selectedForGame}
                      onChange={(e) => toggleQuestionSelection(q.id, e.target.checked)}
                    />
                    Select
                  </label>
                  <button onClick={() => setCurrentQuestion(q.id)} disabled={busy}>
                    Set Current
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Buzz Tester</h2>
            <p>Simulate a player buzzing in.</p>
          </div>
        </div>
        <div className="form">
          <label>
            Player slug
            <input
              type="text"
              value={selectedPlayer}
              onChange={(e) => setSelectedPlayer(e.target.value)}
              placeholder="player-name"
            />
          </label>
          <button onClick={() => buzzBySlug(selectedPlayer)} disabled={!selectedPlayer || busy}>
            Buzz In
          </button>
        </div>

        <div className="panel-sub">
          <h4>Selected Questions ({selectedQuestions.length})</h4>
          <ul className="list compact">
            {selectedQuestions.map((q) => (
              <li key={q.id}>
                <span>{q.category || 'Uncategorized'}</span>
                <span className="muted">{q.points ?? '—'} pts</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Game Board</h2>
            <p>Select a card to set the current question.</p>
          </div>
        </div>
        <div className="board">
          {Object.entries(boardByCategory).map(([cat, qs]) => (
            <div className="board-col" key={cat}>
              <div className="board-col-title">{cat}</div>
              {qs.map((q) => (
                <button
                  key={q.id}
                  className={`board-card ${
                    gameState?.current_question_id === q.id ? 'active' : ''
                  }`}
                  onClick={() => setCurrentQuestion(q.id)}
                  disabled={busy}
                >
                  <div className="board-points">{q.points ?? '—'}</div>
                  <div className="board-text">{q.questionText.slice(0, 60)}</div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );

  async function buzzBySlug(slug) {
    if (!slug) return;
    setBusy(true);
    try {
      const { data } = await axios.get(`${API_BASE}/players/${slug}`);
      await buzz(data.id);
    } catch (err) {
      console.error(err);
      showToast('Could not buzz', 'error');
    } finally {
      setBusy(false);
    }
  }
}

function PlayerProfile({ buzz, showToast }) {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [player, setPlayer] = useState(null);
  const [name, setName] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [photoFile, setPhotoFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [questionForm, setQuestionForm] = useState({
    questionText: '',
    answer: '',
    category: '',
  });

  useEffect(() => {
    load();
  }, [slug]);

  async function load() {
    try {
      const { data } = await axios.get(`${API_BASE}/players/${slug}`);
      setPlayer(data);
      setName(data.name || '');
      setPhotoUrl(data.photoUrl || '');
    } catch (err) {
      console.error(err);
      showToast('Player not found', 'error');
    }
  }

  async function saveProfile(e) {
    e.preventDefault();
    setBusy(true);
    try {
      let photo = photoUrl;
      if (photoFile) {
        photo = await fileToDataUrl(photoFile);
      }

      const { data } = await axios.patch(`${API_BASE}/players/${slug}`, {
        name,
        photoUrl: photo,
      });
      setPlayer(data);
      if (data.slug !== slug) {
        navigate(`/${data.slug}`, { replace: true });
      }
      showToast('Profile updated');
    } catch (err) {
      console.error(err);
      showToast('Could not update profile', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleQuestionSubmit(e) {
    e.preventDefault();
    if (!questionForm.questionText || !questionForm.answer) {
      showToast('Fill question and answer', 'error');
      return;
    }
    setBusy(true);
    try {
      await axios.post(`${API_BASE}/questions`, {
        playerId: player.id,
        questionText: questionForm.questionText.trim(),
        answer: questionForm.answer.trim(),
        category: questionForm.category.trim() || null,
      });
      setQuestionForm({ questionText: '', answer: '', category: '' });
      showToast('Question added');
    } catch (err) {
      console.error(err);
      showToast('Could not submit question', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!player) {
    return (
      <div className="panel">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <section className="grid single mobile">
      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>{player.name}</h2>
            <p>Your personal page</p>
          </div>
        </div>
        <div className="button-row">
          <Link className="pill-link" to={`/${player.slug}/buzzer`}>
            Go to Buzzer
          </Link>
        </div>
        <div className="state-block" style={{ marginTop: 12 }}>
          <p>
            Score: <strong>{player.score || 0}</strong>
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Edit Profile</h2>
            <p>No passwords, just your name & photo.</p>
          </div>
        </div>
        <form className="form" onSubmit={saveProfile}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Photo URL
            <input
              value={photoUrl}
              onChange={(e) => setPhotoUrl(e.target.value)}
              placeholder="https://example.com/photo.jpg"
            />
          </label>
          <label>
            Upload (iPhone camera/library)
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => setPhotoFile(e.target.files?.[0] || null)}
            />
          </label>
          <button type="submit" disabled={busy}>
            Save
          </button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Submit Question</h2>
            <p>Questions are tied to your profile.</p>
          </div>
        </div>
        <form className="form" onSubmit={handleQuestionSubmit}>
          <label>
            Question
            <textarea
              value={questionForm.questionText}
              onChange={(e) =>
                setQuestionForm({ ...questionForm, questionText: e.target.value })
              }
              required
            />
          </label>
          <label>
            Answer
            <input
              type="text"
              value={questionForm.answer}
              onChange={(e) => setQuestionForm({ ...questionForm, answer: e.target.value })}
              required
            />
          </label>
          <div className="split">
            <label>
              Category
              <input
                type="text"
                value={questionForm.category}
                onChange={(e) =>
                  setQuestionForm({ ...questionForm, category: e.target.value })
                }
                placeholder="Christmas Traditions"
              />
            </label>
          </div>
          <button type="submit" disabled={busy}>
            Submit Question
          </button>
        </form>
      </div>
    </section>
  );
}

function HostBoard({ players, questions, gameState, selectCard }) {
  return (
    <BoardView
      players={players}
      questions={questions}
      gameState={gameState}
      selectCard={selectCard}
      forcePick={true}
      interactive={true}
      tvSound={false}
    />
  );
}

function BuzzerOnly({ buzz, showToast }) {
  const { slug } = useParams();
  const [player, setPlayer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [gameState, setGameState] = useState(null);
  const [questions, setQuestions] = useState([]);

  useEffect(() => {
    load();
  }, [slug]);

  async function load() {
    try {
      const { data } = await axios.get(`${API_BASE}/players/${slug}`);
      setPlayer(data);
    } catch (err) {
      console.error(err);
      showToast('Player not found', 'error');
    }
  }

  useEffect(() => {
    // initial load
    (async () => {
      try {
        const [stateRes, qRes] = await Promise.all([
          axios.get(`${API_BASE}/game/state`),
          axios.get(`${API_BASE}/questions`),
        ]);
        setGameState(stateRes.data);
        setQuestions(qRes.data);
      } catch (err) {
        console.error(err);
      }
    })();

    // realtime updates
    const socket = ioClient(SOCKET_URL, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
    socket.on('questions:updated', (q) => setQuestions(Array.isArray(q) ? q : []));
    socket.on('game:state', (s) => setGameState(s || null));
    return () => socket.disconnect();
  }, [slug]);

  async function handleBuzz() {
    if (!player) return;
    setBusy(true);
    try {
      await buzz(player.id);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (!player) {
    return (
      <div className="panel mobile-full">
        <p>Loading...</p>
      </div>
    );
  }

  const isMyTurn = !!gameState?.turn_player_id && gameState.turn_player_id === player.id;
  const clueActive = !!gameState?.current_question_id || !!gameState?.current_is_placeholder;

  // If it's your turn and there's no active clue, show a board picker instead of the buzzer.
  if (isMyTurn && !clueActive) {
    return (
      <div className="mobile-full">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Your Turn</h2>
              <p>Pick the next clue.</p>
            </div>
          </div>
        </div>
        <BoardView
          players={[player]}
          questions={questions}
          gameState={gameState}
          interactive={true}
          selectCard={async ({ questionId, category, points }) => {
            await axios.post(`${API_BASE}/game/select-card`, {
              questionId,
              category,
              points,
              pickerPlayerId: player.id,
            });
          }}
          pickerPlayerId={player.id}
          tvSound={false}
        />
      </div>
    );
  }

  return (
    <div className="mobile-buzzer">
      <div className="buzzer-header">
        <p>{player.name}</p>
        <Link className="pill-link" to={`/${player.slug}`}>
          Profile
        </Link>
      </div>
      <div className="muted" style={{ color: 'rgba(255,255,255,0.8)' }}>
        {gameState?.turn_player_id
          ? isMyTurn
            ? 'Your turn to pick'
            : 'Wait for your turn'
          : 'Waiting for the host to set the first turn'}
      </div>
      <button className="buzzer-button" onClick={handleBuzz} disabled={busy}>
        Buzz
      </button>
    </div>
  );
}

function BoardView({
  players,
  questions,
  gameState,
  selectCard,
  forcePick = false,
  pickerPlayerId = null,
  interactive = true,
  tvSound = false,
}) {
  const money = [200, 400, 600, 800, 1000];
  const [naOpen, setNaOpen] = useState(false);
  const [naInfo, setNaInfo] = useState({ category: '', points: 0 });
  const [now, setNow] = useState(Date.now());
  const [showClue, setShowClue] = useState(true);
  const [notice, setNotice] = useState('');

  const selected = useMemo(
    () =>
      questions
        .filter((q) => q.selectedForGame)
        .filter((q) => q.category && q.points),
    [questions]
  );

  const categories = useMemo(() => {
    const counts = new Map();
    selected.forEach((q) => {
      const cat = q.category.trim();
      counts.set(cat, (counts.get(cat) || 0) + 1);
    });
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([cat]) => cat);
    while (top.length < 6) {
      top.push(`Category ${top.length + 1}`);
    }
    return top;
  }, [selected]);

  const lookup = useMemo(() => {
    const m = new Map(); // key: `${cat}|${points}` => question
    selected.forEach((q) => {
      const key = `${q.category.trim()}|${q.points}`;
      if (!m.has(key)) {
        m.set(key, q);
        return;
      }
      // If there are duplicates for the same tile, prefer an unused question so the
      // tile doesn't appear "answered" due to a different duplicate being used.
      const existing = m.get(key);
      if (existing?.usedInGame && !q.usedInGame) {
        m.set(key, q);
      }
    });
    return m;
  }, [selected]);

  // tick for countdown display
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const currentQuestion = useMemo(() => {
    if (!gameState?.current_question_id) return null;
    return questions.find((q) => q.id === gameState.current_question_id) || null;
  }, [questions, gameState?.current_question_id]);

  const buzzedPlayer = useMemo(() => {
    if (!gameState?.last_buzz_player_id) return null;
    return players.find((p) => p.id === gameState.last_buzz_player_id) || null;
  }, [players, gameState?.last_buzz_player_id]);

  const turnPlayer = useMemo(() => {
    if (!gameState?.turn_player_id) return null;
    return players.find((p) => p.id === gameState.turn_player_id) || null;
  }, [players, gameState?.turn_player_id]);

  const countdown = useMemo(() => {
    // Start 30s when someone buzzes; otherwise show 30.
    if (!gameState?.last_buzz_time) return 30;
    const started = new Date(gameState.last_buzz_time).getTime();
    const elapsed = (now - started) / 1000;
    const remaining = Math.max(0, Math.ceil(30 - elapsed));
    return remaining;
  }, [gameState?.last_buzz_time, now]);

  // TV-only ticking during countdown
  const lastTickRef = useRef(null);
  const sfx = useSfx();
  useEffect(() => {
    if (!tvSound) return;
    if (!gameState?.last_buzz_time) return;
    if (countdown <= 0) return;
    // only tick once per second value
    if (lastTickRef.current === countdown) return;
    lastTickRef.current = countdown;
    sfx.tick();
  }, [tvSound, countdown, gameState?.last_buzz_time]);

  const clueActive = !!gameState?.current_question_id || !!gameState?.current_is_placeholder;
  const clueKey = `${gameState?.current_question_id || ''}|${gameState?.current_is_placeholder || 0}|${
    gameState?.current_category || ''
  }|${gameState?.current_points || ''}`;

  useEffect(() => {
    if (clueActive) setShowClue(true);
    setNotice('');
  }, [clueKey]);

  async function handlePick(cat, pts) {
    if (!interactive) return;
    if (clueActive && !forcePick) {
      setNotice('Resolve the current clue first (Admin → Mark Correct/Wrong).');
      return;
    }
    const q = lookup.get(`${cat}|${pts}`);
    if (!q) {
      // Empty tile: backend may fill with default question; show N/A only if not.
      await selectCard({
        questionId: null,
        category: cat,
        points: pts,
        force: !!forcePick,
        pickerPlayerId,
      });
      if ((gameState?.current_clue_text || '').trim().toUpperCase() === 'N/A') {
        setNaInfo({ category: cat, points: pts });
        setNaOpen(true);
      }
      return;
    }
    if (q.usedInGame) return;
    await selectCard({
      questionId: q.id,
      category: cat,
      points: pts,
      force: !!forcePick,
      pickerPlayerId,
    });
  }

  return (
    <div className="jeopardy-screen">
      {notice && <div className="board-notice">{notice}</div>}
      <div className="jeopardy-board">
        <div className="jeopardy-row header">
          {categories.map((cat) => (
            <div key={cat} className="jeopardy-cell category">
              {cat}
            </div>
          ))}
        </div>
        {money.map((pts) => (
          <div key={pts} className="jeopardy-row">
            {categories.map((cat) => {
              const q = lookup.get(`${cat}|${pts}`);
              const isActive =
                (q && gameState?.current_question_id === q.id) ||
                (!q &&
                  gameState?.current_is_placeholder &&
                  gameState?.current_category === cat &&
                  gameState?.current_points === pts);
              const isUsed = !!q?.usedInGame;
              const disabled = isUsed || (clueActive && !forcePick);
              const CellTag = interactive ? 'button' : 'div';
              return (
                <CellTag
                  key={`${cat}|${pts}`}
                  className={`jeopardy-cell money ${
                    isUsed ? 'used' : ''
                  } ${isActive ? 'active' : ''} ${interactive ? '' : 'readonly'}`}
                  {...(interactive ? { onClick: () => handlePick(cat, pts), disabled } : {})}
                >
                  {!isUsed ? `$${pts}` : `$${pts}`}
                </CellTag>
              );
            })}
          </div>
        ))}
      </div>

      {clueActive && showClue && (
        <div className="clue-overlay">
          <div className="clue-card">
            <div className="clue-top">
              <div className="clue-meta">
                <div className="clue-cat">{gameState?.current_category || ''}</div>
                <div className="clue-pts">
                  {gameState?.current_points ? `$${gameState.current_points}` : ''}
                </div>
              </div>
              <div className={`clue-timer ${countdown === 0 ? 'done' : ''}`}>
                {countdown}s
              </div>
            </div>

            <div className="clue-text">
              {currentQuestion?.questionText ||
                gameState?.current_clue_text ||
                'N/A'}
            </div>

            <div className="buzz-strip">
              {buzzedPlayer ? (
                <div className="person">
                  {buzzedPlayer.photoUrl ? (
                    <img className="avatar big" src={buzzedPlayer.photoUrl} alt={buzzedPlayer.name} />
                  ) : (
                    <div className="avatar fallback big">
                      {buzzedPlayer.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="buzzed-name">{buzzedPlayer.name} buzzed first</div>
                </div>
              ) : (
                <div className="muted">Waiting for someone to buzz…</div>
              )}
            </div>
            <div className="score-strip">
              <div className="muted" style={{ color: 'rgba(255,255,255,0.8)' }}>
                Turn: {turnPlayer ? turnPlayer.name : '—'}
              </div>
              <div className="scoreboard-mini">
                {[...players]
                  .sort((a, b) => (b.score || 0) - (a.score || 0))
                  .slice(0, 6)
                  .map((p) => (
                    <div key={p.id} className="score-pill">
                      <span className="score-name">{p.name}</span>
                      <span className="score-val">{p.score || 0}</span>
                    </div>
                  ))}
              </div>
            </div>
            {interactive && (
              <div className="button-row" style={{ marginTop: 14, justifyContent: 'center' }}>
                <button onClick={() => setShowClue(false)}>Hide Clue</button>
                <Link className="pill-link" to="/admin">
                  Go to Admin
                </Link>
              </div>
            )}
          </div>
        </div>
      )}

      {naOpen && (
        <div className="modal-backdrop" onClick={() => setNaOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>N/A</h2>
            <p>
              No question exists for <strong>{naInfo.category}</strong> at{' '}
              <strong>${naInfo.points}</strong>.
            </p>
            <button onClick={() => setNaOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PlayersPage({ players }) {
  const sorted = useMemo(() => {
    return [...players].sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''))
    );
  }, [players]);

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Players</h2>
          <p>Select your profile to rejoin.</p>
        </div>
      </div>

      <ul className="list">
        {sorted.map((p) => (
          <li key={p.id} className="player-row">
            <Link className="person" to={`/${p.slug}`}>
              {p.photoUrl ? (
                <img className="avatar" src={p.photoUrl} alt={p.name} />
              ) : (
                <div className="avatar fallback">{p.name.slice(0, 2).toUpperCase()}</div>
              )}
              <span>{p.name}</span>
            </Link>
            <Link className="muted" to={`/${p.slug}/buzzer`}>
              Buzzer
            </Link>
          </li>
        ))}
        {sorted.length === 0 && <li className="muted">No players yet. Go register.</li>}
      </ul>
    </section>
  );
}

function App() {
  const { toast, showToast } = useToast();
  const location = useLocation();
  const tvMode = location.pathname === '/' || location.pathname === '/board';
  const game = useGameData(showToast, { enableSfx: tvMode });

  return (
    <div className={`app ${tvMode ? 'tv' : ''}`}>
      <header className="topbar">
        <div>
          <h1>Metro Christmas Jeopardy</h1>
          <p className="subtitle">TV display, player portal, and admin control</p>
        </div>
        {!tvMode && (
          <nav className="tabs">
            <Link className="tab-link" to="/">
              TV
            </Link>
            <Link className="tab-link" to="/players">
              Players
            </Link>
            <Link className="tab-link" to="/register">
              Register
            </Link>
            <Link className="tab-link" to="/admin">
              Admin
            </Link>
            <Link className="tab-link" to="/host">
              Host
            </Link>
          </nav>
        )}
      </header>

      {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}

      <main>
        <Routes>
          <Route
            path="/"
            element={
              <TvView
                players={game.players}
                questions={game.questions}
                gameState={game.gameState}
                soundReady={game.soundReady}
                enableSoundNow={game.enableSoundNow}
              />
            }
          />
          <Route
            path="/board"
            element={
              <TvView
                players={game.players}
                questions={game.questions}
                gameState={game.gameState}
                soundReady={game.soundReady}
                enableSoundNow={game.enableSoundNow}
              />
            }
          />
          <Route
            path="/host"
            element={
              <HostBoard
                players={game.players}
                questions={game.questions}
                gameState={game.gameState}
                selectCard={game.selectCard}
              />
            }
          />
          <Route
            path="/players"
            element={<PlayersPage players={game.players} />}
          />
          <Route
            path="/register"
            element={
              <PlayerPortal
                refreshPlayers={game.refreshPlayers}
                showToast={showToast}
              />
            }
          />
          <Route path="/player" element={<Navigate to="/register" replace />} />
          <Route
            path="/admin"
            element={
              <AdminView
                players={game.players}
                questions={game.questions}
                gameState={game.gameState}
                events={game.events}
                buzzQueue={game.buzzQueue}
                sfxMeta={game.sfxMeta}
                refreshQuestions={game.refreshQuestions}
                refreshState={game.refreshState}
                setCurrentQuestion={game.setCurrentQuestion}
                startGame={game.startGame}
                endGame={game.endGame}
                resetGame={game.resetGame}
                unlockBuzzer={game.unlockBuzzer}
                buzz={game.buzz}
                showToast={showToast}
              />
            }
          />
          <Route
            path="/:slug"
            element={<PlayerProfile buzz={game.buzz} showToast={showToast} />}
          />
          <Route
            path="/:slug/buzzer"
            element={<BuzzerOnly buzz={game.buzz} showToast={showToast} />}
          />
        </Routes>
      </main>
    </div>
  );
}

export default App;
