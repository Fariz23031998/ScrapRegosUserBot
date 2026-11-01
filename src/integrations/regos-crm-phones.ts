import type { Unchecked } from '../types/unchecked';

function splitPhoneList(value?: any) {
  if (value == null || value === '') return [];
  return String(value)
    .split(/[,;|/]+/)
    .map((part?: any) => part.trim())
    .filter(Boolean);
}

function collectRegosUserPhones(user: any = {}) {
  const phones: any[] = [];
  for (const value of [user.main_phone, user.phones]) {
    phones.push(...splitPhoneList(value));
  }
  return phones;
}

function mapRegosUserSummary(user: any = {}) {
  const fullName =
    user.full_name ||
    [user.last_name, user.first_name, user.middle_name].filter(Boolean).join(' ').trim() ||
    null;
  return {
    id: user.id,
    login: user.login || null,
    full_name: fullName,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    main_phone: user.main_phone || null,
    phones: user.phones || null,
    active: user.active !== false,
  };
}

function phonesEqual(left?: any, right?: any) {
  const a = String(left || '').replace(/\D/g, '');
  const b = String(right || '').replace(/\D/g, '');
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith(b) || b.endsWith(a)) return true;
  const aTail = a.slice(-9);
  const bTail = b.slice(-9);
  return aTail.length >= 9 && aTail === bTail;
}

function regosUserMatchesPhone(user?: any, phone?: any) {
  return collectRegosUserPhones(user).some((candidate?: any) => phonesEqual(candidate, phone));
}

/**
 * Find REGOS users whose main_phone/phones match the given phone.
 */
function findRegosUsersByPhone(regosUsers?: any, phone?: any) {
  if (!phone) return [];
  return (regosUsers || []).filter((user?: any) => regosUserMatchesPhone(user, phone));
}

/**
 * Match one bot phone against REGOS users.
 * Returns unique match, none, or ambiguous (multiple).
 */
function matchPhoneToRegosUser(phone: any, regosUsers: any, { excludeRegosIds = new Set() }: Unchecked = {}) {
  const matches = findRegosUsersByPhone(regosUsers, phone).filter(
    (user?: any) => !excludeRegosIds.has(Number(user.id))
  );
  if (matches.length === 1) {
    return { status: 'matched', user: matches[0], candidates: matches };
  }
  if (matches.length === 0) {
    return { status: 'none', user: null, candidates: [] };
  }
  return { status: 'ambiguous', user: null, candidates: matches };
}

/**
 * Auto-match bot users to REGOS users by phone.
 * Only unique phone matches are linked; already-linked bot users are skipped unless force.
 */
function planRegosLinksByPhone(botUsers: any, regosUsers: any, { force = false }: Unchecked = {}) {
  const usedRegosIds: Set<any> = new Set();
  for (const botUser of botUsers || []) {
    if (botUser.regos_user_id != null && !force) {
      usedRegosIds.add(Number(botUser.regos_user_id));
    }
  }

  const results: any[] = [];
  for (const botUser of botUsers || []) {
    if (botUser.regos_user_id != null && !force) {
      results.push({
        botUserId: botUser.id,
        status: 'already_linked',
        regosUser: null,
        candidates: [],
      });
      continue;
    }

    const match = matchPhoneToRegosUser(botUser.phone, regosUsers, {
      excludeRegosIds: usedRegosIds,
    });
    if (match.status === 'matched') {
      usedRegosIds.add(Number(match.user.id));
    }
    results.push({
      botUserId: botUser.id,
      status: match.status,
      regosUser: match.user,
      candidates: match.candidates,
    });
  }
  return results;
}

export {
  phonesEqual,
  collectRegosUserPhones,
  mapRegosUserSummary,
  findRegosUsersByPhone,
  matchPhoneToRegosUser,
  planRegosLinksByPhone,
};
