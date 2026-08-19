function formatMoney(amount, currency = 'UZS') {
  const n = Number(amount);
  const value = Number.isFinite(n) ? Math.round(n) : 0;
  return `${value.toLocaleString('ru-RU')} ${currency}`;
}

function lineName(line) {
  return line.device_name || line.service_name || line.name || 'Позиция';
}

function taskLines(task) {
  const devices = (task.devices || []).map((line) => ({ ...line, name: line.device_name || `Устройство #${line.device_id}` }));
  const services = (task.services || []).map((line) => ({ ...line, name: line.service_name || `Услуга #${line.service_id}` }));
  return [...devices, ...services];
}

function buildLabelData({ serial, task, deviceName }) {
  return {
    serial: serial.code,
    qr: serial.code,
    device_name: deviceName || '',
    task_id: task?.id ?? serial.task_id,
    task_title: task?.title || '',
    client_name: task?.client_name || '',
    client_phone: task?.client_phone || '',
  };
}

function buildTaskDocumentData(task) {
  const lines = taskLines(task).map((line, index) => ({
    number: index + 1,
    name: lineName(line),
    quantity: Number(line.quantity) > 0 ? Number(line.quantity) : 1,
    amount: formatMoney(line.price_uzs, 'UZS'),
  }));
  const totals = task.totals || {};
  const payments = task.payment_totals || {};
  return {
    title: `Счёт №${task.id}`,
    subtitle: task.title || '',
    date: task.created_at || '',
    location_name: task.location?.name || '',
    client_name: task.client_name || '',
    client_phone: task.client_phone || '',
    address: task.address || '',
    action_label: task.action_label || task.action || '',
    manager_name: task.manager?.name || '',
    technician_name: task.technician?.name || '',
    lines,
    total: formatMoney(totals.price_uzs, 'UZS'),
    paid: formatMoney(payments.paid_uzs, 'UZS'),
    due: formatMoney(payments.due_uzs, 'UZS'),
  };
}

module.exports = {
  buildLabelData,
  buildTaskDocumentData,
};
