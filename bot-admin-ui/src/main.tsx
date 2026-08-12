import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ConfirmProvider } from "./contexts/ConfirmContext";
import { AuthProvider } from "./hooks/useAuth";
import { UiPreferencesProvider } from "./hooks/useUiPreferences";
import { applyTheme } from "./lib/utils";
import "./styles.css";

applyTheme();

const routerBasename = (() => {
  const base = import.meta.env.BASE_URL || "/";
  if (base === "/") return undefined;
  return base.replace(/\/+$/, "") || undefined;
})();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={routerBasename}>
        <AuthProvider>
          <UiPreferencesProvider>
            <ConfirmProvider>
              <App />
            </ConfirmProvider>
          </UiPreferencesProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
