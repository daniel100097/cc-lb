import { describe, expect, test } from "bun:test";
import { cn } from "./utils";

describe("cn", () => {
  test("merges conditional classes and resolves Tailwind conflicts", () => {
    expect(cn("px-2", null, "px-4")).toBe("px-4");
  });
});
