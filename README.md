# metro-xmas

React + Node/Express + SQLite Jeopardy-style party game with realtime (Socket.IO) registration + buzzer.

## Run

```bash
make dev
```

## Routes
- **`/`**: TV view (QR + lobby; shows board when game is active)
- **`/register`**: player registration
- **`/:slug`**: player profile
- **`/:slug/buzzer`**: player buzzer (shows board picker when it’s your turn)
- **`/admin`**: admin controls + activity feed
- **`/board`**: board view override

## Notes
- SQLite DB lives at `backend/data/game.db` (ignored by git).

