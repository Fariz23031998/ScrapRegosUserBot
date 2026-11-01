import type { Unchecked } from '../../types/unchecked';
import type { Db } from '../../types/db';
import { listEmployeeUsers, getBotUserById, phonesMatch } from '../../db/bot-users-db';

function mapEmployeeForAgent(user?: any) {
  if (!user || user.role !== 'employee') return null;
  return {
    id: user.id,
    display_name: user.display_name || [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
    job_title: user.job_title || null,
    description: user.description || null,
    phone: user.phone || null,
    telegram_linked: user.telegram_id != null,
    regos_user_id: user.regos_user_id ?? null,
  };
}

function findEmployeesForAgent(db: Db, { query, jobTitle }: Unchecked = {}) {
  const employees = listEmployeeUsers(db);
  const q = String(query || '').trim().toLowerCase();
  const title = String(jobTitle || '').trim().toLowerCase();

  return employees
    .filter((user?: any) => {
      if (title) {
        const hay = [user.job_title, user.description, user.display_name].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(title)) return false;
      }
      if (!q) return true;
      if (phonesMatch(user.phone, q)) return true;
      const searchable = [
        user.display_name,
        user.job_title,
        user.description,
        user.first_name,
        user.last_name,
        user.phone,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchable.includes(q);
    })
    .map(mapEmployeeForAgent)
    .filter(Boolean);
}

function getEmployeeForAgent(db: Db, employeeId?: any) {
  return mapEmployeeForAgent(getBotUserById(db, employeeId));
}

function isEmployeeClientPhone(db: Db, phone?: any) {
  if (!phone) return false;
  return listEmployeeUsers(db).some((user?: any) => phonesMatch(user.phone, phone));
}

export {
  mapEmployeeForAgent,
  findEmployeesForAgent,
  getEmployeeForAgent,
  isEmployeeClientPhone,
};
