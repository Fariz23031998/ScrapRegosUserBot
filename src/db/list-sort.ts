const TIE_BREAKER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const STAFF_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * ORDER BY for one whitelisted column. `columns` values are static SQL expressions.
 * User text is never concatenated. Empty or unknown sorts return null so the caller
 * keeps its default order. The tie-breaker keeps pages stable.
 */
export function resolveListOrderBy(
  raw: unknown,
  columns: Record<string, string>,
  tieBreaker: string,
): string | null {
  if (!TIE_BREAKER.test(tieBreaker)) {
    throw new Error('Invalid sort tie-breaker');
  }
  const value = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
  const trimmed = value.trim();
  if (!trimmed) return null;
  const splitAt = trimmed.lastIndexOf(':');
  if (splitAt <= 0) return null;
  const column = trimmed.slice(0, splitAt);
  const direction = trimmed.slice(splitAt + 1).trim().toUpperCase();
  if (direction !== 'ASC' && direction !== 'DESC') return null;
  if (!Object.prototype.hasOwnProperty.call(columns, column)) return null;
  const expression = columns[column];
  if (!expression || expression.includes(';') || expression.includes('--')) return null;
  return `ORDER BY ${expression} ${direction}, ${tieBreaker} ${direction}`;
}

export function staffNameSql(alias: string): string {
  if (!STAFF_ALIAS.test(alias)) {
    throw new Error('Invalid staff SQL alias');
  }
  return `COALESCE(NULLIF(TRIM(${alias}.display_name), ''), NULLIF(TRIM(COALESCE(${alias}.first_name, '') || ' ' || COALESCE(${alias}.last_name, '')), ''), NULLIF(${alias}.username, ''), ${alias}.admin_login) COLLATE NOCASE`;
}
