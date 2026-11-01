import type { Unchecked } from '../../types/unchecked';
import type { Db } from '../../types/db';
import { getEmployeeForAgent } from './employees';
import { factoryToolDescription } from './descriptions';

const TICKET_STATUS_ALIASES: Map<any, any> = new Map([
  ['open', 'Open'],
  ['открыт', 'Open'],
  ['closed', 'Closed'],
  ['закрыт', 'Closed'],
  ['waitingclient', 'WaitingClient'],
  ['ожидание клиента', 'WaitingClient'],
  ['waitingstaff', 'WaitingStaff'],
  ['ожидание сотрудника', 'WaitingStaff'],
]);

function normalizeTicketStatusArg(value?: any) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return TICKET_STATUS_ALIASES.get(raw.toLowerCase()) || null;
}

function collectPositiveIds(value?: any) {
  const list = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const ids: any[] = [];
  const seen: Set<any> = new Set();
  for (const item of list) {
    const id = Number(item);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function resolveRegosUserId(db: Db, { employeeId, regosUserId }: Unchecked = {}) {
  let id = Number(regosUserId);
  if (!Number.isFinite(id) || id <= 0) {
    const employee = getEmployeeForAgent(db, employeeId);
    id = Number(employee?.regos_user_id);
  }
  return Number.isFinite(id) && id > 0 ? id : null;
}

function resolveParticipantUserIds(db: Db, { participant_employee_ids, participant_user_ids }: Unchecked = {}) {
  const ids = collectPositiveIds(participant_user_ids);
  const seen: Set<any> = new Set(ids);
  for (const employeeId of collectPositiveIds(participant_employee_ids)) {
    const regosId = resolveRegosUserId(db, { employeeId });
    if (!regosId) {
      return { error: 'missing_regos_user_id', employee_id: employeeId };
    }
    if (!seen.has(regosId)) {
      seen.add(regosId);
      ids.push(regosId);
    }
  }
  return { ids };
}

export function customerTicketTools({
  db,
  ticket,
  setTicketResponsible,
  setTicketStatus,
  editTicket,
  setTicketParticipants,
  resolveAiAuthorUserId,
  onTicketClose,
}: Unchecked) {
  return [
    {
      name: 'assign_responsible',
      description: factoryToolDescription('assign_responsible'),
      parameters: {
        type: 'object',
        properties: {
          employee_id: { type: 'number' },
          regos_user_id: { type: 'number' },
        },
      },
      execute: async ({ employee_id, regos_user_id }: Unchecked = {}) => {
        let regosUserId = Number(regos_user_id);
        if (!Number.isFinite(regosUserId) || regosUserId <= 0) {
          const employee = getEmployeeForAgent(db, employee_id);
          regosUserId = Number(employee?.regos_user_id);
        }
        if (!Number.isFinite(regosUserId) || regosUserId <= 0) {
          return { ok: false, error: 'missing_regos_user_id' };
        }
        if (!ticket?.id) return { ok: false, error: 'missing_ticket' };
        await setTicketResponsible(ticket.id, regosUserId);
        return { ok: true, responsible_user_id: regosUserId };
      },
    },
    {
      name: 'close_ticket',
      description: factoryToolDescription('close_ticket'),
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        if (!ticket?.id) return { ok: false, error: 'missing_ticket' };
        if (String(ticket.status || '') === 'Closed') return { ok: true, already_closed: true };
        if (onTicketClose) {
          onTicketClose();
          return { ok: true, status: 'Closed' };
        }
        await setTicketStatus(ticket.id, 'Closed');
        return { ok: true, status: 'Closed' };
      },
    },
    {
      name: 'update_ticket',
      description: factoryToolDescription('update_ticket'),
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Ticket subject, max 300 characters' },
          description: { type: 'string', description: 'Ticket description' },
          status: {
            type: 'string',
            description:
              'Open, WaitingClient, WaitingStaff, or Closed. Russian labels (Открыт, Ожидание клиента, Ожидание сотрудника, Закрыт) are also accepted.',
          },
          employee_id: { type: 'number', description: 'Bot employee id; resolved to REGOS user via get_employee' },
          responsible_user_id: { type: 'number', description: 'REGOS user id for the responsible' },
          participant_employee_ids: {
            type: 'array',
            items: { type: 'number' },
            description: 'Bot employee ids; replaces the participant list after resolving to REGOS users',
          },
          participant_user_ids: {
            type: 'array',
            items: { type: 'number' },
            description: 'REGOS user ids; replaces the participant list',
          },
        },
      },
      execute: async (args: any = {}) => {
        if (!ticket?.id) return { ok: false, error: 'missing_ticket' };
        const input = args && typeof args === 'object' ? args : {};
        const hasSubject = Object.hasOwn(input, 'subject');
        const hasDescription = Object.hasOwn(input, 'description');
        const hasStatus = Object.hasOwn(input, 'status');
        const hasResponsible =
          Object.hasOwn(input, 'employee_id') ||
          Object.hasOwn(input, 'responsible_user_id') ||
          Object.hasOwn(input, 'regos_user_id');
        const hasParticipants =
          Object.hasOwn(input, 'participant_employee_ids') || Object.hasOwn(input, 'participant_user_ids');
        if (!hasSubject && !hasDescription && !hasStatus && !hasResponsible && !hasParticipants) {
          return { ok: false, error: 'no_fields' };
        }

        let status: any = null;
        if (hasStatus) {
          status = normalizeTicketStatusArg(input.status);
          if (!status) return { ok: false, error: 'invalid_status' };
        }

        let responsibleUserId: any = null;
        if (hasResponsible) {
          responsibleUserId = resolveRegosUserId(db, {
            employeeId: input.employee_id,
            regosUserId: input.responsible_user_id ?? input.regos_user_id,
          });
          if (!responsibleUserId) return { ok: false, error: 'missing_regos_user_id' };
        }

        let participantIds: any = null;
        if (hasParticipants) {
          const resolved = resolveParticipantUserIds(db, input);
          if (resolved.error) {
            return { ok: false, error: resolved.error, employee_id: resolved.employee_id };
          }
          participantIds = [...resolved.ids!];
          const aiAuthorId = resolveAiAuthorUserId();
          if (aiAuthorId && !participantIds.includes(aiAuthorId)) participantIds.push(aiAuthorId);
        }

        try {
          const changed: Unchecked = {};
          if (hasSubject || hasDescription) {
            const scalarChanges: Unchecked = {};
            if (hasSubject) scalarChanges.subject = input.subject;
            if (hasDescription) scalarChanges.description = input.description;
            await editTicket(ticket.id, scalarChanges);
            if (hasSubject) changed.subject = String(input.subject ?? '').trim();
            if (hasDescription) changed.description = String(input.description ?? '').trim();
          }
          if (hasResponsible) {
            await setTicketResponsible(ticket.id, responsibleUserId);
            changed.responsible_user_id = responsibleUserId;
          }
          if (hasStatus) {
            if (status === 'Closed' && String(ticket.status || '') === 'Closed') {
              changed.status = 'Closed';
            } else if (status === 'Closed' && onTicketClose) {
              onTicketClose();
              changed.status = 'Closed';
            } else {
              await setTicketStatus(ticket.id, status);
              changed.status = status;
            }
          }
          if (hasParticipants) {
            await setTicketParticipants(ticket.id, participantIds, { replaceMode: true });
            changed.participant_user_ids = participantIds;
          }
          return { ok: true, changed };
        } catch (error: any) {
          return { ok: false, error: error.message || 'update_failed' };
        }
      },
    },
  ];
}
