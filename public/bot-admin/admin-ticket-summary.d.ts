export function summarizeByDuration(
  durationSummary: any,
  durationsByTicketId: any,
  threshold: any
): { count: number; slaBreached: number; rated: number };
export function buildDurationsByTicketId(durationSummary: any): Record<string, number>;
export function hasPendingCallDurations(durationSummary: any): boolean;
export function resolveCallDuration(call: any, durationsByTicketId: any): number | null;
