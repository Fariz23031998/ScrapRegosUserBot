# Deploy this commit

The server and the bot still start from `apps/server/index.js` and `apps/bot/index.js`. Those files now load the TypeScript sources through the `tsx` package, so install dependencies before restarting. Leave `.env` as it is.

On the server, in `/srv/ScrapRegosUserBot`:

```bash
git fetch origin
git checkout typescript-admin-sort
git pull

npm ci
npm ci --prefix bot-admin-ui
npm run bot-admin-ui:build

sudo systemctl restart scrapregos-server
sudo nginx -t && sudo systemctl reload nginx
```

Restart the Telegram bot the same way you usually do. On Windows that service is `ScrapRegosUserBot` (`node apps/bot/index.js`). It needs the new `tsx` dependency from `npm ci`.

Node.js 22 or newer is required. The systemd unit does not need a new start command.
