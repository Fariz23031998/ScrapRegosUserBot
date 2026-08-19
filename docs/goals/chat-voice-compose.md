# Goal: Chat voice compose

**Id:** `chat-voice-compose`
**Status:** done

## Outcome

Staff can record a voice clip from every React message input that already sends chat text or files (ticket chat, ticket AI assist, Ops, Knowledge, customer/employee test agents). The clip is attached as a normal chat file (`.weba` / `.m4a`), sent through existing upload endpoints, played back in the thread, and transcribed for AI agents.

## Acceptance

- [x] Mic on: ticket chat, ticket AI assist, Ops FAB, Knowledge chat, customer/employee test chats
- [x] Recorded clip sends as audio (`weba`/`m4a`), plays in the thread, and is transcribed for AI agents
- [x] `npm test --prefix bot-admin-ui`
- [x] `node --test test/ai-chat-integration.test.js`

## Out of scope

- Telegram customer composer (native voice already ingested)
- Outbound `sendVoice` to Telegram
- Legacy `public/bot-admin/admin-ticket-detail.js`
- Hold-to-record, waveform, AI-generated audio replies

## Notes

Chrome `MediaRecorder` often emits `audio/webm` or `video/webm`. Extension `.webm` is treated as video. Always wrap as `voice-<ts>.weba` with `type: "audio/webm"` (Safari `audio/mp4` → `.m4a`).
