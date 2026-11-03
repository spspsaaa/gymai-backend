# GYM AI backend

Server for the GYM AI mini app: Telegram auth, state sync, live AI coach.

## Endpoints
- `GET /health`
- `POST /api/auth`  `{initData}` -> `{token, user}`
- `GET /api/state` (Bearer) -> `{state}`
- `PUT /api/state` (Bearer) `{state}` -> ok
- `POST /api/coach` (Bearer) `{message, lang, history, initData}` -> `{reply}`
- `POST /api/admin/plan` header `x-admin-secret` `{telegram_id, plan}` -> grant/revoke Pro

## Env
BOT_TOKEN, TURSO_URL, TURSO_TOKEN, AI_API_KEY, AI_MODEL, AI_BASE, WEBAPP_URL, ADMIN_SECRET, PORT, FREE_COACH_LIMIT.

Without TURSO_* the server stores data in `data/gymai.json` (fine for local dev only).

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render -> New -> Web Service -> pick the repo -> Environment = Free.
3. Add all env vars above.
4. Health Check Path: `/health`.
5. After deploy, set the API base URL in the mini app (see below).

## Point the mini app at the backend
The app currently calls `/api/...` (same origin). Either:
- serve the app from this same server (mount the static folder), or
- set the API base in `index.html`: replace `'/api/` with the full backend URL.

Simplest: in the app's script, set `const API_BASE='https://your-backend.onrender.com';`
and use `fetch(API_BASE + '/api/...')`.
