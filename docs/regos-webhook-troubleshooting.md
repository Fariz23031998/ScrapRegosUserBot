# Troubleshooting REGOS webhooks on Ubuntu

The production webhook URL is:

```text
https://aserver.tech/api/regos/webhook
```

The request path is:

```text
REGOS -> nginx :443 -> 127.0.0.1:3000 -> Express webhook handler
```

Use the checks below in order to find where delivery stops.

## 1. Confirm the current version is deployed

```bash
cd /srv/ScrapRegosUserBot
git log -1 --oneline
git status --short
```

Confirm that the HTTP service is running:

```bash
sudo systemctl status scrapregos-server --no-pager
sudo ss -ltnp | grep ':3000'
```

Expected result: `scrapregos-server` is active and Node listens on port `3000`.

If necessary:

```bash
sudo systemctl restart scrapregos-server
sudo journalctl -u scrapregos-server -n 100 --no-pager
```

## 2. Confirm the nginx route is installed

The repository configuration must be copied into nginx after deployment:

```bash
sudo cp /srv/ScrapRegosUserBot/deploy/aserver.tech \
  /etc/nginx/sites-available/aserver.tech
sudo ln -sf /etc/nginx/sites-available/aserver.tech \
  /etc/nginx/sites-enabled/aserver.tech
sudo nginx -t
sudo systemctl reload nginx
```

Inspect the effective configuration:

```bash
sudo nginx -T 2>/dev/null |
  grep -A 12 -F 'location = /api/regos/webhook'
```

It must proxy to:

```text
http://127.0.0.1:3000/api/regos/webhook
```

## 3. Watch whether REGOS reaches nginx

Open a terminal and follow only webhook requests:

```bash
sudo tail -F /var/log/nginx/access.log |
  grep --line-buffered '/api/regos/webhook'
```

Then trigger a ticket event in REGOS.

Typical access-log status codes:

- `200`: nginx reached the application and received a response.
- `404`: the deployed nginx configuration does not contain the webhook route,
  or REGOS is calling the wrong URL.
- `502`: nginx received the request, but the Node server is not reachable on
  port `3000`.
- `499`: REGOS disconnected before the application responded.
- `500`: an unexpected server error occurred.

If no line appears, the request did not reach this nginx server. Check the URL
configured in REGOS, DNS, HTTPS certificate, firewall, and REGOS delivery logs.

Also inspect nginx errors:

```bash
sudo tail -F /var/log/nginx/error.log
```

## 4. Watch the application logs

In another terminal:

```bash
sudo journalctl -u scrapregos-server -f -o cat
```

Useful webhook messages include:

```text
[regos-webhook] Rejected webhook with unknown connected_integration_id
[regos-webhook] Failed to process TicketEdited for ticket ...
```

A successful webhook is not logged by default. Use the nginx `200` access-log
entry or the HTTP response checks below to prove successful routing.

## 5. Test nginx and the application without changing a ticket

Load the integration token without printing it:

```bash
cd /srv/ScrapRegosUserBot
REGOS_TOKEN="$(
  sudo -u app node -e \
    "require('dotenv').config({path:'.env'}); process.stdout.write(process.env.REGOS_INTEGRATION_TOKEN || '')"
)"
test -n "$REGOS_TOKEN" && echo "REGOS token is configured"
```

Send an ignored test action through the public nginx URL:

```bash
curl --silent --show-error --include \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  https://aserver.tech/api/regos/webhook <<JSON
{
  "action": "HandleWebhook",
  "event_id": "manual-route-test-$(date +%s)",
  "connected_integration_id": "$REGOS_TOKEN",
  "data": {
    "action": "WebhookRouteTest",
    "data": {}
  }
}
JSON
```

Expected response:

```json
{"ok":true,"message":"Event ignored"}
```

This proves that HTTPS, nginx, Express routing, JSON parsing, and integration
token validation all work. It deliberately does not fetch or modify a ticket.

Test Node directly, bypassing nginx:

