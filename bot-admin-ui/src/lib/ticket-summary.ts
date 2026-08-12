export function resolveCallDuration(
  call: { id?: number; duration_seconds?: number },
  durationsByTicketId?: Record<string, number>,
): number | null {
  const fromMap = Number(durationsByTicketId?.[String(call?.id)]);
  if (Number.isFinite(fromMap) && fromMap > 0) return fromMap;
  const fromCall = Number(call?.duration_seconds);
  if (Number.isFinite(fromCall) && fromCall > 0) return fromCall;
  return null;
}

export function buildDurationsByTicketId(durationSummary: {
  calls?: Array<{ id?: number; duration_seconds?: number }>;
}): Record<string, number> {
  const durationsByTicketId: Record<string, number> = {};
  const calls = Array.isArray(durationSummary?.calls) ? durationSummary.calls : [];
  for (const call of calls) {
    const duration = resolveCallDuration(call, undefined);
    if (duration != null) {
      durationsByTicketId[String(call.id)] = duration;
    }
  }
  return durationsByTicketId;
}

export function hasPendingCallDurations(durationSummary: {
  calls?: Array<{ id?: number; hasRecording?: boolean; duration_seconds?: number }>;
}): boolean {
  const calls = Array.isArray(durationSummary?.calls) ? durationSummary.calls : [];
  return calls.some((call) => {
    if (!call?.hasRecording) return false;
    return resolveCallDuration(call, undefined) == null;
  });
}

export function summarizeByDuration(
  durationSummary: {
    base?: { count?: number; slaBreached?: number; rated?: number };
    calls?: Array<{
      id?: number;
      hasRecording?: boolean;
      duration_seconds?: number;
      slaBreached?: boolean;
      rated?: boolean;
    }>;
  },
  durationsByTicketId: Record<string, number>,
  threshold: number,
): { count: number; slaBreached: number; rated: number } {
  const summary = {
    count: Number(durationSummary?.base?.count) || 0,
    slaBreached: Number(durationSummary?.base?.slaBreached) || 0,
    rated: Number(durationSummary?.base?.rated) || 0,
  };
  const limit = Number(threshold);
  const calls = Array.isArray(durationSummary?.calls) ? durationSummary.calls : [];

  for (const call of calls) {
    if (!call.hasRecording) continue;
    const duration = resolveCallDuration(call, durationsByTicketId);
    if (duration == null || !Number.isFinite(limit) || duration <= limit) continue;
    summary.count += 1;
    if (call.slaBreached) summary.slaBreached += 1;
    if (call.rated) summary.rated += 1;
  }

  return summary;
}
