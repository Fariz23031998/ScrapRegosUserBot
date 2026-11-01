import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { getSessionActor, actorHasPermission, requireRight } from './bot-admin-auth';
import { RegosCrmError, getClientById, editClient, createTicket, editTicket, setTicketStatus, setTicketResponsible, setTicketParticipants, normalizeParticipantUserIds, participantUserIdsEqual, findTicketById } from '../integrations/regos-crm';
import { listLinksByClient, addLink as addClientFirmLink, removeLink as removeClientFirmLink, getLinkById } from '../db/client-firm-links';
import { ticketEventHub } from './ticket-events';
import { auditAdminChange } from './bot-admin-shared';

export function registerBotAdminClientRoutes(router: any, deps: { db: Db; cacheTicketRecordingUrl: (ticket?: any) => any }) {
  const { db, cacheTicketRecordingUrl } = deps;
  function mapAdminClient(client?: any) {
    if (!client) return null;
    return {
      id: client.id,
      name: client.name || null,
      phone: client.phone || null,
      email: client.email || null,
      external_id: client.external_id || null,
      description: client.description || null,
      photo_url: client.photo_url || null,
    };
  }

  function mapAdminFirmLink(link?: any) {
    if (!link) return null;
    return {
      id: link.id,
      firm_type: link.firm_type,
      firm_record_id: link.firm_record_id,
      firm_name: link.firm_name,
      firm_phone: link.firm_phone,
      firm_message: link.firm_message,
      created_at: link.created_at,
    };
  }

  router.get('/api/clients/:id', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
    try {
      const client = await getClientById(req.params.id);
      if (!client) {
        return res.status(404).json({ message: 'Клиент не найден.' });
      }
      const firms = listLinksByClient(db, client.id).map(mapAdminFirmLink);
      return res.json({ client: mapAdminClient(client), firms });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      if (error?.code === 'INVALID_CLIENT_ID') {
        return res.status(400).json({ message: 'Некорректный ID клиента.' });
      }
      console.error('Get client error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить клиента.' });
    }
  });

  router.patch(
    '/api/clients/:id',
    requireRight(db, 'clients_edit'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const clientId = Number(req.params.id);
        const current = await getClientById(clientId);
        if (!current) {
          return res.status(404).json({ message: 'Клиент не найден.' });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const changes: Unchecked = {};
        for (const key of ['name', 'phone', 'email', 'description', 'external_id']) {
          if (Object.hasOwn(body, key) && String(body[key] ?? '') !== String(current[key] ?? '')) {
            changes[key] = body[key];
          }
        }

        await editClient(clientId, changes);
        const client = await getClientById(clientId);
        if (!client) {
          return res.status(502).json({
            message: 'REGOS изменил клиента, но не вернул его при повторном чтении.',
          });
        }
        const firms = listLinksByClient(db, client.id).map(mapAdminFirmLink);
        const before: Unchecked = {};
        const after: Unchecked = {};
        for (const key of Object.keys(changes)) {
          before[key] = current[key] ?? null;
          after[key] = client[key] ?? changes[key] ?? null;
        }
        auditAdminChange(db, req, {
          entityType: 'client',
          entityId: clientId,
          action: 'update',
          summary: `Изменён клиент #${clientId}`,
          details: buildAuditDetails({ before, after }),
        });
        return res.json({ client: mapAdminClient(client), firms });
      } catch (error: any) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status!).json({ message: error.message });
        }
        console.error('Edit client error:', error);
        return res.status(500).json({ message: 'Не удалось изменить клиента.' });
      }
    }
  );

  router.post(
    '/api/clients/:id/firms',
    requireRight(db, 'clients_link_firm'),
    express.json(),
    (req: Request, res: Response) => {
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const link = addClientFirmLink(db, {
          regos_client_id: req.params.id,
          type: body.type,
          recordId: body.recordId,
          clientName: body.clientName,
          phone: body.phone,
          message: body.message,
        });
        auditAdminChange(db, req, {
          entityType: 'firm_link',
          entityId: link?.id,
          action: 'create',
          summary: `Привязана фирма к клиенту #${req.params.id}`,
          details: buildAuditDetails({
            before: null,
            after: {
              regos_client_id: req.params.id,
              type: body.type ?? null,
              record_id: body.recordId ?? null,
              client_name: body.clientName ?? null,
              phone: body.phone ?? null,
            },
          }),
        });
        return res.status(201).json({ firm: mapAdminFirmLink(link) });
      } catch (error: any) {
        if (error?.code === 'DUPLICATE_LINK') {
          return res.status(409).json({ message: 'Эта фирма уже привязана к клиенту.' });
        }
        if (
          error?.code === 'INVALID_CLIENT_ID' ||
          error?.code === 'INVALID_FIRM_TYPE' ||
          error?.code === 'INVALID_FIRM_RECORD_ID'
        ) {
          return res.status(400).json({ message: 'Укажите корректные данные фирмы.' });
        }
        console.error('Add client firm link error:', error);
        return res.status(500).json({ message: 'Не удалось привязать фирму.' });
      }
    }
  );

  router.delete(
    '/api/clients/:id/firms/:linkId',
    requireRight(db, 'clients_link_firm'),
    (req: Request, res: Response) => {
      try {
        const existing = getLinkById(db, req.params.linkId);
        if (!existing || Number(existing.regos_client_id) !== Number(req.params.id)) {
          return res.status(404).json({ message: 'Связь с фирмой не найдена.' });
        }
        const removed = removeClientFirmLink(db, req.params.linkId, {
          regosClientId: req.params.id,
        });
        if (!removed) {
          return res.status(404).json({ message: 'Связь с фирмой не найдена.' });
        }
        auditAdminChange(db, req, {
          entityType: 'firm_link',
          entityId: req.params.linkId,
          action: 'delete',
          summary: `Отвязана фирма от клиента #${req.params.id}`,
          details: buildAuditDetails({
            before: {
              regos_client_id: existing.regos_client_id ?? req.params.id,
              type: (existing as Unchecked).type ?? null,
              record_id: (existing as Unchecked).record_id ?? null,
              client_name: (existing as Unchecked).client_name ?? null,
              phone: (existing as Unchecked).phone ?? null,
            },
            after: null,
          }),
        });
        return res.json({ ok: true });
      } catch (error: any) {
        if (error?.code === 'INVALID_CLIENT_ID') {
          return res.status(400).json({ message: 'Некорректный ID клиента.' });
        }
        console.error('Remove client firm link error:', error);
        return res.status(500).json({ message: 'Не удалось отвязать фирму.' });
      }
    }
  );

  router.post(
    '/api/tickets',
    requireRight(db, 'tickets_create'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const created = await createTicket({
          client_id: req.body?.client_id,
          channel_id: req.body?.channel_id,
          direction: req.body?.direction,
          subject: req.body?.subject,
          description: req.body?.description,
          responsible_user_id: req.body?.responsible_user_id,
        });

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        let participantIds: any = null;
        if (Object.hasOwn(body, 'participant_user_ids')) {
          participantIds = normalizeParticipantUserIds(body.participant_user_ids);
          await setTicketParticipants(created.id, participantIds, { replaceMode: true });
        }

        const ticket = await findTicketById(created.id);
        if (!ticket) {
          return res.status(502).json({
            message: 'REGOS создал тикет, но не вернул его при повторном чтении.',
            ticket_id: created.id,
          });
        }
        cacheTicketRecordingUrl(ticket);
        auditAdminChange(db, req, {
          entityType: 'ticket',
          entityId: created.id,
          action: 'create',
          summary: `Создан тикет #${created.id}`,
          details: buildAuditDetails({
            before: null,
            after: {
              id: created.id,
              client_id: req.body?.client_id ?? null,
              channel_id: req.body?.channel_id ?? null,
              subject: req.body?.subject ?? null,
              direction: req.body?.direction ?? null,
              responsible_user_id: req.body?.responsible_user_id ?? null,
              participant_user_ids: participantIds,
            },
          }),
        });
        return res.status(201).json({ ticket });
      } catch (error: any) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status!).json({ message: error.message });
        }
        console.error('Create ticket error:', error);
        return res.status(500).json({ message: 'Не удалось создать тикет.' });
      }
    }
  );

  router.patch(
    '/api/tickets/:id',
    requireRight(db, 'tickets_edit'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const current = await findTicketById(req.params.id);
        if (!current) {
          return res.status(404).json({ message: 'Тикет не найден.' });
        }

        if (
          String(current.status || '') === 'Closed' &&
          !actorHasPermission(db, getSessionActor(req), 'tickets_edit_closed')
        ) {
          return res.status(403).json({
            message: 'Недостаточно прав для изменения закрытого тикета.',
          });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const scalarChanges: Unchecked = {};
        for (const key of ['subject', 'description', 'direction']) {
          if (Object.hasOwn(body, key) && String(body[key] ?? '') !== String(current[key] ?? '')) {
            scalarChanges[key] = body[key];
          }
        }

        await editTicket(current.id, scalarChanges);
        if (
          Object.hasOwn(body, 'responsible_user_id') &&
          Number(body.responsible_user_id) !== Number(current.responsible_user_id)
        ) {
          await setTicketResponsible(current.id, body.responsible_user_id);
        }
        if (
          Object.hasOwn(body, 'status') &&
          String(body.status || '') !== String(current.status || '')
        ) {
          await setTicketStatus(current.id, body.status);
        }

        let nextParticipantIds: any = null;
        let participantsChanged = false;
        if (Object.hasOwn(body, 'participant_user_ids')) {
          nextParticipantIds = normalizeParticipantUserIds(body.participant_user_ids);
          if (!participantUserIdsEqual(nextParticipantIds, current.participant_user_ids)) {
            await setTicketParticipants(current.id, nextParticipantIds, { replaceMode: true });
            participantsChanged = true;
          }
        }

        const ticket = await findTicketById(current.id);
        if (!ticket) {
          return res.status(502).json({
            message: 'REGOS изменил тикет, но не вернул его при повторном чтении.',
          });
        }
        cacheTicketRecordingUrl(ticket);
        const before: Unchecked = {};
        const after: Unchecked = {};
        for (const key of Object.keys(scalarChanges)) {
          before[key] = current[key] ?? null;
          after[key] = ticket[key] ?? scalarChanges[key] ?? null;
        }
        if (
          Object.hasOwn(body, 'responsible_user_id') &&
          Number(body.responsible_user_id) !== Number(current.responsible_user_id)
        ) {
          before.responsible_user_id = current.responsible_user_id ?? null;
          after.responsible_user_id = ticket.responsible_user_id ?? body.responsible_user_id ?? null;
        }
        if (
          Object.hasOwn(body, 'status') &&
          String(body.status || '') !== String(current.status || '')
        ) {
          before.status = current.status ?? null;
          after.status = ticket.status ?? body.status ?? null;
        }
        if (participantsChanged) {
          before.participant_user_ids = normalizeParticipantUserIds(current.participant_user_ids);
          const refreshed = normalizeParticipantUserIds(ticket.participant_user_ids);
          after.participant_user_ids = refreshed.length ? refreshed : nextParticipantIds;
        }
        auditAdminChange(db, req, {
          entityType: 'ticket',
          entityId: current.id,
          action: 'update',
          summary: `Изменён тикет #${current.id}`,
          details: buildAuditDetails({ before, after }),
        });
        // Push list refresh immediately; do not wait for REGOS webhook round-trip.
        ticketEventHub.publish({
          type: 'ticket_changed',
          ticket_id: ticket.id,
          responsible_user_id: ticket.responsible_user_id ?? null,
          source_action: 'TicketEdited',
          occurred_at: Date.now(),
        });
        return res.json({ ticket });
      } catch (error: any) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status!).json({ message: error.message });
        }
        console.error('Edit ticket error:', error);
        return res.status(500).json({ message: 'Не удалось изменить тикет.' });
      }
    }
  );

}
