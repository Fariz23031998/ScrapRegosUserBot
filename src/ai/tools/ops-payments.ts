import type { Unchecked } from '../../types/unchecked';
import { getTask } from '../../db/tasks';
import { createTaskPayment, deleteTaskPayment, getTaskPayment } from '../../db/task-payments';
import { listPaymentTypes } from '../../db/payment-types';
import { factoryToolDescription } from './descriptions';
import { runSafe, compactPaymentType, requireVisibleTask } from './ops-shared';

export function paymentOpsTools({ db, userId, viewer, permissions, deps }: Unchecked) {
  return {
  list_payment_types: {
    name: 'list_payment_types',
    description: factoryToolDescription('list_payment_types'),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ payment_types: listPaymentTypes(db).map(compactPaymentType) }),
  },
  create_task_payment: {
    name: 'create_task_payment',
    description: factoryToolDescription('create_task_payment'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        payment_type_id: { type: 'number' },
        amount: { type: 'number' },
        currency: { type: 'string', description: 'UZS or USD' },
        note: { type: 'string' },
      },
      required: ['task_id', 'payment_type_id', 'amount'],
    },
    execute: async ({ task_id, payment_type_id, amount, currency, note }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        const payment = createTaskPayment(db, current.id, {
          payment_type_id,
          amount,
          currency,
          note,
          created_by_user_id: userId,
        });
        return { payment, task: getTask(db, current.id, viewer) };
      }),
  },
  delete_task_payment: {
    name: 'delete_task_payment',
    description: factoryToolDescription('delete_task_payment'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        payment_id: { type: 'number' },
      },
      required: ['task_id', 'payment_id'],
    },
    execute: async ({ task_id, payment_id }: Unchecked = {}) =>
      runSafe(async () => {
        const current = await requireVisibleTask(db, task_id, viewer);
        const before = getTaskPayment(db, current.id, payment_id);
        if (!before) return { ok: false, error: 'not_found' };
        const deleted = deleteTaskPayment(db, current.id, payment_id);
        if (!deleted) return { ok: false, error: 'not_found' };
        return { ok: true, id: before.id, task: getTask(db, current.id, viewer) };
      }),
  },
  };
}
