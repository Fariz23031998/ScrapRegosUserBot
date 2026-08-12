# Bot Admin UI (React)

React/TypeScript rebuild of the Bot Admin panel. The legacy vanilla UI in `public/bot-admin/` remains untouched.

## Development

1. Start the main server (default port 3000):

```bash
npm run server
```

2. In another terminal, start the Vite dev server:

```bash
npm run bot-admin-ui:dev
```

Open http://localhost:5301/bot-admin/ — API requests are proxied to the backend.

## Production cutover

1. Build the SPA:

```bash
npm run bot-admin-ui:build
```

2. Enable the React UI on the server:

```env
BOT_ADMIN_USE_REACT_UI=1
```

3. Restart the server. `/bot-admin/*` will serve the built SPA from `bot-admin-ui/dist/`.

## Rollback

Remove or set `BOT_ADMIN_USE_REACT_UI=0` and restart. The server falls back to `public/bot-admin/` HTML pages.

## Stack

- React 19 + TypeScript + Vite
- React Router, TanStack Query, TanStack Table
- Sidebar navigation, column resize/reorder/visibility, persisted table prefs (IndexedDB)
