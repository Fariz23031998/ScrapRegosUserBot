import type { Db } from '../types/db';
import type { Request, Response } from 'express';
import { requireRight } from './bot-admin-auth';
import { RegosCrmError, fetchAllUsers, fetchAllChannels, searchClients, mapRegosChannelSummary } from '../integrations/regos-crm';
import { ticketEventHub } from './ticket-events';
import { loadActiveTicketForRequest } from './bot-admin-shared';
import { writeSseEvent } from './bot-admin-media';
import { loadTicketSummary, parseTicketListQuery } from './bot-admin-routes-tickets';

export function registerBotAdminTicketListRoutes(router: any, deps: { db: Db }) {
  const { db } = deps;
  router.get('/api/tickets/events', requireRight(db, 'tickets_read'), (req: Request, res: Response) => {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const unsubscribe = ticketEventHub.subscribe((event?: any) => writeSseEvent(res, event));
    const heartbeat = setInterval(() => {
      writeSseEvent(res, {
        type: 'heartbeat',
        occurred_at: new Date().toISOString(),
      }).catch(() => {});
    }, 30_000);

    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.get('/api/tickets/summary', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
    try {
      const query = parseTicketListQuery(req);
      if (query.error) {
        return res.status(400).json({ message: query.error });
      }
      const summary = await loadTicketSummary(db, query);
      return res.json({ summary });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('Ticket summary error:', error);
      return res.status(500).json({ message: 'Не удалось рассчитать итоги по тикетам.' });
    }
  });

  router.get('/api/tickets/active', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
    try {
      return res.json(await loadActiveTicketForRequest(db, req));
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('Load active ticket error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить активный тикет.' });
    }
  });

  router.get('/api/tickets/users', requireRight(db, 'tickets_read'), async (_req: any, res: Response) => {
    try {
      const users = await fetchAllUsers();
      users.sort((a?: any, b?: any) =>
        String(a.full_name || a.login || '').localeCompare(
          String(b.full_name || b.login || ''),
          'ru'
        )
      );
      return res.json({
        users: users.map((user?: any) => ({
          id: user.id,
          full_name: user.full_name || null,
          login: user.login || null,
          first_name: user.first_name || null,
          last_name: user.last_name || null,
        })),
      });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('List ticket users error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить пользователей REGOS.' });
    }
  });

  router.get('/api/tickets/channels', requireRight(db, 'tickets_read'), async (_req: any, res: Response) => {
    try {
      const channels = await fetchAllChannels();
      channels.sort((a?: any, b?: any) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'ru')
      );
      return res.json({
        channels: channels.map(mapRegosChannelSummary),
      });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('List ticket channels error:', error);
      return res.status(500).json({ message: 'Не удалось загрузить каналы REGOS.' });
    }
  });

  router.get('/api/tickets/clients', requireRight(db, 'tickets_read'), async (req: Request, res: Response) => {
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
          external_id: client.external_id || null,
          photo_url: client.photo_url || null,
        })),
      });
    } catch (error: any) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status!).json({ message: error.message });
      }
      console.error('Search ticket clients error:', error);
      return res.status(500).json({ message: 'Не удалось найти клиентов REGOS.' });
    }
  });

}
