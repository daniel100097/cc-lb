import { describe, expect, test } from "bun:test";
import { deriveStickyKey } from "./sticky-key";

describe("deriveStickyKey", () => {
  test("prefers explicit session header", () => {
    expect(deriveStickyKey(new Headers({ "x-cc-session-id": "abc" }), null)).toBe("sid:abc");
  });

  test("uses metadata user id", () => {
    expect(deriveStickyKey(new Headers(), { metadata: { user_id: "user-1" } })).toBe("uid:user-1");
  });

  test("hashes model, system prompt, and first user message", () => {
    const body = {
      model: "claude-sonnet",
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }],
    };
    const first = deriveStickyKey(new Headers(), body);
    const second = deriveStickyKey(new Headers(), body);
    expect(first).toBe(second);
    expect(first?.startsWith("hash:")).toBe(true);
  });

  test("returns null for non-message bodies", () => {
    expect(deriveStickyKey(new Headers(), { model: "x" })).toBeNull();
  });
});
