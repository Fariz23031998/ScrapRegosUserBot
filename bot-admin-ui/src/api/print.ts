import { apiFetch } from "./client";
import type { PrintEnabledPrinter, PrintSettings, PrintStation, PrintTemplate } from "../lib/types";

export function printTask(
  taskId: number,
  payload: {
    kind: "label" | "receipt" | "invoice";
    serial_ids?: number[];
    printer_name: string;
    station_id?: string;
  },
) {
  return apiFetch<{ jobs: Array<{ id: string; kind: string }>; connected: number }>(
    `/bot-admin/api/tasks/${taskId}/print`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export function getPrintSettings() {
  return apiFetch<PrintSettings>("/bot-admin/api/settings/print");
}

export function savePrintSettings(payload: {
  enabled?: boolean;
  token?: string;
  clear_token?: boolean;
}) {
  return apiFetch<PrintSettings>("/bot-admin/api/settings/print", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function listPrintTemplates() {
  return apiFetch<{ templates: PrintTemplate[] }>("/bot-admin/api/print/templates");
}

export function savePrintTemplate(
  id: string,
  payload: { html: string; paper: { widthMm: number; heightMm: number } },
) {
  return apiFetch<{ template: PrintTemplate }>(`/bot-admin/api/print/templates/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function sendTestPrint(payload: {
  kind?: "label" | "receipt" | "invoice";
  location_id?: number | null;
  printer_name: string;
  station_id?: string;
}) {
  return apiFetch<{ job: { id: string; kind: string }; connected: number }>("/bot-admin/api/print/test", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function stationMatchesLocation(station: PrintStation, locationId?: string | number | null) {
  if (locationId == null || locationId === "") return true;
  if (!station.location_id) return true;
  return String(station.location_id) === String(locationId);
}

export function enabledPrintersFromStations(
  stations: PrintStation[] | undefined,
  options: { kind?: string; locationId?: string | number | null } = {},
): PrintEnabledPrinter[] {
  const wantKind = options.kind ? String(options.kind).toLowerCase() : "";
  const result: PrintEnabledPrinter[] = [];
  for (const station of stations || []) {
    if (!stationMatchesLocation(station, options.locationId)) continue;
    for (const printer of station.printers || []) {
      if (!printer.enabled) continue;
      if (wantKind && printer.kind !== wantKind) continue;
      result.push({
        name: printer.name,
        kind: printer.kind,
        enabled: true,
        station_id: station.station_id,
        station_name: station.station_name || "",
        location_id: station.location_id || "",
      });
    }
  }
  return result;
}

export function printerKey(printer: { station_id: string; name: string }) {
  return `${printer.station_id}::${printer.name}`;
}

export function printerOptionLabel(printer: PrintEnabledPrinter, all: PrintEnabledPrinter[]) {
  const duplicates = all.filter((item) => item.name.toLowerCase() === printer.name.toLowerCase()).length > 1;
  return duplicates && printer.station_name ? `${printer.name} (${printer.station_name})` : printer.name;
}
