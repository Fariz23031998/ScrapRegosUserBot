const { getSessionActor, requireRight } = require('./bot-admin-auth');
const { getLocationViewer } = require('../db/locations');
const { listRegosChannelSettings } = require('../db/regos-channel-settings');
const { buildStaffReport } = require('../db/staff-reports');
const {
  DEFAULT_DUPLICATE_INTERVAL_MINUTES,
  RegosCrmError,
  buildTicketFilters,
  fetchAllTickets,
} = require('../integrations/regos-crm');
const { countTicketsByResponsible } = require('./ticket-duration');

function parseUnixQuery(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function registerReportRoutes(router, db) {
  router.get('/api/reports/staff', requireRight(db, 'see_all_report'), async (req, res) => {
    try {
      const fromDate = String(req.query.from_date || '').trim();
      const toDate = String(req.query.to_date || '').trim();
      const minimumCallDurationRaw = String(req.query.minimum_call_duration_seconds || '').trim();
      const durationFilterActive = minimumCallDurationRaw !== '';
      const minimumCallDuration = Number(minimumCallDurationRaw);
      if (durationFilterActive && (!Number.isFinite(minimumCallDuration) || minimumCallDuration < 0)) {
        return res.status(400).json({ message: 'Минимальная длительность должна быть неотрицательной.' });
      }
      const withoutDuplicates =
        req.query.without_duplicates === '1' || req.query.without_duplicates === 'true';
      let duplicateIntervalMinutes = Number(req.query.duplicate_interval_minutes);
      if (!Number.isFinite(duplicateIntervalMinutes) || duplicateIntervalMinutes < 0) {
        duplicateIntervalMinutes = DEFAULT_DUPLICATE_INTERVAL_MINUTES;
      }

      const filters = buildTicketFilters({
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });
      let tickets = await fetchAllTickets({
        filters: filters.length ? filters : undefined,
        sort_orders: [{ column: 'last_update', direction: 'DESC' }],
      });

      const ticketCounts = countTicketsByResponsible(tickets, {
        withoutDuplicates,
        duplicateIntervalMinutes,
        minimumCallDuration: durationFilterActive ? minimumCallDuration : null,
        channelSettings: listRegosChannelSettings(db),
        db,
      });

      const report = buildStaffReport(db, {
        fromUnix: parseUnixQuery(fromDate),
        toUnix: parseUnixQuery(toDate),
        viewer: getLocationViewer(db, getSessionActor(req)),
        ticketsByRegosUserId: ticketCounts.byResponsible,
        unassignedTicketCount: ticketCounts.unassigned,
      });

      return res.json(report);
    } catch (error) {
      if (error instanceof RegosCrmError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error('Staff report error:', error);
      return res.status(500).json({ message: 'Не удалось построить отчёт.' });
    }
  });
}

module.exports = {
  registerReportRoutes,
};
