import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type ReportJobViewValue = {
  jobId: number | null;
  setJobId: (id: number | null) => void;
};

const ReportJobViewContext = createContext<ReportJobViewValue | null>(null);

export function ReportJobViewProvider({ children }: { children: ReactNode }) {
  const [jobId, setJobId] = useState<number | null>(null);
  const value = useMemo(() => ({ jobId, setJobId }), [jobId]);
  return <ReportJobViewContext.Provider value={value}>{children}</ReportJobViewContext.Provider>;
}

export function useActiveReportJob(): ReportJobViewValue {
  const ctx = useContext(ReportJobViewContext);
  if (!ctx) throw new Error("useActiveReportJob must be used within ReportJobViewProvider");
  return ctx;
}
