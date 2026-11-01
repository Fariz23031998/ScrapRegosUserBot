import type { Unchecked } from '../src/types/unchecked';
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../src/db/partners-db';
import { createEmployeeUser, setBotUserRegosLink, DEFAULT_RIGHTS } from '../src/db/bot-users-db';
import { loadAiSettings, saveAiSettings, serializeAiSettings, resolveAgentModel, resolveAgentMaxSteps, SUMMARY_TOKEN_BUDGET } from '../src/ai/settings';
import { CUSTOMER_SYSTEM_PROMPT, CUSTOMER_TEST_PROMPT_SUFFIX, CUSTOMER_ASSIST_PROMPT_SUFFIX, KB_SYSTEM_PROMPT, OPS_SYSTEM_PROMPT, TICKET_SUMMARY_SYSTEM_PROMPT } from '../src/ai/default-prompts';
import { getProvider, registerProvider, listProviders } from '../src/ai/providers/registry';
import { buildChatRequest, consumeChatStream, normalizeChatContent, normalizeUsage } from '../src/ai/providers/openai';
import { runAgent, resolveAgentTimeoutMs, prependUserContext, buildPromptCacheKey } from '../src/ai/run-agent';
import { listKnowledgeArticles, getKnowledgeArticle, createKnowledgeArticle, updateKnowledgeArticle, deleteKnowledgeArticle, createKnowledgeCategory, knowledgeCategoryContext, setKnowledgeArticleConfirmed } from '../src/db/knowledge-articles';
import { listPrompts, getResolvedPrompt, savePrompt, resetPrompt, createPrompt, updatePrompt, setActivePrompt, deletePrompt, ensureAiPromptsTable, DEFAULT_PROMPT_NAME } from '../src/db/ai-prompts';
import { createKnowledgeTools } from '../src/ai/tools/knowledge';
import { createCustomerTools } from '../src/ai/tools/customer';
import { classifyChatFile, downloadChatFile, isVisionImage, toImageUrlPart } from '../src/ai/chat-media';
import { transcribeChatAudio, clearTranscribeCache } from '../src/ai/transcribe';
import { parseChatUploadFiles, toPublicAttachments } from '../src/ai/chat-uploads';
import { captionChatImage, clearCaptionCache } from '../src/ai/image-caption';
import { getChatFileExtraction, upsertChatFileExtraction } from '../src/db/chat-file-extractions';
import { assertSafeBrowseUrl, browseUrl, classifyBrowseHost, htmlToText, parseDuckDuckGoResults, unwrapDuckDuckGoUrl, webSearch } from '../src/ai/tools/browse';
import { findEmployeesForAgent, isEmployeeClientPhone } from '../src/ai/tools/employees';
import { evaluateCustomerMessageGate, evaluateCustomerMessageGateWithDb, handleCustomerChatMessage, previewCustomerAgentPrompt, resetCustomerAgentLocks, pickTriggerMessage } from '../src/ai/customer-agent';
import { runKbAgent } from '../src/ai/kb-agent';
import { loadCustomerTestSession, runCustomerTestAgent, resetCustomerTestLocks } from '../src/ai/customer-test-agent';
import { loadEmployeeTestSession, runEmployeeTestAgent, resetEmployeeTestLocks } from '../src/ai/employee-test-agent';
import { loadTicketAssistSession, runTicketAssistAgent, previewTicketAssistPrompt, resetTicketAssistLocks } from '../src/ai/customer-assist-agent';
import { upsertTelegramTicketSession } from '../src/db/telegram-ticket-sessions';
import { createRegosTicketWebhookHandler } from '../src/integrations/regos-ticket-webhook';
import { upsertTicketSummary } from '../src/db/ticket-summaries';
import { setTicketAiStopped, getCustomerReplyCount, isTicketAiStopped, incrementCustomerReplyCount } from '../src/db/ticket-ai-state';
import { countCustomerUsageSince, resolveCustomerUsageKey, recordCustomerUsage } from '../src/db/ai-customer-usage';
import { ADMIN_PERMISSION_KEYS, RIGHTS } from '../src/db/user-rights';
import { listCustomerTestSessions, deleteCustomerTestSession, clearCustomerTestSessions } from '../src/db/customer-agent-sessions';

let db: any = null;
let dbPath: any = null;

function removeDbFiles(filePath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${filePath}${suffix}`);
    } catch {
      // Ignore missing temporary files.
    }
  }
}

function createDb() {
  dbPath = path.join(
    os.tmpdir(),
    `scrapregos-ai-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
  db = openDb(dbPath);
  return db;
}

