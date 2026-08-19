# Plan: Chat voice compose

**Goal:** `docs/goals/chat-voice-compose.md`
**Status:** done

Slice rules: one checkbox = one new agent. Touch ~1–3 files. Name a verify command. Stop after the item.

## Slices

- [x] **S0 — Goal and plan files**
  - Area: `docs/goals/chat-voice-compose.md`, `docs/plans/chat-voice-compose.md`
  - Verify: files exist and match this plan
  - Done when: workers can follow the markdown without this chat
  - Notes:

- [x] **S1 — Recorded-voice File helper**
  - Area: `bot-admin-ui/src/lib/ticket-chat.ts`, `bot-admin-ui/src/lib/ticket-chat.test.ts`
  - Verify: `npm test --prefix bot-admin-ui -- src/lib/ticket-chat.test.ts`
  - Done when: tests lock the extension/mime mapping so `.webm` video classification cannot happen
  - Notes: `recordedVoiceFile(blob)` → `.weba` + `audio/webm`, or `.m4a` + `audio/mp4` when the blob type is mp4/aac.

- [x] **S2 — Backend weba mime**
  - Area: `src/ai/chat-uploads.js`, `test/ai-chat-integration.test.js`
  - Verify: `node --test test/ai-chat-integration.test.js`
  - Done when: a weba upload without client `mime_type` still classifies as audio and gets an audio mime
  - Notes: Add `weba: 'audio/webm'` (and `oga`/`opus` if missing) to `MIME_BY_EXTENSION`.

- [x] **S3 — Mic in ChatCompose**
  - Area: `bot-admin-ui/src/components/ChatCompose.tsx`, `bot-admin-ui/src/styles.css`
  - Verify: `npm test --prefix bot-admin-ui -- src/lib/ticket-chat.test.ts` and `npm run build --prefix bot-admin-ui`
  - Done when: Ops / KB / Test / AI-assist composers show a mic with no page-level changes
  - Notes: `allowRecord` defaults to `allowFiles`. On stop: `addFiles` if `allowFiles`, always `onRecordedFile?.(file)`. Include `mime_type` from `file.type`.

- [x] **S4 — Ticket customer chat**
  - Area: `bot-admin-ui/src/pages/TicketDetailPage.tsx`
  - Verify: `npm run build --prefix bot-admin-ui`
  - Done when: ticket composer can record, attach, and send a voice file through `POST /bot-admin/api/tickets/:id/messages`
  - Notes: Pass `allowRecord` and `onRecordedFile`. Include `mime_type` on send. Pending-row `<audio>` preview when `isChatAudio`.
