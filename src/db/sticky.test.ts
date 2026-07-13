import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-sticky-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const { createAccount } = await import("./accounts");
const {
  blockFilteredStickySessions,
  blockStickySessions,
  claimSticky,
  getSticky,
  listStickySessions,
  touchSticky,
} = await import("./sticky");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

describe("sticky session repository", () => {
  test("keeps a chat on its first account without expiry", () => {
    const accountA = createAccount({ name: "Durable A" });
    const accountB = createAccount({ name: "Durable B" });
    const key = `sid:durable-${process.pid}`;

    expect(claimSticky(key, accountA.id, 1)).toEqual({ accountId: accountA.id, status: "active" });
    expect(getSticky(key)).toEqual({ accountId: accountA.id, status: "active" });
    expect(claimSticky(key, accountB.id, Number.MAX_SAFE_INTEGER)).toEqual({
      accountId: accountA.id,
      status: "active",
    });
    touchSticky(key, 20_000);
    expect(blockStickySessions([key], 21_000)).toBe(1);
    expect(blockStickySessions([key], 22_000)).toBe(0);
    touchSticky(key, 23_000);
    expect(claimSticky(key, accountB.id, 24_000)).toEqual({ accountId: accountA.id, status: "blocked" });

    const page = listStickySessions({ limit: 10, offset: 0, now: 25_000, search: key });
    expect(page.entries[0]).toMatchObject({
      key,
      account_id: accountA.id,
      updated_at: 21_000,
      status: "blocked",
    });
    expect(page.activeCount).toBe(0);
  });

  test("lists and blocks selected and filtered chat bindings without deleting tombstones", () => {
    const accountA = createAccount({ name: "Sticky A" });
    const accountB = createAccount({ name: "Sticky B" });
    const prefix = `sid:list-${process.pid}-`;

    claimSticky(`${prefix}a`, accountA.id, 1_000);
    claimSticky(`${prefix}b`, accountB.id, 2_000);

    const page = listStickySessions({
      limit: 10,
      offset: 0,
      now: 3_000,
      search: prefix,
      sortBy: "key",
      sortDirection: "asc",
    });
    expect(page.total).toBe(2);
    expect(page.activeCount).toBe(2);
    expect(page.entries.map((entry) => entry.key)).toEqual([`${prefix}a`, `${prefix}b`]);

    expect(blockStickySessions([`${prefix}a`], 3_000)).toBe(1);
    expect(blockFilteredStickySessions({ limit: 1, offset: 0, now: 4_000, accountId: accountB.id })).toBe(1);
    const blocked = listStickySessions({ limit: 10, offset: 0, now: 5_000, search: prefix });
    expect(blocked.total).toBe(2);
    expect(blocked.activeCount).toBe(0);
    expect(blocked.entries.every((entry) => entry.status === "blocked")).toBe(true);
  });
});
