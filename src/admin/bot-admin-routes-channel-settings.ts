import type { Unchecked } from '../types/unchecked';
import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import express from 'express';
import { buildAuditDetails } from '../db/admin-audit-logs';
import { requireRight } from './bot-admin-auth';
import { replaceRegosChannelSettings } from '../db/regos-channel-settings';
import { RegosCrmError, fetchAllUsers, fetchAllChannels, searchClients, mapRegosChannelSummary } from '../integrations/regos-crm';
import { loadTelegramTicketSettings, saveTelegramTicketSettings, serializeTelegramTicketSettings } from '../bot/telegram-ticket-settings';
import { loadMergedChannelSettings, auditAdminChange } from './bot-admin-shared';

export function registerBotAdminChannelSettingsRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  router.get('/api/settings/channels', requireRight(db, 'settings_read'), async (_req: any, res: Response) => {
    try {
      return res.json({ channels: await loadMergedChannelSettings(db) });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('Load channel settings error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить настройки каналов.' });
    }
  });

  router.put(
    '/api/settings/channels',
    requireRight(db, 'settings_edit'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const current = await loadMergedChannelSettings(db);
        const submitted = Array.isArray(req.body?.channels) ? req.body.channels : null;
        if (!submitted) {
          return res.status(400).json({ message: 'Передайте полный список каналов.' });
        }

        const submittedById: Map<any, any> = new Map(
          submitted.map((item?: any) => [String(item?.id ?? item?.channel_id ?? '').trim(), item])
        );
        if (
          submitted.length !== current.length ||
          submittedById.size !== current.length ||
          current.some((channel?: any) => !submittedById.has(channel.id))
        ) {
          return res.status(400).json({ message: 'Список каналов устарел. Обновите страницу.' });
        }

        const saved = replaceRegosChannelSettings(
          db,
          current.map((channel?: any) => ({
            channel_id: channel.id,
            channel_name: channel.name,
            interaction_mode: submittedById.get(channel.id)?.interaction_mode,
          }))
        );
        const savedById: Map<any, any> = new Map(saved.map((setting?: any) => [String(setting.channel_id), setting]));
        const beforeModes: Unchecked = {};
        const afterModes: Unchecked = {};
        for (const channel of current) {
          const nextMode =
            savedById.get(channel.id)?.interaction_mode ||
            submittedById.get(channel.id)?.interaction_mode ||
            channel.interaction_mode ||
            'message_only';
          if (String(channel.interaction_mode || '') !== String(nextMode || '')) {
            beforeModes[channel.id] = channel.interaction_mode || null;
            afterModes[channel.id] = nextMode;
          }
        }
        auditAdminChange(db, req, {
          entityType: 'channel_settings',
          entityId: null,
          action: 'update',
          summary: `Обновлены настройки каналов (${Object.keys(afterModes).length || saved.length})`,
          details: buildAuditDetails({
            before: beforeModes,
            after: afterModes,
          }),
        });
        return res.json({
          ok: true,
          channels: current.map((channel?: any) => ({
            ...channel,
            interaction_mode:
              savedById.get(channel.id)?.interaction_mode || 'message_only',
          })),
        });
      } catch (error: any) {
        if (
          [
            'INVALID_CHANNEL_ID',
            'INVALID_CHANNEL_MODE',
            'INVALID_CHANNEL_NAME',
            'INVALID_CHANNEL_SETTINGS',
            'DUPLICATE_CHANNEL_ID',
          ].includes(error.message)
        ) {
          return res.status(400).json({ message: 'Некорректные настройки каналов.' });
        }
        if (error instanceof RegosCrmError) {
          return res.status(error.status!).json({ message: error.message });
        }
        console.error('Save channel settings error:', error);
        return res.status(500).json({ message: 'Не удалось сохранить настройки каналов.' });
      }
    }
  );

  router.get('/api/settings/telegram-tickets', requireRight(db, 'settings_read'), async (_req: any, res: Response) => {
    try {
      const settings = serializeTelegramTicketSettings(loadTelegramTicketSettings(db));
      let channels: any[] = [];
      let users: any[] = [];
      try {
        channels = (await fetchAllChannels())
          .map(mapRegosChannelSummary)
          .sort((a?: any, b?: any) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
      } catch (error: any) {
        console.error('Load telegram-ticket channels error:', error);
      }
      try {
        users = (await fetchAllUsers())
          .map((user?: any) => ({
            id: user.id,
            full_name: user.full_name || null,
            login: user.login || null,
            first_name: user.first_name || null,
            last_name: user.last_name || null,
          }))
          .sort((a?: any, b?: any) =>
            String(a.full_name || a.login || '').localeCompare(
              String(b.full_name || b.login || ''),
              'ru'
            )
          );
      } catch (error: any) {
        console.error('Load telegram-ticket users error:', error);
      }
      return res.json({ settings, channels, users });
    } catch (error: any) {
      console.error('Load telegram ticket settings error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить настройки Telegram-тикетов.' });
    }
  });

  router.put(
    '/api/settings/telegram-tickets',
    requireRight(db, 'settings_edit'),
    express.json(),
    (req: Request, res: Response) => {
      try {
        const before = loadTelegramTicketSettings(db);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const saved = saveTelegramTicketSettings(db, {
          enabled: body.enabled,
          channelId: body.channel_id ?? body.channelId,
          direction: body.direction,
          responsibleUserId: body.responsible_user_id ?? body.responsibleUserId,
          participantUserIds: body.participant_user_ids ?? body.participantUserIds,
          subject: body.subject,
          fallbackClientId: body.fallback_client_id ?? body.fallbackClientId,
        });
        auditAdminChange(db, req, {
          entityType: 'telegram_ticket_settings',
          entityId: null,
          action: 'update',
          summary: 'Обновлены настройки Telegram-тикетов',
          details: buildAuditDetails({
            before: serializeTelegramTicketSettings(before),
            after: serializeTelegramTicketSettings(saved),
          }),
        });
        return res.json({
          ok: true,
          settings: serializeTelegramTicketSettings(saved),
        });
      } catch (error: any) {
        if (
          error.message === 'TELEGRAM_TICKET_CHANNEL_REQUIRED' ||
          error.message === 'INVALID_TELEGRAM_TICKET_CHANNEL' ||
          error.message === 'INVALID_TELEGRAM_TICKET_DIRECTION' ||
          error.message === 'INVALID_TELEGRAM_TICKET_RESPONSIBLE' ||
          error.message === 'INVALID_TELEGRAM_TICKET_PARTICIPANTS' ||
          error.message === 'INVALID_TELEGRAM_TICKET_SUBJECT' ||
          error.message === 'INVALID_TELEGRAM_TICKET_FALLBACK_CLIENT'
        ) {
          const messages = {
            TELEGRAM_TICKET_CHANNEL_REQUIRED: 'Укажите канал REGOS для Telegram-тикетов.',
            INVALID_TELEGRAM_TICKET_CHANNEL: 'Некорректный канал REGOS.',
            INVALID_TELEGRAM_TICKET_DIRECTION: 'Направление должно быть Inbound или Outbound.',
            INVALID_TELEGRAM_TICKET_RESPONSIBLE: 'Некорректный ответственный пользователь.',
            INVALID_TELEGRAM_TICKET_PARTICIPANTS: 'Некорректный список участников.',
            INVALID_TELEGRAM_TICKET_SUBJECT: 'Некорректная тема тикета.',
            INVALID_TELEGRAM_TICKET_FALLBACK_CLIENT: 'Некорректный fallback-клиент.',
          };
          return res.status(400).json({ message: (messages as Record<string, string>)[error.message] || 'Некорректные настройки.' });
        }
        console.error('Save telegram ticket settings error:', error);
        return res.status(500).json({ message: 'Не удалось сохранить настройки Telegram-тикетов.' });
      }
    }
  );

  router.get(
    '/api/settings/telegram-tickets/clients',
    requireRight(db, 'settings_read'),
    async (req: Request, res: Response) => {
      try {
        const query = String(req.query.q || '').trim();
        if (query.length < 2) {
          return res.json({ clients: [] });
        }
        const clients = await searchClients(query, { limit: 20 });
        return res.json({
          clients: clients.map((client?: any) => ({
            id: client.id,
            name: client.name || null,
            phone: client.phone || null,
            email: client.email || null,
          })),
        });
      } catch (error: any) {
        if (error instanceof RegosCrmError) {
          return res.status(error.status!).json({ message: error.message });
        }
        console.error('Search telegram-ticket clients error:', error);
        return res.status(500).json({ message: 'Не удалось найти клиентов REGOS.' });
      }
    }
  );

}
