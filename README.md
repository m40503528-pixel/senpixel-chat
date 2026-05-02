# Senpixel

Local realtime messenger running on `Node.js`, `ws` and `SQLite`.

## What Is In The App

- single-page entry screen with `Welcome to Senpixel`
- messenger opens inside the same page with no redirect
- local room encryption through Web Crypto
- signed device identities
- typing state, reactions, pins, saved messages and burn timers
- rich encrypted messages with markdown, code snippets and media/file cards
- profile status, avatar emoji, room invites, room favorites, command deck and local settings
- one-shot launcher script for Windows

## Local Run

1. Install `Node.js 22+`.
2. Install dependencies:

```powershell
npm install
```

3. Start the relay:

```powershell
npm start
```

4. Or use the launcher:

```powershell
.\start_citadel.ps1
```

5. Open:

```text
http://127.0.0.1:8000
```

The local database is stored in `./senpixel.db`.

## Main Routes

- `/` app shell
- `/messenger` same app shell
- `/api/bootstrap/{user}` initial snapshot
- `/api/launch` one-time launch token
- `/api/launch/{token}` launch token consume
- `/api/health` health check
- `/ws/{user}` realtime websocket

## Notes

- the active local server is `server.js`
- room secrets stay on the client unless you pass one through the launcher
- the relay stores ciphertext and metadata, not plaintext
- a single laptop can run this comfortably for development and small live use, but `10000+` real concurrent users is not something to promise without external infrastructure, load testing and a stronger deployment target
