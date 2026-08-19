import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  enabledPrintersFromStations,
  getPrintSettings,
  listPrintTemplates,
  printerKey,
  printerOptionLabel,
  savePrintSettings,
  savePrintTemplate,
  sendTestPrint,
} from "../api/print";
import { listSettingsLocations } from "../api/settings";
import type { PrintTemplate } from "../lib/types";
import LoadingState from "./LoadingState";

const KIND_TITLES: Record<string, string> = {
  label: "Этикетка",
  receipt: "Чек",
  invoice: "Счёт",
};

const KIND_HINTS: Record<string, string> = {
  label: "58×40 мм, QR и серийный номер. Плейсхолдеры: {{ serial }}, {{ qr_src }}, {{ device_name }}, {{ task_id }}, {{ client_name }}.",
  receipt: "80 мм. Плейсхолдеры: {{ title }}, {{ date }}, {{ client_name }}, {{ total }}, {{ paid }}, {{ due }} и цикл {{ for line in lines }}.",
  invoice: "A4. Те же поля, что у чека, плюс {{ location_name }}, {{ address }}, {{ manager_name }}, {{ line.number }}.",
};

type TemplateDraft = {
  html: string;
  widthMm: string;
  heightMm: string;
};

function credentialStatusLabel(configured?: boolean, hint?: string, source?: string) {
  if (!configured) return "не задан";
  const masked = hint ? `••••${hint}` : "задан";
  if (source === "database") return `${masked} (БД)`;
  if (source === "env") return `${masked} (env)`;
  return masked;
}

