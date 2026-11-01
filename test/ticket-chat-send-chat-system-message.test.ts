import type { Unchecked } from '../src/types/unchecked';
import type { Response } from 'express';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { openDb } from '../src/db/partners-db';
import { createEmployeeUser, setBotUserRegosLink } from '../src/db/bot-users-db';
import { createBotAdminRouter } from '../src/admin/bot-admin';
import { RegosCrmError, addTicketMessage, addChatFile } from '../src/integrations/regos-crm';
import { formatSystemChatMessage, enrichChatMessages } from '../src/admin/chat-system-message';
import { mockRegos } from './ticket-chat-send-helpers';

function makeTempDbPath() {
  return path.join(
    os.tmpdir(),
    `scrapregos-ticket-chat-send-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );
}

function removeDbFiles(dbPath?: any) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
}


describe('chat-system-message', () => {
  it('formats TicketCreated, TicketClosed and TicketResponsibleSet payloads', () => {
    const userNames = { 22: 'Mamatkulov Firuz' };

    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'TicketCreated',
          action_payload: JSON.stringify({
            id: 10854,
            direction: 'Inbound',
            subject: 'xonturayev',
            status: 'Open',
          }),
        },
        { ticketId: 10854, userNames }
      ),
      'Создано обращение xonturayev (Входящий, Открыт)'
    );

    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'TicketClosed',
          action_payload: JSON.stringify({
            id: 10854,
            old_status: 'WaitingStaff',
            status: 'Closed',
          }),
        },
        { ticketId: 10854, userNames }
      ),
      'Обращение #10854 закрыто (Закрыт)'
    );

    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'TicketResponsibleSet',
          action_payload: JSON.stringify({
            id: 10854,
            old_responsible_user_id: null,
            responsible_user_id: 22,
          }),
        },
        { ticketId: 10854, userNames }
      ),
      'Изменен ответственный обращения #10854 Не назначен -> Mamatkulov Firuz'
    );
  });

  it('prefers message.text and returns null for regular messages', () => {
    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'StaffNoticeAdded',
          action_payload: JSON.stringify({ text: 'ignored' }),
          text: 'Запросили у клиента номер телефона.',
        },
        {}
      ),
      'Запросили у клиента номер телефона.'
    );

    assert.equal(formatSystemChatMessage({ message_type: 'Regular', text: 'hello' }, {}), null);

    const enriched = enrichChatMessages(
      [{ message_type: 'Regular', text: 'hello' }],
      { ticketId: 1, userNames: {} }
    );
    assert.equal(enriched[0].display_text, undefined);
  });

  it('falls back to action_code for unknown system events', () => {
    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'SomeFutureAction',
          action_payload: '{}',
        },
        {}
      ),
      'SomeFutureAction'
    );
  });

  it('hides generic TicketEdited system events from the chat feed', () => {
    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'TicketEdited',
          action_payload: JSON.stringify({ id: 2315 }),
        },
        { ticketId: 2315 }
      ),
      null
    );
    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          action_code: 'TicketParticipantsSet',
          text: 'TicketParticipantsSet',
        },
        {}
      ),
      null
    );
    assert.equal(
      formatSystemChatMessage(
        {
          message_type: 'System',
          text: 'TicketEdited',
        },
        {}
      ),
      null
    );

    const enriched = enrichChatMessages(
      [
        {
          id: 'keep',
          message_type: 'System',
          action_code: 'TicketClosed',
          action_payload: JSON.stringify({ id: 2315, status: 'Closed' }),
        },
        {
          id: 'hide-edited',
          message_type: 'System',
          action_code: 'TicketEdited',
          action_payload: JSON.stringify({ id: 2315 }),
        },
        {
          id: 'hide-text',
          message_type: 'System',
          text: 'TicketEdited',
        },
        {
          id: 'regular',
          message_type: 'Regular',
          text: 'hello',
        },
      ],
      { ticketId: 2315, userNames: {} }
    );

    assert.deepEqual(
      enriched.map((message?: any) => message.id),
      ['keep', 'regular']
    );
    assert.equal(enriched[0].display_text, 'Обращение #2315 закрыто (Закрыт)');
  });
});
