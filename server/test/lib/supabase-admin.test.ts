import { describe, it, expect, vi, afterEach } from "vitest";
import { createSupabaseUser, deleteSupabaseUser, EmailAlreadyRegisteredError } from "../../src/lib/supabase-admin.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSupabaseUser", () => {
  it("creates a confirmed user and returns its id", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://test-project.supabase.co/auth/v1/admin/users");
        expect(init?.headers).toMatchObject({ apikey: "test-service-role-key", Authorization: "Bearer test-service-role-key" });
        const body = JSON.parse(init?.body as string);
        expect(body).toMatchObject({ email: "riya@newbrand.com", password: "a-real-password", email_confirm: true });
        return new Response(JSON.stringify({ id: "11111111-1111-1111-1111-111111111111" }), { status: 200 });
      }),
    );
    const result = await createSupabaseUser("riya@newbrand.com", "a-real-password");
    expect(result).toEqual({ id: "11111111-1111-1111-1111-111111111111" });
  });

  it("throws EmailAlreadyRegisteredError when Supabase reports a duplicate email", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ msg: "A user with this email address has already been registered" }), { status: 422 })),
    );
    await expect(createSupabaseUser("riya@newbrand.com", "a-real-password")).rejects.toThrow(EmailAlreadyRegisteredError);
  });

  it("throws a generic error for any other failure", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ msg: "internal error" }), { status: 500 })));
    await expect(createSupabaseUser("riya@newbrand.com", "a-real-password")).rejects.toThrow(/Supabase user creation failed/);
  });
});

describe("deleteSupabaseUser", () => {
  it("calls the admin delete endpoint", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://test-project.supabase.co/auth/v1/admin/users/11111111-1111-1111-1111-111111111111");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await deleteSupabaseUser("11111111-1111-1111-1111-111111111111");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not throw if the delete itself fails (would mask the original provisioning error)", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(deleteSupabaseUser("11111111-1111-1111-1111-111111111111")).resolves.toBeUndefined();
  });
});