function gatewayWsUrl(wsPath: string) {
  const path = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  if (import.meta.env.DEV) {
    const backend = String(import.meta.env.VITE_API_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
    return `${backend.replace(/^http/i, "ws")}${path}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

function draftFromTemplate(template: PrintTemplate): TemplateDraft {
  return {
    html: template.html || "",
    widthMm: String(template.paper?.widthMm || ""),
    heightMm: String(template.paper?.heightMm || ""),
  };
}

export default function SettingsPrintTab({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [message, setMessage] = useState<{ text: string; type?: "success" | "error" } | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [kindTab, setKindTab] = useState("label");
  const [drafts, setDrafts] = useState<Record<string, TemplateDraft>>({});
  const [testPrinterKey, setTestPrinterKey] = useState("");
  const [testLocationId, setTestLocationId] = useState("");

  const settingsQuery = useQuery({
    queryKey: ["print-settings"],
    queryFn: getPrintSettings,
    refetchInterval: 8000,
  });
  const templatesQuery = useQuery({
    queryKey: ["print-templates"],
    queryFn: listPrintTemplates,
  });
  const locationsQuery = useQuery({
    queryKey: ["settings-locations"],
    queryFn: listSettingsLocations,
  });

  const settings = settingsQuery.data;
  const templates = templatesQuery.data?.templates || [];
  const locations = locationsQuery.data?.locations || [];

  useEffect(() => {
    if (!settings || hydrated) return;
    setEnabled(settings.enabled);
    setHydrated(true);
  }, [settings, hydrated]);

  useEffect(() => {
    if (!templates.length) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const template of templates) {
        if (!next[template.id]) next[template.id] = draftFromTemplate(template);
      }
      return next;
    });
    setKindTab((current) => (templates.some((item) => item.id === current) ? current : templates[0].id));
  }, [templates]);

  const wsUrl = useMemo(() => gatewayWsUrl(settings?.ws_path || "/print-gateway/ws"), [settings?.ws_path]);
  const activeTemplate = templates.find((item) => item.id === kindTab) || templates[0];
  const activeDraft = activeTemplate ? drafts[activeTemplate.id] : null;
  const locationNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const location of locations) map.set(String(location.id), location.name);
    return map;
  }, [locations]);

  const testPrinters = useMemo(
    () =>
      enabledPrintersFromStations(settings?.stations, {
        locationId: testLocationId || undefined,
      }),
    [settings?.stations, testLocationId],
  );

  useEffect(() => {
    if (!testPrinters.length) {
      setTestPrinterKey("");
      return;
    }
    if (!testPrinters.some((printer) => printerKey(printer) === testPrinterKey)) {
      setTestPrinterKey(printerKey(testPrinters[0]));
    }
  }, [testPrinters, testPrinterKey]);

  const saveGateway = useMutation({
    mutationFn: () =>
      savePrintSettings({
        enabled,
        ...(clearToken ? { clear_token: true } : tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["print-settings"], data);
      setEnabled(data.enabled);
      setTokenDraft("");
      setClearToken(false);
      setMessage({ text: "Настройки Print Service сохранены.", type: "success" });
    },
    onError: (error: Error) => setMessage({ text: error.message, type: "error" }),
  });

  const saveTemplate = useMutation({
    mutationFn: (template: PrintTemplate) => {
      const draft = drafts[template.id] || draftFromTemplate(template);
      const widthMm = Number(draft.widthMm);
      const heightMm = Number(draft.heightMm);
      return savePrintTemplate(template.id, {
        html: draft.html,
        paper: { widthMm, heightMm },
      });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["print-templates"] });
      setDrafts((prev) => ({ ...prev, [data.template.id]: draftFromTemplate(data.template) }));
      setMessage({ text: `Шаблон «${KIND_TITLES[data.template.kind] || data.template.id}» сохранён.`, type: "success" });
    },
    onError: (error: Error) => setMessage({ text: error.message, type: "error" }),
  });

  const testPrint = useMutation({
    mutationFn: () => {
      const printer = testPrinters.find((item) => printerKey(item) === testPrinterKey);
      if (!printer) throw new Error("Выберите принтер.");
      return sendTestPrint({
        kind: printer.kind as "label" | "receipt" | "invoice",
        printer_name: printer.name,
        station_id: printer.station_id,
        location_id: testLocationId ? Number(testLocationId) : null,
      });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["print-settings"] });
      const connected = data.connected ? `, станций онлайн: ${data.connected}` : ", станций онлайн нет — задание в очереди";
      setMessage({ text: `Тестовая печать отправлена${connected}.`, type: "success" });
    },
    onError: (error: Error) => setMessage({ text: error.message, type: "error" }),
  });

  async function copyWsUrl() {
    try {
      await navigator.clipboard.writeText(wsUrl);
      setMessage({ text: "Адрес WebSocket скопирован.", type: "success" });
    } catch {
      setMessage({ text: "Не удалось скопировать адрес.", type: "error" });
    }
  }

  if (settingsQuery.isLoading) return <LoadingState />;
  if (!settings) return <p className="empty-state">Не удалось загрузить настройки печати.</p>;

  return (
    <div className="settings-catalogs">
      {message ? <p className={`message ${message.type || ""}`}>{message.text}</p> : null}

      <section className="settings-catalog">
        <div className="settings-catalog__header">
          <h2>Шлюз Print Service</h2>
          {canEdit ? (
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={saveGateway.isPending}
              onClick={() => saveGateway.mutate()}
            >
              Сохранить
            </button>
          ) : null}
        </div>
        <form className="stack-form settings-form" onSubmit={(event) => event.preventDefault()}>
          <p className="muted-copy">
            Windows-агент подключается по WebSocket, забирает шаблоны и печатает этикетки, чеки и счета. Принтеры
            создаются в агенте (имя, тип, Windows-принтер). Здесь задаются токен, шаблоны и печать по имени
            включённого принтера.
          </p>
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!canEdit || settings.env_forced_off}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>Включить шлюз печати</span>
          </label>
          {settings.env_forced_off ? (
            <p className="muted-copy">Шлюз принудительно выключен через PRINT_GATEWAY_ENABLED=0 в env.</p>
          ) : null}
          <label>
            Адрес для агента
            <div className="settings-print-url">
              <input value={wsUrl} readOnly />
              <button type="button" className="btn-secondary btn-sm" onClick={() => void copyWsUrl()}>
                <Copy size={15} aria-hidden="true" />
                Копировать
              </button>
            </div>
          </label>
          <label>
            Токен
            <input
              type="password"
              autoComplete="new-password"
              value={clearToken ? "" : tokenDraft}
              disabled={!canEdit || clearToken}
              placeholder={
                clearToken
                  ? "Будет очищен в БД"
                  : credentialStatusLabel(settings.token_configured, settings.token_hint, settings.token_source)
              }
              onChange={(event) => {
                setClearToken(false);
                setTokenDraft(event.target.value);
              }}
            />
          </label>
          <p className="muted-copy">
            Тот же токен укажите в Print Service. GET никогда не возвращает полный токен. Если поле в БД пустое,
            используется PRINT_GATEWAY_TOKEN из env.
          </p>
          {canEdit ? (
            <div className="settings-credentials__actions">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => {
                  setTokenDraft("");
                  setClearToken(true);
                }}
              >
                Очистить токен в БД
              </button>
            </div>
          ) : null}
        </form>
      </section>

      <section className="settings-catalog">
        <div className="settings-catalog__header">
          <h2>Станции</h2>
          <span className="muted-copy">Онлайн: {settings.connected}</span>
        </div>
        {!settings.stations.length ? (
          <p className="empty-state">Нет подключённых агентов. Укажите токен и адрес WebSocket в Print Service.</p>
        ) : (
          <div className="settings-print-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Имя</th>
                  <th>Station ID</th>
                  <th>Location ID</th>
                  <th>Филиал</th>
                  <th>Принтеры</th>
                </tr>
              </thead>
              <tbody>
                {settings.stations.map((station) => (
                  <tr key={station.station_id}>
                    <td>{station.station_name || "—"}</td>
                    <td>{station.station_id}</td>
                    <td>{station.location_id || "все"}</td>
                    <td>
                      {station.location_id
                        ? locationNameById.get(station.location_id) || "не найден"
                        : "Все филиалы"}
                    </td>
                    <td>
                      {station.printers?.length ? (
                        <ul className="settings-print-printers">
                          {station.printers.map((printer) => (
                            <li
                              key={`${station.station_id}-${printer.name}`}
                              className={printer.enabled ? undefined : "muted-copy"}
                            >
                              {printer.name} ({KIND_TITLES[printer.kind] || printer.kind})
                              {printer.enabled ? "" : " — выкл."}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {locations.length ? (
          <p className="muted-copy">
            В настройках агента поле Location ID — это id филиала:{" "}
            {locations.map((location) => `${location.name} (${location.id})`).join(", ")}. Пустое значение принимает
            задания всех филиалов.
          </p>
        ) : (
          <p className="muted-copy">Сначала создайте филиалы на вкладке «Филиалы и оплата», затем укажите их id в агенте.</p>
        )}
      </section>

      <section className="settings-catalog">
        <div className="settings-catalog__header">
          <h2>Тестовая печать</h2>
        </div>
        <form className="stack-form settings-form" onSubmit={(event) => event.preventDefault()}>
          <div className="settings-print-paper">
            <label>
              Принтер
              <select
                value={testPrinterKey}
                disabled={!canEdit || !testPrinters.length}
                onChange={(event) => setTestPrinterKey(event.target.value)}
              >
                {testPrinters.length ? (
                  testPrinters.map((printer) => (
                    <option key={printerKey(printer)} value={printerKey(printer)}>
                      {printerOptionLabel(printer, testPrinters)} — {KIND_TITLES[printer.kind] || printer.kind}
                    </option>
                  ))
                ) : (
                  <option value="">Нет включённых принтеров</option>
                )}
              </select>
            </label>
            <label>
              Филиал
              <select
                value={testLocationId}
                disabled={!canEdit}
                onChange={(event) => setTestLocationId(event.target.value)}
              >
                <option value="">Все станции</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} ({location.id})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {canEdit ? (
            <div>
              <button
                type="button"
                className="btn-secondary"
                disabled={testPrint.isPending || !settings.token_configured || !testPrinters.length}
                onClick={() => testPrint.mutate()}
              >
                Отправить тест
              </button>
            </div>
          ) : null}
        </form>
      </section>

      <section className="settings-catalog">
        <div className="settings-catalog__header">
          <h2>Шаблоны</h2>
          {canEdit && activeTemplate ? (
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={saveTemplate.isPending}
              onClick={() => saveTemplate.mutate(activeTemplate)}
            >
              Сохранить шаблон
            </button>
          ) : null}
        </div>
        {templatesQuery.isLoading ? (
          <LoadingState />
        ) : !templates.length ? (
          <p className="empty-state">Шаблоны печати не найдены.</p>
        ) : (
          <>
            <div className="role-tabs" role="tablist" aria-label="Шаблоны печати">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className={`role-tab${kindTab === template.id ? " role-tab--active" : ""}`}
                  role="tab"
                  aria-selected={kindTab === template.id}
                  onClick={() => setKindTab(template.id)}
                >
                  {KIND_TITLES[template.kind] || template.id}
                </button>
              ))}
            </div>
            {activeTemplate && activeDraft ? (
              <form className="stack-form settings-form" onSubmit={(event) => event.preventDefault()}>
                <p className="muted-copy">{KIND_HINTS[activeTemplate.kind] || "HTML с плейсхолдерами {{ name }}."}</p>
                <div className="settings-print-paper">
                  <label>
                    Ширина, мм
                    <input
                      type="number"
                      min="1"
                      step="any"
                      disabled={!canEdit}
                      value={activeDraft.widthMm}
                      onChange={(event) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [activeTemplate.id]: { ...activeDraft, widthMm: event.target.value },
                        }))
                      }
                    />
                  </label>
                  <label>
                    Высота, мм
                    <input
                      type="number"
                      min="1"
                      step="any"
                      disabled={!canEdit}
                      value={activeDraft.heightMm}
                      onChange={(event) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [activeTemplate.id]: { ...activeDraft, heightMm: event.target.value },
                        }))
                      }
                    />
                  </label>
                </div>
                <label>
                  HTML
                  <textarea
                    className="settings-print-html"
                    spellCheck={false}
                    disabled={!canEdit}
                    value={activeDraft.html}
                    onChange={(event) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [activeTemplate.id]: { ...activeDraft, html: event.target.value },
                      }))
                    }
                  />
                </label>
              </form>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
