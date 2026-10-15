import { supabase } from "@/lib/supabase";

export class ApiError extends Error {
  status: number | null;
  code: string | null;

  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// Authenticated call to the backend. Throws ApiError with a message that is safe to show
// to the user: the server's own error message when it sent one, otherwise a generic one.
// `status`/`code` carry the HTTP status and the server's error code (e.g. "rate_limited",
// "credentials_rejected") so callers can branch on them.
export async function apiFetch(path: string, init: Omit<RequestInit, "headers"> = {}): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new ApiError("You're not signed in. Please log in again.", 401, "unauthorized");
  }

  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = typeof body?.error?.message === "string" ? body.error.message : null;
    const code = typeof body?.error?.code === "string" ? body.error.code : null;
    throw new ApiError(message ?? `Request failed (${res.status}). Please try again.`, res.status, code);
  }
  return res;
}

// Live notification delivery. The browser's native EventSource can't send this app's
// Bearer-token Authorization header, so this reads the SSE response body manually via
// fetch + a stream reader instead, keeping the exact same auth mechanism as every other
// request. Returns an unsubscribe function that aborts the underlying request.
export function subscribeToNotificationStream(onMessage: (data: unknown) => void): () => void {
  const controller = new AbortController();

  (async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;

    let res: Response;
    try {
      res = await fetch(`${import.meta.env.VITE_API_URL}/api/notifications/stream`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal: controller.signal,
      });
    } catch {
      return; // connection failed or was aborted before it opened — nothing to clean up
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const line = event.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue; // heartbeat/comment lines have no "data: " prefix
        try {
          onMessage(JSON.parse(line.slice("data: ".length)));
        } catch {
          // malformed event — skip it rather than crash the whole stream
        }
      }
    }
  })();

  return () => controller.abort();
}

// Same error-handling shape as apiFetch, but for the public, pre-login pages (pricing,
// signup, contact-enterprise) — never attaches a session token, never requires one.
export async function publicApiFetch(path: string, init: Omit<RequestInit, "headers"> = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : {},
    });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = typeof body?.error?.message === "string" ? body.error.message : null;
    const code = typeof body?.error?.code === "string" ? body.error.code : null;
    throw new ApiError(message ?? `Request failed (${res.status}). Please try again.`, res.status, code);
  }
  return res;
}
