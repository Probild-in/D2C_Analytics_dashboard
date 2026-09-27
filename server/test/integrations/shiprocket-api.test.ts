import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchOrdersPage, shiprocketLogin, ShiprocketAuthError } from "../../src/integrations/shiprocket-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("shiprocketLogin", () => {
  it("posts the credentials as JSON and returns the token", async () => {
    const fetchMock = stubFetch({ token: "abc123" });
    await expect(shiprocketLogin("ops@abc.com", "pw")).resolves.toBe("abc123");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/external/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "ops@abc.com", password: "pw" });
  });

  it.each([400, 401, 403, 422])("throws ShiprocketAuthError on HTTP %i", async (status) => {
    stubFetch({ message: "Invalid email or password" }, status);
    await expect(shiprocketLogin("ops@abc.com", "bad")).rejects.toBeInstanceOf(ShiprocketAuthError);
  });

  it("throws a plain error on a server failure", async () => {
    stubFetch({}, 500);
    const err = await shiprocketLogin("ops@abc.com", "pw").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ShiprocketAuthError);
  });

  it("throws when the response has no token", async () => {
    stubFetch({ hello: "world" });
    await expect(shiprocketLogin("ops@abc.com", "pw")).rejects.toThrow(/no token/);
  });
});

const ORDERS_FIXTURE = {
  data: [
    {
      id: 1001,
      channel_order_id: "1001",
      status: "DELIVERED",
      customer_state: "Maharashtra",
      created_at: "2026-09-20 10:00:00",
      shipments: [{ awb: "AWB1", courier: "Delhivery", status: "DELIVERED", delivered_date: "2026-09-24 12:00:00" }],
    },
    { id: 1002, channel_order_id: 1002, status: "NEW", customer_state: null, created_at: "2026-09-21 10:00:00", shipments: [] },
    {
      id: 1003,
      channel_order_id: "1003",
      status: "RTO INITIATED",
      created_at: "not a date",
      shipments: [{ awb_code: "AWB3", courier_name: "Bluedart" }, "junk"],
    },
  ],
  meta: { pagination: { total_pages: 3 } },
};

describe("fetchOrdersPage", () => {
  it("parses orders, shipments and pagination", async () => {
    stubFetch(ORDERS_FIXTURE);
    const page = await fetchOrdersPage("tok", 1, 100);

    expect(page.totalPages).toBe(3);
    expect(page.orders).toHaveLength(3);
    expect(page.orders[0]).toMatchObject({ orderRef: "1001", status: "DELIVERED", state: "Maharashtra" });
    expect(page.orders[0].createdAt).toBeInstanceOf(Date);
    expect(page.orders[0].shipments).toEqual([
      { awb: "AWB1", courier: "Delhivery", status: "DELIVERED", deliveredAt: expect.any(Date) },
    ]);
    expect(page.orders[1]).toMatchObject({ orderRef: "1002", state: null, shipments: [] });
    expect(page.orders[2].createdAt).toBeNull();
    expect(page.orders[2].shipments).toEqual([{ awb: "AWB3", courier: "Bluedart", status: null, deliveredAt: null }]);
  });

  it("sends the bearer token and paging params", async () => {
    const fetchMock = stubFetch({ data: [] });
    await fetchOrdersPage("tok-1", 2, 50);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/external/orders?");
    expect(new URL(url).searchParams.get("page")).toBe("2");
    expect(new URL(url).searchParams.get("per_page")).toBe("50");
    expect(new URL(url).searchParams.get("limit")).toBe("50");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });

  it("defaults to one page when pagination metadata is missing", async () => {
    stubFetch({ data: [] });
    expect((await fetchOrdersPage("tok", 1, 100)).totalPages).toBe(1);
  });

  it("throws on an unexpected response shape", async () => {
    stubFetch({ orders: [] });
    await expect(fetchOrdersPage("tok", 1, 100)).rejects.toThrow(/unexpected orders response/);
  });

  it("throws ShiprocketAuthError on 401 and a plain error on 500", async () => {
    stubFetch({}, 401);
    await expect(fetchOrdersPage("tok", 1, 100)).rejects.toBeInstanceOf(ShiprocketAuthError);
    stubFetch({}, 500);
    const err = await fetchOrdersPage("tok", 1, 100).catch((e) => e);
    expect(err).not.toBeInstanceOf(ShiprocketAuthError);
    expect(err.message).toContain("500");
  });
});
