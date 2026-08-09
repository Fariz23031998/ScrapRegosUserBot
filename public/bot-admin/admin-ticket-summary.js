(function exposeTicketSummary(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.TicketSummary = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTicketSummary() {
  function summarizeByDuration(durationSummary, durationsByTicketId, threshold) {
    const summary = {
      count: Number(durationSummary?.base?.count) || 0,
      slaBreached: Number(durationSummary?.base?.slaBreached) || 0,
      rated: Number(durationSummary?.base?.rated) || 0,
    };
    const calls = Array.isArray(durationSummary?.calls) ? durationSummary.calls : [];

    for (const call of calls) {
      if (!call.hasRecording) continue;
      const duration = Number(durationsByTicketId?.[String(call.id)]);
      if (!Number.isFinite(duration) || duration <= threshold) continue;
      summary.count += 1;
      if (call.slaBreached) summary.slaBreached += 1;
      if (call.rated) summary.rated += 1;
    }

    return summary;
  }

  return { summarizeByDuration };
});