```bash
curl --silent --show-error --include \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  http://127.0.0.1:3000/api/regos/webhook <<JSON
{
  "action": "HandleWebhook",
  "event_id": "manual-local-test-$(date +%s)",
  "connected_integration_id": "$REGOS_TOKEN",
  "data": {
    "action": "WebhookRouteTest",
    "data": {}
  }
}
JSON
```

Interpretation:

- Local test works, public test fails: nginx, DNS, TLS, or firewall problem.
- Both tests fail: Node service, environment, or application routing problem.
- Both return `Event ignored`: the route works; inspect the actual REGOS event.

Remove the token from the current shell when finished:

```bash
unset REGOS_TOKEN
```

## 6. Test real ticket event processing

Use an existing ticket ID. This simulates a notification only; it does not edit
the ticket:

```bash
read -rp 'Existing REGOS ticket ID: ' TICKET_ID
cd /srv/ScrapRegosUserBot
REGOS_TOKEN="$(
  sudo -u app node -e \
    "require('dotenv').config({path:'.env'}); process.stdout.write(process.env.REGOS_INTEGRATION_TOKEN || '')"
)"

curl --silent --show-error --include \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  https://aserver.tech/api/regos/webhook <<JSON
{
  "action": "HandleWebhook",
  "event_id": "manual-ticket-test-$(date +%s)",
  "occurred_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "connected_integration_id": "$REGOS_TOKEN",
  "data": {
    "action": "TicketEdited",
    "data": {
      "id": $TICKET_ID
    }
  }
}
JSON

unset REGOS_TOKEN TICKET_ID
```

Expected response:

```json
{"ok":true,"message":"Webhook processed"}
```

Open `/bot-admin/tickets` before running the command. The ticket table, summary,
pagination, and current active ticket should refresh through SSE.

## 7. Verify the SSE connection

In browser developer tools:

1. Open `https://aserver.tech/bot-admin/tickets`.
2. Open **Network** and filter for `events`.
3. Select `/bot-admin/api/tickets/events`.
4. Confirm status `200` and content type `text/event-stream`.
5. Confirm heartbeat data arrives about every 30 seconds.
6. Trigger a ticket event and look for a `ticket_changed` frame.

Expected event shape:

```json
{
  "type": "ticket_changed",
  "ticket_id": 123,
  "responsible_user_id": 45,
  "source_action": "TicketEdited",
  "occurred_at": "2026-08-09T11:00:00Z"
}
```

If the stream connects but events arrive only after a long delay, confirm the
exact SSE nginx location contains:

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 1h;
```

## 8. Check the actual REGOS payload

Supported actions:

```text
TicketAdded
TicketEdited
TicketResponsibleSet
TicketParticipantsSet
TicketStatusSet
TicketClosed
```

Required payload structure:

```json
{
  "action": "HandleWebhook",
  "event_id": "stable-event-id",
  "connected_integration_id": "same value as REGOS_INTEGRATION_TOKEN",
  "data": {
    "action": "TicketEdited",
    "data": {
      "id": 123
    }
  }
}
```

Important checks:

- `connected_integration_id` must equal `REGOS_INTEGRATION_TOKEN`.
- `data.action` must be one of the supported actions.
- `data.data.id` must be a positive ticket ID.
- Repeated `event_id` values are ignored for approximately one hour.
- REGOS must use `POST`, not `GET`.

## 9. Quick diagnosis table

| Observation | Most likely cause |
| --- | --- |
| No nginx access entry | Wrong REGOS URL, DNS, firewall, or TLS |
| nginx `404` | Webhook location not deployed/reloaded |
| nginx `502` | `scrapregos-server` stopped or wrong port |
| `Unknown connected_integration_id` | Token mismatch or stale service environment |
| `Event ignored` for a real event | Unsupported or incorrectly nested action |
| `Missing ticket id` | Missing/invalid `data.data.id` |
| `Failed to process webhook` | REGOS `Ticket/Get` failed; inspect application logs |
| Webhook returns `200`, UI does not update | Check SSE request and nginx buffering |
| Duplicate response | REGOS retried the same `event_id`; this is expected |

