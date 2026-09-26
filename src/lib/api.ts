import { supabase } from "@/lib/supabase";

export class ApiError extends Error {}

// Authenticated call to the backend. Throws ApiError with a message that is safe to show
// to the user: the server's own error message when it sent one, otherwise a generic one.
export async function apiFetch(path: string, init: Omit<RequestInit, "headers"> = {}): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new ApiError("You're not signed in. Please log in again.");
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
    throw new ApiError(body?.error?.message ?? `Request failed (${res.status}). Please try again.`);
  }
  return res;
}
