import * as React from "react";
import type { Client } from "@/data/types";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";

type Theme = "light" | "dark";
export type DateRangeKey = "today" | "yesterday" | "7d" | "30d" | "mtd" | "ytd" | "custom";

interface AppContextValue {
  clientId: string;
  setClientId: (id: string) => void;
  client: Client | null;
  clients: Client[];
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
  const [session, setSession] = React.useState<Session | null>(null);
  const [clients, setClients] = React.useState<Client[]>([]);
  const [clientId, setClientId] = React.useState<string>(clients[0]?.id ?? "");
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

  React.useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => setSession(newSession));
    return () => sub.subscription.unsubscribe();
  }, []);

  React.useEffect(() => {
    if (!session) return;
    fetch(`${import.meta.env.VITE_API_URL}/api/clients`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then(setClients);
  }, [session]);

  React.useEffect(() => {
    if (clients.length > 0 && !clientId) {
      setClientId(clients[0].id);
    }
  }, [clients, clientId]);

  const value: AppContextValue = {
    clientId,
    setClientId,
    client: clients.find((c) => c.id === clientId) ?? null,
    clients,
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
