import { beforeEach, describe, expect, test } from "bun:test";
import { resetServerPublicIpCacheForTests, resolveEgressPublicIp } from "./server-public-ip";

beforeEach(() => resetServerPublicIpCacheForTests());

describe("egress public IP resolution", () => {
  test("extracts and briefly caches a validated public IP", async () => {
    let calls = 0;
    let now = 1_000;
    const fetchIp = async () => {
      calls += 1;
      return new Response(`fl=test\nip=203.0.113.${41 + calls}\nloc=ZZ\n`);
    };
    const clock = () => now;

    expect(await resolveEgressPublicIp(null, fetchIp, clock)).toBe("203.0.113.42");
    now += 29_999;
    expect(await resolveEgressPublicIp(null, fetchIp, clock)).toBe("203.0.113.42");
    expect(calls).toBe(1);

    now += 2;
    expect(await resolveEgressPublicIp(null, fetchIp, clock)).toBe("203.0.113.43");
    expect(calls).toBe(2);
  });

  test("accepts IPv6 and rejects invalid, missing, or failed responses", async () => {
    expect(await resolveEgressPublicIp(null, async () => new Response("ip=2001:db8::8\n"))).toBe("2001:db8::8");

    resetServerPublicIpCacheForTests();
    expect(await resolveEgressPublicIp(null, async () => new Response("ip=not-an-ip\n"))).toBeNull();

    resetServerPublicIpCacheForTests();
    expect(await resolveEgressPublicIp(null, async () => new Response("loc=ZZ\n"))).toBeNull();

    resetServerPublicIpCacheForTests();
    expect(await resolveEgressPublicIp(null, async () => new Response("no", { status: 503 }))).toBeNull();

    resetServerPublicIpCacheForTests();
    expect(
      await resolveEgressPublicIp(null, async () => {
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

    expect(await resolveEgressPublicIp(null, unavailable, clock)).toBeNull();
    expect(await resolveEgressPublicIp(null, unavailable, clock)).toBeNull();
    expect(calls).toBe(1);

    now += 5_001;
    expect(await resolveEgressPublicIp(null, unavailable, clock)).toBeNull();
    expect(calls).toBe(2);
  });

  test("caches, backs off, and forwards the proxy per egress path", async () => {
    const proxies: Array<string | undefined> = [];
    const now = 1_000;
    const clock = () => now;
    const fetchIp = async (_input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
      const proxy = init?.proxy;
      proxies.push(proxy);
      if (proxy === "http://127.0.0.1:8889/") return new Response("unavailable", { status: 503 });
      return new Response(`ip=${proxy ? "198.51.100.7" : "203.0.113.5"}\n`);
    };

    expect(await resolveEgressPublicIp(null, fetchIp, clock)).toBe("203.0.113.5");
    expect(await resolveEgressPublicIp("http://127.0.0.1:8888/", fetchIp, clock)).toBe("198.51.100.7");
    // One failing proxy must not poison the other paths' cached values.
    expect(await resolveEgressPublicIp("http://127.0.0.1:8889/", fetchIp, clock)).toBeNull();
    expect(await resolveEgressPublicIp(null, fetchIp, clock)).toBe("203.0.113.5");
    expect(await resolveEgressPublicIp("http://127.0.0.1:8888/", fetchIp, clock)).toBe("198.51.100.7");

    expect(proxies).toEqual([undefined, "http://127.0.0.1:8888/", "http://127.0.0.1:8889/"]);
  });
});
