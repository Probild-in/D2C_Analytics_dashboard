import * as React from "react";
import { CLIENTS, DEFAULT_CLIENT_ID } from "@/data/mock";

type Theme = "light" | "dark";
export type DateRangeKey = "today" | "yesterday" | "7d" | "30d" | "mtd" | "ytd" | "custom";

interface AppContextValue {
  clientId: string;
  setClientId: (id: string) => void;
  client: (typeof CLIENTS)[number] | null;
  isAllClients: boolean;
  theme: Theme;
  toggleTheme: () => void;
  dateRange: DateRangeKey;
  setDateRange: (r: DateRangeKey) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;
}

const AppContext = React.createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [clientId, setClientId] = React.useState<string>(DEFAULT_CLIENT_ID);
  const [theme, setTheme] = React.useState<Theme>(() => {
    if (typeof window === "undefined") return "light";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [dateRange, setDateRange] = React.useState<DateRangeKey>("30d");
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const value: AppContextValue = {
    clientId,
    setClientId,
    client: CLIENTS.find((c) => c.id === clientId) ?? null,
    isAllClients: clientId === "all",
    theme,
    toggleTheme: () => setTheme((t) => (t === "light" ? "dark" : "light")),
    dateRange,
    setDateRange,
    sidebarCollapsed,
    setSidebarCollapsed,
    mobileNavOpen,
    setMobileNavOpen,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

export const DATE_RANGE_LABELS: Record<DateRangeKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  mtd: "Month to Date",
  ytd: "Year to Date",
  custom: "Custom Range",
};
