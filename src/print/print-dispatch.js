const { createPrintJob } = require('../db/print-jobs');
const { listSerialsForLine, markSerialsPrinted } = require('../db/task-device-serials');
const { getPrintHub } = require('./print-gateway-ws');
const { buildLabelData, buildTaskDocumentData } = require('./print-payload');

function deliver(job) {
  const hub = getPrintHub();
  if (hub) hub.deliverJob(job);
  return job;
}

function resolvePrinter(input = {}) {
  const printerName = String(input.printer_name || input.printerName || '').trim();
  if (!printerName) throw new Error('PRINT_PRINTER_REQUIRED');
  const requestedKind = String(input.kind || '').trim().toLowerCase();
  if (requestedKind && !['label', 'receipt', 'invoice'].includes(requestedKind)) {
    throw new Error('INVALID_PRINT_KIND');
  }
  const hub = getPrintHub();
  if (!hub) {
    if (!requestedKind) throw new Error('INVALID_PRINT_KIND');
    return {
      printerName,
      stationId: String(input.station_id || input.stationId || '').trim(),
      kind: requestedKind,
    };
  }
  const found = hub.findEnabledPrinter({
    name: printerName,
    kind: requestedKind || undefined,
    stationId: input.station_id || input.stationId,
    locationId: input.location_id,
  });
  if (!found) throw new Error('PRINT_PRINTER_UNAVAILABLE');
  return {
    printerName: found.name,
    stationId: found.station_id,
    kind: found.kind,
  };
}

function enqueueLabelJobs(db, { task, serials, deviceName, printer_name, printerName, station_id, stationId }) {
  const printer = resolvePrinter({
    printer_name: printer_name || printerName,
    station_id: station_id || stationId,
    kind: 'label',
    location_id: task?.location_id,
  });
  const jobs = [];
  const ids = [];
  for (const serial of serials || []) {
    const job = createPrintJob(db, {
      kind: 'label',
      templateId: 'label',
      location_id: task?.location_id,
      printerName: printer.printerName,
      stationId: printer.stationId,
      data: buildLabelData({ serial, task, deviceName: deviceName || serial.device_name }),
    });
    deliver(job);
    jobs.push(job);
    ids.push(serial.id);
  }
  markSerialsPrinted(db, ids);
  return jobs;
}

function enqueueSerialLabelsForTask(db, task, serialIds, printer = {}) {
  const wanted = new Set((serialIds || []).map((id) => Number(id)).filter((id) => id > 0));
  const jobs = [];
  for (const line of task.devices || []) {
    const serials = (line.serials || listSerialsForLine(db, line.id)).filter((serial) => {
      if (wanted.size && !wanted.has(serial.id)) return false;
      return true;
    });
    if (!serials.length) continue;
    jobs.push(
      ...enqueueLabelJobs(db, {
        task,
        serials,
        deviceName: line.device_name,
        printer_name: printer.printer_name || printer.printerName,
        station_id: printer.station_id || printer.stationId,
      })
    );
  }
  if (!jobs.length) throw new Error('PRINT_SERIALS_EMPTY');
  return jobs;
}

function enqueueTaskDocument(db, task, kind, printer = {}) {
  const resolved = resolvePrinter({
    printer_name: printer.printer_name || printer.printerName,
    station_id: printer.station_id || printer.stationId,
    kind,
    location_id: task.location_id,
  });
  if (resolved.kind !== 'receipt' && resolved.kind !== 'invoice') throw new Error('INVALID_PRINT_KIND');
  const job = createPrintJob(db, {
    kind: resolved.kind,
    templateId: resolved.kind,
    location_id: task.location_id,
    printerName: resolved.printerName,
    stationId: resolved.stationId,
    data: buildTaskDocumentData(task),
  });
  return deliver(job);
}

function enqueueTestPrint(db, { kind, location_id, copies, printer_name, printerName, station_id, stationId } = {}) {
  const printer = resolvePrinter({
    printer_name: printer_name || printerName,
    station_id: station_id || stationId,
    kind,
    location_id,
  });
  const data =
    printer.kind === 'label'
      ? {
          serial: 'SR00000000',
          qr: 'SR00000000',
          device_name: 'Тест печати',
          task_id: 0,
          task_title: 'Тест',
          client_name: 'Тест',
          client_phone: '',
        }
      : {
          title: 'Тест печати',
          subtitle: '',
          date: new Date().toISOString(),
          location_name: '',
          client_name: 'Тест',
          client_phone: '',
          address: '',
          action_label: '',
          manager_name: '',
          technician_name: '',
          lines: [{ number: 1, name: 'Тестовая позиция', quantity: 1, amount: '0 UZS' }],
          total: '0 UZS',
          paid: '0 UZS',
          due: '0 UZS',
        };
  const job = createPrintJob(db, {
    kind: printer.kind,
    templateId: printer.kind,
    location_id,
    copies,
    printerName: printer.printerName,
    stationId: printer.stationId,
    data,
  });
  return deliver(job);
}

function uniqueLabelPrinterForLocation(locationId) {
  const hub = getPrintHub();
  if (!hub) return null;
  const printers = hub.listEnabledPrinters({ kind: 'label', locationId });
  return printers.length === 1 ? printers[0] : null;
}

module.exports = {
  enqueueLabelJobs,
  enqueueSerialLabelsForTask,
  enqueueTaskDocument,
  enqueueTestPrint,
  uniqueLabelPrinterForLocation,
};
