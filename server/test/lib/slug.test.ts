import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { slugify, pickLogoColor, generateUniqueClientId } from "../../src/lib/slug.js";

beforeEach(async () => {
  await resetTestDb();
});

describe("slugify", () => {
  it("lowercases, trims, and hyphenates", () => {
    expect(slugify("  ABC Fashion  ")).toBe("abc-fashion");
  });

  it("falls back to 'client' for a name with no alphanumeric characters", () => {
    expect(slugify("!!!")).toBe("client");
  });
});

describe("pickLogoColor", () => {
  it("is deterministic for the same seed", () => {
    expect(pickLogoColor("abc-fashion")).toBe(pickLogoColor("abc-fashion"));
  });
});

describe("generateUniqueClientId", () => {
  it("returns the plain slug when it's not taken", async () => {
    const id = await generateUniqueClientId(testPool, "ABC Fashion");
    expect(id).toBe("abc-fashion");
  });

  it("appends an incrementing suffix when the slug collides, including a second collision", async () => {
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A'),
       ('abc-fashion-2', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
    );
    const id = await generateUniqueClientId(testPool, "ABC Fashion");
    expect(id).toBe("abc-fashion-3");
  });
});