afterEach(() => {
  resetCustomerAgentLocks();
  resetCustomerTestLocks();
  resetEmployeeTestLocks();
  resetTicketAssistLocks();
  clearTranscribeCache();
  clearCaptionCache();
  db?.close();
  db = null;
  if (dbPath) removeDbFiles(dbPath);
  dbPath = null;
});


describe('chat media helpers', () => {
  it('classifies vision-safe images and skips svg/audio/video', () => {
    assert.equal(isVisionImage({ name: 'a.png', mime_type: 'image/png' }), true);
    assert.equal(isVisionImage({ name: 'a.svg', mime_type: 'image/svg+xml' }), false);
    assert.equal(classifyChatFile({ name: 'clip.mp4', media_type: 'video' }), 'video');
    assert.equal(classifyChatFile({ name: 'note.ogg', mime_type: 'audio/ogg' }), 'audio');
    assert.equal(classifyChatFile({ name: 'voice.weba' }), 'audio');
    assert.equal(classifyChatFile({ name: 'voice.weba', extension: 'weba' }), 'audio');
    const part = toImageUrlPart({ mime: 'image/jpeg', base64: 'abc' });
    assert.equal(part!.type, 'image_url');
    assert.equal(part!.image_url.url, 'data:image/jpeg;base64,abc');
  });

  it('maps weba uploads without mime_type to audio/webm', () => {
    const files = parseChatUploadFiles([
      { name: 'voice.weba', extension: 'weba', data: Buffer.from('abc').toString('base64') },
    ]);
    assert.equal(files[0].kind, 'audio');
    assert.equal(files[0].mime_type, 'audio/webm');
    const [pub] = toPublicAttachments(files);
    assert.equal(pub.kind, 'audio');
    assert.match(pub.data_url, /^data:audio\/webm;base64,/);
  });

  it('skips unsafe or oversized downloads', async () => {
    const unsafe = await downloadChatFile({ url: 'file:///etc/passwd' });
    assert.equal((unsafe as any).skipped, true);
    assert.equal((unsafe as any).reason, 'unsafe_url');

    const oversized = await downloadChatFile(
      { url: 'https://files.example/big.png', mime_type: 'image/png' },
      {
        fetchImpl: async () => ({
          ok: true,
          headers: { get: (name?: any) => (name === 'content-length' ? String(9 * 1024 * 1024) : null) },
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
        }),
      }
    );
    assert.equal((oversized as any).skipped, true);
    assert.equal((oversized as any).reason, 'too_large');
  });
});

describe('read_chat_image tool', () => {
  it('rejects audio/video and returns vision parts for images', async () => {
    const database = createDb();
    const filesById: Map<any, any> = new Map([
      [
        1,
        {
          id: 1,
          name: 'shot.png',
          extension: 'png',
          mime_type: 'image/png',
          url: 'https://files.example/shot.png',
        },
      ],
      [
        2,
        {
          id: 2,
          name: 'clip.mp4',
          extension: 'mp4',
          mime_type: 'video/mp4',
          media_type: 'video',
          url: 'https://files.example/clip.mp4',
        },
      ],
    ]);
    const tools = createCustomerTools({
      db: database,
      chatId: 'chat-1',
      filesById,
      deps: {
        downloadChatFile: async () => ({ mime: 'image/png', base64: 'abc' }),
      },
    });
    const readImage = tools.find((tool?: any) => tool.name === 'read_chat_image');
    const video = await readImage!.execute({ file_id: 2 });
    assert.equal(video.ok, false);
    assert.equal(video.error, 'not_an_image');
    assert.equal(video.kind, 'video');

    const image = await readImage!.execute({ file_id: 1 });
    assert.equal(image.ok, true);
    assert.equal(image.file.id, 1);
    assert.equal(image._visionParts[0].type, 'image_url');
  });
});

describe('close_ticket tool', () => {
  it('rejects a missing ticket, closes an open ticket, and no-ops when already closed', async () => {
    const database = createDb();
    const missing = createCustomerTools({ db: database }).find((tool?: any) => tool.name === 'close_ticket');
    assert.deepEqual(await missing!.execute(), { ok: false, error: 'missing_ticket' });

    let closed: any = null;
    const closer = createCustomerTools({
      db: database,
      ticket: { id: 42, status: 'Open' },
      deps: {
        setTicketStatus: async (ticketId?: any, status?: any) => {
          closed = { ticketId, status };
          return { ok: true };
        },
      },
    }).find((tool?: any) => tool.name === 'close_ticket');
    assert.deepEqual(await closer!.execute(), { ok: true, status: 'Closed' });
    assert.deepEqual(closed, { ticketId: 42, status: 'Closed' });

    closed = 'unchanged';
    const already = createCustomerTools({
      db: database,
      ticket: { id: 42, status: 'Closed' },
      deps: {
        setTicketStatus: async () => {
          closed = 'called';
          return { ok: true };
        },
      },
    }).find((tool?: any) => tool.name === 'close_ticket');
    assert.deepEqual(await already!.execute(), { ok: true, already_closed: true });
    assert.equal(closed, 'unchanged');
  });
});

