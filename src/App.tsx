import { Suspense, lazy } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import { AppProvider } from "@/store/app-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/app-shell";
import { RequireAuth } from "@/components/layout/require-auth";

const Dashboard = lazy(() => import("@/pages/dashboard"));
const AllClients = lazy(() => import("@/pages/all-clients"));
const Sales = lazy(() => import("@/pages/sales"));
const Operations = lazy(() => import("@/pages/operations"));
const Products = lazy(() => import("@/pages/products"));
const Geography = lazy(() => import("@/pages/geography"));
const MetaAds = lazy(() => import("@/pages/meta-ads"));
const GoogleAds = lazy(() => import("@/pages/google-ads"));
const BlendedMarketing = lazy(() => import("@/pages/blended-marketing"));
const Tasks = lazy(() => import("@/pages/tasks"));
const ManageClients = lazy(() => import("@/pages/manage-clients"));
const Login = lazy(() => import("@/pages/login"));

function RouteFallback() {
  return (
    <div className="flex h-[60vh] items-center justify-center">
      <div className="size-6 animate-spin rounded-full border-2 border-border border-t-brand" />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <TooltipProvider delayDuration={150}>
        <HashRouter>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route element={<RequireAuth />}>
                <Route element={<AppShell />}>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/clients" element={<AllClients />} />
                  <Route path="/sales" element={<Sales />} />
                  <Route path="/operations" element={<Operations />} />
                  <Route path="/products" element={<Products />} />
                  <Route path="/geography" element={<Geography />} />
                  <Route path="/marketing/meta" element={<MetaAds />} />
                  <Route path="/marketing/google" element={<GoogleAds />} />
                  <Route path="/marketing/blended" element={<BlendedMarketing />} />
                  <Route path="/tasks" element={<Tasks />} />
                  <Route path="/manage-clients" element={<ManageClients />} />
                </Route>
              </Route>
            </Routes>
          </Suspense>
        </HashRouter>
      </TooltipProvider>
    </AppProvider>
  );
}
