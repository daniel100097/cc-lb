import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-sticky-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const { createAccount } = await import("./accounts");
const {
  deleteFilteredStickySessions,
  deleteStickySessions,
  listStickySessions,
  purgeStaleStickySessions,
  setSticky,
} = await import("./sticky");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

describe("sticky session repository", () => {
  test("lists stale prompt-cache sessions and deletes selected, filtered, and stale rows", () => {
    const accountA = createAccount({ name: "Sticky A" });
    const accountB = createAccount({ name: "Sticky B" });
    const now = 10_000;
    const ttlMs = 1_000;

    const prefix = `sticky-${process.pid}-`;
    setSticky(`${prefix}fresh-a`, accountA.id, now - 500);
    setSticky(`${prefix}stale-a`, accountA.id, now - 1_500);
    setSticky(`${prefix}fresh-b`, accountB.id, now - 100);

    const page = listStickySessions({
      limit: 10,
      offset: 0,
      ttlMs,
      now,
      search: prefix,
      sortBy: "key",
      sortDirection: "asc",
    });
    expect(page.total).toBe(3);
    expect(page.stalePromptCacheCount).toBe(1);
    expect(page.entries.find((entry) => entry.key === `${prefix}stale-a`)).toMatchObject({
      kind: "prompt_cache",
      account_name: "Sticky A",
      stale: true,
    });

    expect(deleteStickySessions([`${prefix}fresh-a`])).toBe(1);
    const filtered = listStickySessions({
      limit: 10,
      offset: 0,
      ttlMs,
      now,
      accountId: accountB.id,
      search: prefix,
    });
    expect(filtered.total).toBe(1);
    expect(deleteFilteredStickySessions({ limit: 1, offset: 0, ttlMs, now, accountId: accountB.id })).toBe(1);
    expect(purgeStaleStickySessions(ttlMs, now)).toBe(1);

    const empty = listStickySessions({ limit: 10, offset: 0, ttlMs, now });
    expect(empty.total).toBe(0);
  });
});
