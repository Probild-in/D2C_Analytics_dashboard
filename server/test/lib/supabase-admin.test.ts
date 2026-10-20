import { describe, it, expect, vi, afterEach } from "vitest";
import { createSupabaseUser, deleteSupabaseUser, EmailAlreadyRegisteredError, generateMagicLink } from "../../src/lib/supabase-admin.js";

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

  it("throws a generic Error (not EmailAlreadyRegisteredError) for an unrelated 422 such as a weak password", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error_code: "weak_password", msg: "Password should be at least 8 characters" }), { status: 422 })),
    );
    const err = await createSupabaseUser("riya@newbrand.com", "short").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EmailAlreadyRegisteredError);
    expect((err as Error).message).toMatch(/Supabase user creation failed: 422 .*weak_password/);
  });

  it("recognizes GoTrue's email_exists error_code as a duplicate email", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 422, error_code: "email_exists", msg: "Email address already exists" }), { status: 422 })),
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

describe("createSupabaseUser without a password", () => {
  it("omits the password field entirely when none is given", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    let capturedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ id: "11111111-1111-1111-1111-111111111111" }), { status: 200 });
      }),
    );
    const result = await createSupabaseUser("riya@newbrand.com");
    expect(result).toEqual({ id: "11111111-1111-1111-1111-111111111111" });
    expect(capturedBody).not.toHaveProperty("password");
    expect(capturedBody).toMatchObject({ email: "riya@newbrand.com", email_confirm: true });
  });
});

describe("generateMagicLink", () => {
  it("requests a magiclink and returns the action link", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://test-project.supabase.co/auth/v1/admin/generate_link");
        const body = JSON.parse(init?.body as string);
        expect(body).toMatchObject({ type: "magiclink", email: "riya@newbrand.com" });
        return new Response(JSON.stringify({ properties: { action_link: "https://test-project.supabase.co/auth/v1/verify?token=abc" } }), { status: 200 });
      }),
    );
    const result = await generateMagicLink("riya@newbrand.com");
    expect(result).toEqual({ actionLink: "https://test-project.supabase.co/auth/v1/verify?token=abc" });
  });

  it("throws a clear error on a non-2xx response", async () => {
    process.env.SUPABASE_URL = "https://test-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 500 })));
    await expect(generateMagicLink("riya@newbrand.com")).rejects.toThrow(/Failed to generate magic link/);
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
