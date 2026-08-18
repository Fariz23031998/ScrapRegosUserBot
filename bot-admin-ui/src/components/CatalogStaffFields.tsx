export type CatalogStaffFieldsValue = {
  manager_sale_percent: string;
  technician_score: string;
};

export function emptyStaffEditor(): CatalogStaffFieldsValue {
  return { manager_sale_percent: "0", technician_score: "0" };
}

export function staffEditorFromItem(item: {
  manager_sale_percent?: number | null;
  technician_score?: number | null;
}): CatalogStaffFieldsValue {
  return {
    manager_sale_percent: item.manager_sale_percent != null ? String(item.manager_sale_percent) : "0",
    technician_score: item.technician_score != null ? String(item.technician_score) : "0",
  };
}

export function staffPayloadFromEditor(editor: CatalogStaffFieldsValue) {
  return {
    manager_sale_percent: editor.manager_sale_percent.trim() === "" ? 0 : Number(editor.manager_sale_percent),
    technician_score: editor.technician_score.trim() === "" ? 0 : Number(editor.technician_score),
  };
}

export function formatSalePercent(value: number | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} %`;
}

export function formatTechnicianScore(value: number | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

export default function CatalogStaffFields({
  value,
  onChange,
}: {
  value: CatalogStaffFieldsValue;
  onChange: (value: CatalogStaffFieldsValue) => void;
}) {
  return (
    <div className="filters-grid">
      <label>
        Процент с продажи для менеджера
        <input
          type="number"
          min="0"
          max="100"
          step="any"
          value={value.manager_sale_percent}
          onChange={(event) => onChange({ ...value, manager_sale_percent: event.target.value })}
        />
      </label>
      <label>
        Баллы для техника
        <input
          type="number"
          min="0"
          step="any"
          value={value.technician_score}
          onChange={(event) => onChange({ ...value, technician_score: event.target.value })}
        />
      </label>
    </div>
  );
}
