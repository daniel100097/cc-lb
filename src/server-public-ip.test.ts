import { beforeEach, describe, expect, test } from "bun:test";
import { resetServerPublicIpCacheForTests, resolveServerPublicIp } from "./server-public-ip";

beforeEach(() => resetServerPublicIpCacheForTests());

describe("server public IP resolution", () => {
  test("extracts and briefly caches a validated public IP", async () => {
    let calls = 0;
    let now = 1_000;
    const fetchIp = async () => {
      calls += 1;
      return new Response(`fl=test\nip=203.0.113.${41 + calls}\nloc=ZZ\n`);
    };
    const clock = () => now;

    expect(await resolveServerPublicIp(fetchIp, clock)).toBe("203.0.113.42");
    now += 29_999;
    expect(await resolveServerPublicIp(fetchIp, clock)).toBe("203.0.113.42");
    expect(calls).toBe(1);

    now += 2;
    expect(await resolveServerPublicIp(fetchIp, clock)).toBe("203.0.113.43");
    expect(calls).toBe(2);
  });

  test("accepts IPv6 and rejects invalid, missing, or failed responses", async () => {
    expect(await resolveServerPublicIp(async () => new Response("ip=2001:db8::8\n"))).toBe("2001:db8::8");

    resetServerPublicIpCacheForTests();
    expect(await resolveServerPublicIp(async () => new Response("ip=not-an-ip\n"))).toBeNull();

    resetServerPublicIpCacheForTests();
    expect(await resolveServerPublicIp(async () => new Response("loc=ZZ\n"))).toBeNull();

    resetServerPublicIpCacheForTests();
    expect(await resolveServerPublicIp(async () => new Response("no", { status: 503 }))).toBeNull();

    resetServerPublicIpCacheForTests();
    expect(
      await resolveServerPublicIp(async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });

  test("briefly backs off after resolution failures", async () => {
    let calls = 0;
    let now = 1_000;
    const unavailable = async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    };
    const clock = () => now;

    expect(await resolveServerPublicIp(unavailable, clock)).toBeNull();
    expect(await resolveServerPublicIp(unavailable, clock)).toBeNull();
    expect(calls).toBe(1);

    now += 5_001;
    expect(await resolveServerPublicIp(unavailable, clock)).toBeNull();
    expect(calls).toBe(2);
  });
});
