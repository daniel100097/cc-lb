import { describe, expect, test } from "bun:test";
import { deriveStickyKey } from "./sticky-key";

describe("deriveStickyKey", () => {
  test("uses the official Claude Code session header", () => {
    expect(deriveStickyKey(new Headers({ "x-claude-code-session-id": "claude-session" }))).toBe(
      "sid:claude-session",
    );
  });

  test("rejects aliases, metadata identities, missing values, and blank values", () => {
    expect(deriveStickyKey(new Headers({ "x-cc-session-id": "alias" }))).toBeNull();
    expect(deriveStickyKey(new Headers())).toBeNull();
    expect(deriveStickyKey(new Headers({ "x-claude-code-session-id": "  " }))).toBeNull();
  });
});
