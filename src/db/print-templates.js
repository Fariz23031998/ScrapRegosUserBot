const LABEL_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
html,body{margin:0;padding:0;width:58mm;height:40mm;font-family:Arial,sans-serif}
.box{display:flex;align-items:center;gap:3mm;padding:2mm;height:36mm;box-sizing:border-box}
img{width:28mm;height:28mm}
.serial{font-size:12pt;font-weight:700}
.name{font-size:9pt;margin-top:1mm}
.meta{font-size:8pt;color:#333;margin-top:1mm}
</style></head><body>
<div class="box">
  <img src="{{ qr_src }}" alt="QR"/>
  <div>
    <div class="serial">{{ serial }}</div>
    <div class="name">{{ device_name }}</div>
    <div class="meta">#{{ task_id }} {{ client_name }}</div>
  </div>
</div></body></html>`;

const RECEIPT_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
html,body{margin:0;padding:4mm;width:72mm;font-family:Arial,sans-serif;font-size:10pt}
h1{font-size:13pt;margin:0 0 2mm}
table{width:100%;border-collapse:collapse}
td{padding:1mm 0;vertical-align:top}
.right{text-align:right}
.total{font-weight:700;border-top:1px dashed #000;margin-top:2mm;padding-top:2mm}
.muted{color:#444;font-size:9pt}
</style></head><body>
<h1>{{ title }}</h1>
<div class="muted">{{ date }}</div>
<div class="muted">{{ client_name }} {{ client_phone }}</div>
<table>
{{ for line in lines }}
  <tr><td>{{ line.name }} × {{ line.quantity }}</td><td class="right">{{ line.amount }}</td></tr>
{{ end }}
</table>
<div class="total">Итого: {{ total }}</div>
<div>Оплачено: {{ paid }}</div>
<div>Остаток: {{ due }}</div>
</body></html>`;

const INVOICE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
body{font-family:Arial,sans-serif;margin:16mm;font-size:11pt;color:#111}
h1{margin:0 0 4px}
.meta{margin:12px 0}
.meta div{margin:2px 0}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}
th{background:#f2f2f2}
.right{text-align:right}
.totals{margin-top:12px;width:280px;margin-left:auto}
.totals div{display:flex;justify-content:space-between;margin:3px 0}
.signs{display:flex;justify-content:space-between;margin-top:36px}
.sign{width:40%}
.line{border-bottom:1px solid #333;margin-top:28px}
</style></head><body>
<h1>{{ title }}</h1>
<div>{{ date }}</div>
<div class="meta">
  <div>Филиал: {{ location_name }}</div>
  <div>Клиент: {{ client_name }}</div>
  <div>Телефон: {{ client_phone }}</div>
  <div>Адрес: {{ address }}</div>
  <div>Тип: {{ action_label }}</div>
  <div>Менеджер: {{ manager_name }}</div>
</div>
<table>
  <thead><tr><th>№</th><th>Наименование</th><th>Кол-во</th><th class="right">Сумма</th></tr></thead>
  <tbody>
  {{ for line in lines }}
    <tr><td>{{ line.number }}</td><td>{{ line.name }}</td><td>{{ line.quantity }}</td><td class="right">{{ line.amount }}</td></tr>
  {{ end }}
  </tbody>
</table>
<div class="totals">
  <div><span>Цена</span><strong>{{ total }}</strong></div>
  <div><span>Оплачено</span><span>{{ paid }}</span></div>
  <div><span>Остаток</span><strong>{{ due }}</strong></div>
</div>
<div class="signs">
  <div class="sign">Клиент<div class="line"></div></div>
  <div class="sign">Исполнитель<div class="line"></div></div>
</div>
</body></html>`;

const SEED = [
  { id: 'label', kind: 'label', width_mm: 58, height_mm: 40, html: LABEL_HTML },
  { id: 'receipt', kind: 'receipt', width_mm: 80, height_mm: 200, html: RECEIPT_HTML },
  { id: 'invoice', kind: 'invoice', width_mm: 210, height_mm: 297, html: INVOICE_HTML },
];

function ensurePrintTemplateTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS print_templates (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      width_mm REAL NOT NULL,
      height_mm REAL NOT NULL,
      html TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO print_templates (id, kind, version, width_mm, height_mm, html, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, datetime('now'))`
  );
  for (const seed of SEED) {
    insert.run(seed.id, seed.kind, seed.width_mm, seed.height_mm, seed.html);
  }
}

function mapTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    version: Number(row.version) || 1,
    paper: { widthMm: Number(row.width_mm) || 0, heightMm: Number(row.height_mm) || 0 },
    html: row.html || '',
  };
}

function listPrintTemplates(db) {
  ensurePrintTemplateTables(db);
  return db
    .prepare(
      `SELECT id, kind, version, width_mm, height_mm, html, updated_at
       FROM print_templates
       ORDER BY kind ASC`
    )
    .all()
    .map(mapTemplate);
}

function getPrintTemplate(db, id) {
  ensurePrintTemplateTables(db);
  return mapTemplate(
    db.prepare('SELECT id, kind, version, width_mm, height_mm, html, updated_at FROM print_templates WHERE id = ?').get(id)
  );
}

function updatePrintTemplate(db, id, input = {}) {
  const current = getPrintTemplate(db, id);
  if (!current) throw new Error('NOT_FOUND');
  const html = input.html != null ? String(input.html) : current.html;
  if (!html.trim()) throw new Error('INVALID_PRINT_TEMPLATE');
  const widthMm = input.width_mm != null || input.paper?.widthMm != null
    ? Number(input.width_mm ?? input.paper.widthMm)
    : current.paper.widthMm;
  const heightMm = input.height_mm != null || input.paper?.heightMm != null
    ? Number(input.height_mm ?? input.paper.heightMm)
    : current.paper.heightMm;
  if (!Number.isFinite(widthMm) || widthMm <= 0 || !Number.isFinite(heightMm) || heightMm <= 0) {
    throw new Error('INVALID_PRINT_TEMPLATE');
  }
  db.prepare(
    `UPDATE print_templates
     SET html = ?, width_mm = ?, height_mm = ?, version = version + 1, updated_at = datetime('now')
     WHERE id = ?`
  ).run(html, widthMm, heightMm, current.id);
  return getPrintTemplate(db, current.id);
}

module.exports = {
  ensurePrintTemplateTables,
  listPrintTemplates,
  getPrintTemplate,
  updatePrintTemplate,
};