describe('update_ticket tool', () => {
  function findUpdateTicket(database: any, ticket: any, deps: any = {}) {
    return createCustomerTools({ db: database, ticket, deps }).find((tool?: any) => tool.name === 'update_ticket');
  }

  it('rejects a missing ticket and an empty patch', async () => {
    const database = createDb();
    const missing = (findUpdateTicket as any)(database);
    assert.deepEqual(await missing!.execute({ subject: 'Тема' }), { ok: false, error: 'missing_ticket' });

    const empty = findUpdateTicket(database, { id: 42, status: 'Open' });
    assert.deepEqual(await empty!.execute({}), { ok: false, error: 'no_fields' });
  });

  it('updates subject and description via editTicket', async () => {
    const database = createDb();
    let edited: any = null;
    const tool = findUpdateTicket(database, { id: 42, status: 'Open' }, {
      editTicket: async (ticketId?: any, changes?: any) => {
        edited = { ticketId, changes };
        return { changed: true };
      },
    });
    const result = await tool!.execute({ subject: ' Новая тема ', description: ' Подробности ' });
    assert.deepEqual(result, {
      ok: true,
      changed: { subject: 'Новая тема', description: 'Подробности' },
    });
    assert.deepEqual(edited, {
      ticketId: 42,
      changes: { subject: ' Новая тема ', description: ' Подробности ' },
    });
  });

  it('maps Russian status labels and assigns responsible from employee_id', async () => {
    const database = createDb();
    const employee = createEmployeeUser(database, {
      phone: '+998901119901',
      displayName: 'Firuz',
    });
    setBotUserRegosLink(database, employee.id, { regosUserId: 31 });

    let statusCall: any = null;
    let responsibleCall: any = null;
    const tool = findUpdateTicket(database, { id: 42, status: 'Open' }, {
      setTicketStatus: async (ticketId?: any, status?: any) => {
        statusCall = { ticketId, status };
        return { ok: true };
      },
      setTicketResponsible: async (ticketId?: any, userId?: any) => {
        responsibleCall = { ticketId, userId };
        return { ok: true };
      },
    });
    const result = await tool!.execute({ status: 'Ожидание клиента', employee_id: employee.id });
    assert.deepEqual(result, {
      ok: true,
      changed: { responsible_user_id: 31, status: 'WaitingClient' },
    });
    assert.deepEqual(statusCall, { ticketId: 42, status: 'WaitingClient' });
    assert.deepEqual(responsibleCall, { ticketId: 42, userId: 31 });
  });

  it('rejects invalid status and missing REGOS user id', async () => {
    const database = createDb();
    const tool = findUpdateTicket(database, { id: 42, status: 'Open' }, {
      setTicketStatus: async () => {
        throw new Error('must not set status');
      },
      setTicketResponsible: async () => {
        throw new Error('must not set responsible');
      },
    });
    assert.deepEqual(await tool!.execute({ status: 'Unknown' }), { ok: false, error: 'invalid_status' });
    assert.deepEqual(await tool!.execute({ employee_id: 999 }), { ok: false, error: 'missing_regos_user_id' });
  });

  it('replaces participants and keeps the AI author', async () => {
    const database = createDb();
    const employee = createEmployeeUser(database, {
      phone: '+998901119902',
      displayName: 'Alisher',
    });
    setBotUserRegosLink(database, employee.id, { regosUserId: 44 });

    let participantsCall: any = null;
    const tool = findUpdateTicket(database, { id: 42, status: 'Open' }, {
      resolveAiAuthorUserId: () => 99,
      setTicketParticipants: async (ticketId?: any, ids?: any, options?: any) => {
        participantsCall = { ticketId, ids, options };
        return { ok: true };
      },
    });
    const result = await tool!.execute({
      participant_user_ids: [12],
      participant_employee_ids: [employee.id],
    });
    assert.deepEqual(result, {
      ok: true,
      changed: { participant_user_ids: [12, 44, 99] },
    });
    assert.deepEqual(participantsCall, {
      ticketId: 42,
      ids: [12, 44, 99],
      options: { replaceMode: true },
    });
  });

  it('defers Closed when onTicketClose is set and does not call CRM immediately', async () => {
    const database = createDb();
    let closed = false;
    let statusCalled = false;
    const tool = findUpdateTicket(database, { id: 42, status: 'Open' }, {
      onTicketClose: () => {
        closed = true;
      },
      setTicketStatus: async () => {
        statusCalled = true;
        return { ok: true };
      },
    });
    const result = await tool!.execute({ status: 'Closed' });
    assert.deepEqual(result, { ok: true, changed: { status: 'Closed' } });
    assert.equal(closed, true);
    assert.equal(statusCalled, false);
  });

  it('returns CRM errors instead of throwing', async () => {
    const database = createDb();
    const tool = findUpdateTicket(database, { id: 42, status: 'Open' }, {
      editTicket: async () => {
        throw new Error('Тема тикета не должна превышать 300 символов.');
      },
    });
    assert.deepEqual(await tool!.execute({ subject: 'x'.repeat(301) }), {
      ok: false,
      error: 'Тема тикета не должна превышать 300 символов.',
    });
  });
});

