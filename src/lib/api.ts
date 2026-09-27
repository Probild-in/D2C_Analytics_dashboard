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
