# metro-xmas

React + Node/Express + SQLite Jeopardy-style party game with realtime (Socket.IO) registration + buzzer.

## Run

```bash
make dev
```

## Important: database safety
- **Your game data lives in** `backend/data/game.db` (players/questions/scores/state).
- **`make clean` does NOT delete the DB** (safe for real users).
- Only **`make db-clean`** deletes the DB. **Do not run this during/after a real session** unless you truly want to wipe everything.

## Routes
- **`/`**: TV view (QR + lobby; shows board when game is active)
- **`/register`**: player registration
- **`/players`**: pick your player when rejoining
- **`/:slug`**: player profile
- **`/:slug/buzzer`**: player buzzer (shows board picker when it’s your turn)
- **`/admin`**: admin controls + activity feed
- **`/board`**: TV board view (same behavior as `/`)
- **`/host`**: host-only override board (force pick tiles)

## Notes
- **TV audio**: browsers require one user gesture before audio can play.
  - On TV routes, the app will show a “Tap to enable sound” gate until audio is enabled.
- **Admin** can delete players (also removes their questions and queued buzzes).