describe('get_client_firm tool', () => {
  it('uses only the ticket client phone and ignores extra args', async () => {
    const database = createDb();
    const queried: any[] = [];
    const firm = createCustomerTools({
      db: database,
      ticket: { id: 42, client: { phone: '+998901112233' } },
      deps: {
        searchUser: async (query?: any) => {
          queried.push(query);
          return { found: true, message: 'Firm card' };
        },
        searchFirmAdmin: async () => {
          throw new Error('must not fall through');
        },
      },
    }).find((tool?: any) => tool.name === 'get_client_firm');

    const missing = createCustomerTools({ db: database }).find((tool?: any) => tool.name === 'get_client_firm');
    assert.deepEqual(await missing!.execute(), { ok: false, error: 'missing_phone' });

    const noPhone = createCustomerTools({
      db: database,
      ticket: { id: 42, client: { name: 'Fariz' } },
    }).find((tool?: any) => tool.name === 'get_client_firm');
    assert.deepEqual(await noPhone!.execute(), { ok: false, error: 'missing_phone' });

    const result = await firm!.execute({ phone: '998909999999', query: 'other' });
    assert.equal(result.found, true);
    assert.equal(result.message, 'Firm card');
    assert.equal(result.phone, '+998901112233');
    assert.deepEqual(queried, ['+998901112233']);
  });

  it('falls through to searchFirmAdmin when searchUser finds nothing', async () => {
    const database = createDb();
    const queried: any[] = [];
    const firm = createCustomerTools({
      db: database,
      ticket: { id: 42, client: { phone: '998901112233' } },
      deps: {
        searchUser: async () => ({ found: false }),
        searchFirmAdmin: async (query?: any) => {
          queried.push(query);
          return { found: true, result: [{ type: 'partner', clientName: 'Test' }] };
        },
      },
    }).find((tool?: any) => tool.name === 'get_client_firm');

    const result = await firm!.execute();
    assert.equal(result.found, true);
    assert.equal(result.phone, '998901112233');
    assert.deepEqual(queried, ['998901112233']);
  });
});

describe('transcribe_chat_audio tool', () => {
  it('rejects images and returns transcript text for audio', async () => {
    const database = createDb();
    const filesById: Map<any, any> = new Map([
      [
        1,
        {
          id: 1,
          name: 'shot.png',
          extension: 'png',
          mime_type: 'image/png',
          url: 'https://files.example/shot.png',
        },
      ],
      [
        2,
        {
          id: 2,
          name: 'voice.ogg',
          extension: 'ogg',
          mime_type: 'audio/ogg',
          media_type: 'voice',
          url: 'https://files.example/voice.ogg',
        },
      ],
    ]);
    const tools = createCustomerTools({
      db: database,
      chatId: 'chat-1',
      filesById,
      deps: {
        transcribeChatAudio: async (file?: any) => ({ text: `hello ${file.id}` }),
      },
    });
    const transcribe = tools.find((tool?: any) => tool.name === 'transcribe_chat_audio');
    const image = await transcribe!.execute({ file_id: 1 });
    assert.equal(image.ok, false);
    assert.equal(image.error, 'not_audio');
    assert.equal(image.kind, 'image');

    const audio = await transcribe!.execute({ file_id: 2 });
    assert.equal(audio.ok, true);
    assert.equal(audio.text, 'hello 2');
    assert.equal(audio.file.id, 2);
  });
});
