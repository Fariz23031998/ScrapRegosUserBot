import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { reportEventsUrl, reportJobPath } from "../api/reports";
import { useActiveReportJob } from "../contexts/ReportJobViewContext";
import { useToast } from "../contexts/ToastContext";

export type ReportStatusEvent = {
  type?: string;
  job_id?: number;
  report_type?: string;
  status?: string;
  message?: string;
};

export function isReportStatusEvent(event: ReportStatusEvent | null | undefined): boolean {
  return event?.type === "report_ready" || event?.type === "report_failed";
}

export function useReportEvents(enabled: boolean) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { jobId: activeJobId } = useActiveReportJob();
  const activeJobIdRef = useRef(activeJobId);
  activeJobIdRef.current = activeJobId;

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(reportEventsUrl(), { withCredentials: true });

    function onFrame(messageEvent: MessageEvent) {
      let event: ReportStatusEvent;
      try {
        event = JSON.parse(String(messageEvent.data || "")) as ReportStatusEvent;
      } catch {
        return;
      }
      if (!isReportStatusEvent(event)) return;

      const jobId = Number(event.job_id);
      if (Number.isFinite(jobId) && jobId > 0) {
        void queryClient.invalidateQueries({ queryKey: ["report-job-status", jobId] });
        void queryClient.invalidateQueries({ queryKey: ["report-jobs"] });
      }

      if (Number.isFinite(jobId) && jobId === Number(activeJobIdRef.current)) return;

      pushToast({
        message:
          event.message ||
          (event.type === "report_ready" ? "Отчёт готов." : "Не удалось построить отчёт."),
        tone: event.type === "report_ready" ? "success" : "error",
        href: Number.isFinite(jobId) && jobId > 0 ? reportJobPath(jobId) : "/reports",
      });
    }

    source.onmessage = onFrame;
    source.addEventListener("report_ready", onFrame);
    source.addEventListener("report_failed", onFrame);

    return () => {
      source.close();
    };
  }, [enabled, queryClient, pushToast]);
}
