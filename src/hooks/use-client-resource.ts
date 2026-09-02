import * as React from "react";
import { supabase } from "@/lib/supabase";

// Generalizes app-context.tsx's own session-aware fetch effect (which calls
// `supabase.auth.getSession()` the same way) so every page in this plan doesn't repeat
// the same fetch/loading-state boilerplate. `path` is the full request path (e.g.
// "/api/clients/abc-fashion/orders?limit=40"); pass null to skip fetching (e.g. while the
// client id isn't known yet).
export function useClientResource<T>(path: string | null, fallback: T): { data: T; loading: boolean } {
  const [data, setData] = React.useState<T>(fallback);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!path) {
      setData(fallback);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      if (!session) {
        setData(fallback);
        setLoading(false);
        return;
      }

      fetch(`${import.meta.env.VITE_API_URL}${path}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
        .then((r) => {
          if (!r.ok) throw new Error(`Failed to fetch ${path}: ${r.status}`);
          return r.json();
        })
        .then((json) => {
          if (!cancelled) setData(json);
        })
        .catch((err) => {
          console.error(err);
          if (!cancelled) setData(fallback);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return { data, loading };
}
