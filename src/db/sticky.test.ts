import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-sticky-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const { db, enforceStrictChatSessionRows } = await import("./client");
const { createAccount, deleteAccount } = await import("./accounts");
const {
  bindStickyClientDeviceId,
  blockFilteredStickySessions,
  blockStickySessions,
  claimPendingSticky,
  claimSticky,
  getSticky,
  getStickyIdentity,
  listStickySessions,
  promotePendingSticky,
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
    expect(blocked.pendingCount).toBe(0);
    expect(blocked.entries.every((entry) => entry.status === "blocked")).toBe(true);
  });

  test("keeps pending bindings durable and atomically promotes them", () => {
    const accountA = createAccount({ name: "Pending A" });
    const accountB = createAccount({ name: "Pending B" });
    const key = `sid:pending-${process.pid}`;

    expect(claimPendingSticky(key, accountA.id, 1_000, "client-device-a")).toEqual({
      accountId: accountA.id,
      status: "pending",
      clientDeviceId: "client-device-a",
    });
    expect(claimPendingSticky(key, accountB.id, Number.MAX_SAFE_INTEGER, "client-device-b")).toEqual({
      accountId: accountA.id,
      status: "pending",
      clientDeviceId: "client-device-a",
    });

    touchSticky(key, 2_000);
    const pendingPage = listStickySessions({ limit: 10, offset: 0, now: 2_000, search: key });
    expect(pendingPage.activeCount).toBe(0);
    expect(pendingPage.pendingCount).toBe(1);
    expect(pendingPage.entries[0]?.updated_at).toBe(2_000);

    expect(promotePendingSticky(key, 3_000)).toEqual({
      accountId: accountA.id,
      status: "active",
      clientDeviceId: "client-device-a",
    });
    expect(promotePendingSticky(key, 4_000)?.status).toBe("active");
    expect(getSticky(key)).toEqual({ accountId: accountA.id, status: "active" });
  });

  test("binds a client device ID once and exposes the winning identity", () => {
    const account = createAccount({ name: "Device binding" });
    const key = `sid:device-${process.pid}`;
    claimPendingSticky(key, account.id, 1_000);

    expect(getStickyIdentity(key)?.clientDeviceId).toBeNull();
    expect(bindStickyClientDeviceId(key, "first-device")?.clientDeviceId).toBe("first-device");
    expect(bindStickyClientDeviceId(key, "first-device")?.clientDeviceId).toBe("first-device");
    expect(bindStickyClientDeviceId(key, "conflicting-device")?.clientDeviceId).toBe("first-device");
    expect(() => bindStickyClientDeviceId(key, "")).toThrow("client device ID must not be empty");
  });

  test("operator blocking applies to pending bindings", () => {
    const account = createAccount({ name: "Blocked pending" });
    const selectedKey = `sid:pending-selected-${process.pid}`;
    const filteredKey = `sid:pending-filtered-${process.pid}`;
    claimPendingSticky(selectedKey, account.id, 1_000);
    claimPendingSticky(filteredKey, account.id, 1_000);

    expect(blockStickySessions([selectedKey], 2_000)).toBe(1);
    expect(
      blockFilteredStickySessions({ limit: 10, offset: 0, now: 3_000, search: filteredKey }),
    ).toBe(1);
    expect(getSticky(selectedKey)?.status).toBe("blocked");
    expect(getSticky(filteredKey)?.status).toBe("blocked");
    expect(bindStickyClientDeviceId(selectedKey, "late-device")).toMatchObject({
      status: "blocked",
      clientDeviceId: null,
    });
  });

  test("account deletion blocks existing and concurrent chat claims", () => {
    const deleted = createAccount({ name: "Deleted sticky owner" });
    const other = createAccount({ name: "Other sticky owner" });
    const existingKey = `sid:deleted-existing-${process.pid}`;
    const pendingKey = `sid:deleted-pending-${process.pid}`;
    const racingKey = `sid:deleted-racing-${process.pid}`;

    expect(claimSticky(existingKey, deleted.id, 1_000).status).toBe("active");
    expect(claimPendingSticky(pendingKey, deleted.id, 1_500).status).toBe("pending");
    expect(deleteAccount(deleted.id, 2_000)).toBe(2);
    expect(getSticky(existingKey)).toEqual({ accountId: deleted.id, status: "blocked" });
    expect(getSticky(pendingKey)).toEqual({ accountId: deleted.id, status: "blocked" });
    expect(claimSticky(existingKey, other.id, 3_000)).toEqual({ accountId: deleted.id, status: "blocked" });
    expect(claimSticky(racingKey, deleted.id, 4_000)).toEqual({ accountId: deleted.id, status: "blocked" });
  });

  test("strict cleanup removes legacy keys and blocks orphaned chat bindings", () => {
    const owner = createAccount({ name: "Strict cleanup owner" });
    const suffix = `${process.pid}-${Date.now()}`;
    const validKey = `sid:strict-valid-${suffix}`;
    const pendingKey = `sid:strict-pending-${suffix}`;
    const orphanKey = `sid:strict-orphan-${suffix}`;
    const orphanPendingKey = `sid:strict-orphan-pending-${suffix}`;
    const invalidStatusKey = `sid:strict-invalid-status-${suffix}`;
    const uppercaseKey = `SID:strict-uppercase-${suffix}`;
    const heuristicKey = `uid:strict-heuristic-${suffix}`;
    const insert = db.query(
      "INSERT INTO sticky_sessions (key, account_id, updated_at, status) VALUES (?, ?, ?, ?)",
    );
    insert.run(validKey, owner.id, 1_000, "active");
    insert.run(pendingKey, owner.id, 2_000, "pending");
    insert.run(orphanKey, "missing-account", 3_000, "active");
    insert.run(orphanPendingKey, "missing-account", 4_000, "pending");
    insert.run(invalidStatusKey, owner.id, 5_000, "unknown");
    insert.run(uppercaseKey, owner.id, 6_000, "active");
    insert.run(heuristicKey, owner.id, 7_000, "active");

    enforceStrictChatSessionRows();

    expect(getSticky(validKey)).toEqual({ accountId: owner.id, status: "active" });
    expect(getSticky(pendingKey)).toEqual({ accountId: owner.id, status: "pending" });
    expect(getSticky(orphanKey)).toEqual({ accountId: "missing-account", status: "blocked" });
    expect(getSticky(orphanPendingKey)).toEqual({ accountId: "missing-account", status: "blocked" });
    expect(getSticky(invalidStatusKey)).toEqual({ accountId: owner.id, status: "blocked" });
    expect(getSticky(uppercaseKey)).toBeNull();
    expect(getSticky(heuristicKey)).toBeNull();
  });
});
