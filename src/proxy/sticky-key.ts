import { createHash } from "node:crypto";

/**
 * Derive a stable sticky key for a request so a Claude Code conversation stays
 * on one account (warm prompt cache, shared 5h window). Simplified codex-lb idea.
 * Returns null if we can't derive one (non-messages request).
 */
export function deriveStickyKey(headers: Headers, body: unknown): string | null {
  const explicit = headers.get("x-cc-session-id");
  if (explicit) return `sid:${explicit}`;

  if (!isRecord(body)) return null;

  const metadata = isRecord(body.metadata) ? body.metadata : null;
  if (typeof metadata?.user_id === "string" && metadata.user_id.length > 0) {
    return `uid:${metadata.user_id}`;
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) return null;

  const systemText = systemToText(body.system);
  const firstUser = messages.find((message) => isRecord(message) && message.role === "user");
  const firstUserText = isRecord(firstUser) ? contentToText(firstUser.content) : "";
  const model = typeof body.model === "string" ? body.model : "";
  const basis = `${model}\0${systemText}\0${firstUserText}`;
  return `hash:${createHash("sha256").update(basis).digest("hex").slice(0, 24)}`;
}

function systemToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => (isRecord(block) && "text" in block ? String(block.text) : ""))
      .join("");
  }
  return "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && "text" in block ? String(block.text) : ""))
      .join("");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
