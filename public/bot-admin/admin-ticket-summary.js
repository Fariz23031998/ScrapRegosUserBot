(function exposeTicketSummary(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  // Always expose for browser <script> tags (even if a module shim exists).
  if (root) {
    root.TicketSummary = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTicketSummary() {
  function resolveCallDuration(call, durationsByTicketId) {
    const fromMap = Number(durationsByTicketId?.[String(call?.id)]);
    if (Number.isFinite(fromMap) && fromMap > 0) return fromMap;
    const fromCall = Number(call?.duration_seconds);
    if (Number.isFinite(fromCall) && fromCall > 0) return fromCall;
    return null;
  }

  function buildDurationsByTicketId(durationSummary) {
    const durationsByTicketId = {};
    const calls = Array.isArray(durationSummary?.calls) ? durationSummary.calls : [];
    for (const call of calls) {
      const duration = resolveCallDuration(call, null);
      if (duration != null) {
        durationsByTicketId[String(call.id)] = duration;
      }
    }
    return durationsByTicketId;
  }

  function hasPendingCallDurations(durationSummary) {
    const calls = Array.isArray(durationSummary?.calls) ? durationSummary.calls : [];
    return calls.some((call) => {
      if (!call?.hasRecording) return false;
      return resolveCallDuration(call, null) == null;
    });
  }

  /**
   * Totals = message-channel base + call tickets with duration strictly greater than threshold.
   * Calls without a known positive duration are excluded while the filter is active.
   */
  function summarizeByDuration(durationSummary, durationsByTicketId, threshold) {
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

  return {
    summarizeByDuration,
    buildDurationsByTicketId,
    hasPendingCallDurations,
    resolveCallDuration,
  };
});
