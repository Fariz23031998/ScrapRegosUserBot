# Bot Admin UI (React)

React/TypeScript admin panel served at `/bot-admin/`. This is the production UI; the legacy vanilla files in `public/bot-admin/` remain only as an emergency fallback.

## Development

1. Copy `.env.example` to `.env` and set the backend origin. For phone/LAN testing use the machine IP, not `localhost`:

```env
VITE_API_BASE_URL=http://10.148.213.195:3000
```

2. Start the main server (default port 3000):

```bash
npm run server
```

3. In another terminal, start the Vite dev server:

```bash
npm run bot-admin-ui:dev
```

Open http://localhost:5301/bot-admin/ (trailing slash) with the backend running. On a phone on the same Wi-Fi, open http://10.148.213.195:5301/bot-admin/. The browser calls same-origin `/bot-admin/api/*`; Vite proxies those to `VITE_API_BASE_URL`. Deep links such as `/bot-admin/tickets` should be opened under that base path.

## Production

Build the SPA (leave `VITE_API_BASE_URL` empty for same-origin):

```bash
npm run bot-admin-ui:build
```

Restart `npm run server`. When `bot-admin-ui/dist/index.html` exists, `/bot-admin/*` serves the React SPA automatically. No extra env flag is required.

Dev-only `.env` values are not used by `vite build` unless you also set them in `.env.production`.

## Emergency rollback

Set `BOT_ADMIN_USE_LEGACY_UI=1` and restart to force `public/bot-admin/` HTML pages. Remove the flag (and keep a fresh `bot-admin-ui:build`) to return to the React UI.

## Stack

- React 19 + TypeScript + Vite
- React Router, TanStack Query, TanStack Table
- Sidebar navigation, column resize/reorder/visibility, persisted table prefs (IndexedDB)
