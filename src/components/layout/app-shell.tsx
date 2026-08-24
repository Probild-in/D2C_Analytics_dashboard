import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell() {
  return (
    <div className="flex min-h-dvh bg-bg">
      <Sidebar />
      <div className="flex h-dvh min-w-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}

export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <Topbar title={title} description={description} />
      <main className="flex-1 px-4 py-5 lg:px-6 lg:py-6">
        {actions && <div className="mb-4 flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div>}
        {children}
      </main>
    </>
  );
}
