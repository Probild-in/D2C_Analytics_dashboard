import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useApp } from "@/store/app-context";

export function RequireAuth() {
  const { authReady, userEmail } = useApp();
  const location = useLocation();

  if (!authReady) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-border border-t-brand" />
      </div>
    );
  }

  if (!userEmail) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
