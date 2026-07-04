import { createHash, randomBytes, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { orm } from "./client";
import { apiKeys as apiKeysTable } from "./schema";

export type ApiKeyStatus = "active" | "inactive";
export type ApiKeyComputedStatus = ApiKeyStatus | "expired";

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  status: ApiKeyStatus;
  computed_status: ApiKeyComputedStatus;
  expires_at: number | null;
  allowed_models: string[] | null;
  traffic_class: string;
  account_scope_enabled: number;
  assigned_account_ids: string[];
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export interface NewApiKey {
  name: string;
  status?: ApiKeyStatus;
  expires_at?: number | null;
  allowed_models?: string[] | null;
  traffic_class?: string;
  account_scope_enabled?: number;
  assigned_account_ids?: string[];
}

export interface ApiKeyPatch {
  name?: string;
  status?: ApiKeyStatus;
  expires_at?: number | null;
  allowed_models?: string[] | null;
  traffic_class?: string;
  account_scope_enabled?: number;
  assigned_account_ids?: string[];
}

export interface ApiKeyWithPlaintext {
  apiKey: ApiKey;
  plaintextKey: string;
}

export interface ApiKeyValidationResult {
  ok: boolean;
  apiKey: ApiKey | null;
  reason: "valid" | "invalid" | "inactive" | "expired";
}

type ApiKeyRow = typeof apiKeysTable.$inferSelect;

export function listApiKeys(now = Date.now()): ApiKey[] {
  return orm
    .select()
    .from(apiKeysTable)
    .orderBy(desc(apiKeysTable.createdAt))
    .all()
    .map((row) => toApiKey(row, now));
}

export function getApiKey(id: string, now = Date.now()): ApiKey | null {
  const row = orm.select().from(apiKeysTable).where(eq(apiKeysTable.id, id)).get();
  return row ? toApiKey(row, now) : null;
}

export function createApiKey(input: NewApiKey, now = Date.now()): ApiKeyWithPlaintext {
  const generated = generateApiKeySecret();
  const inserted = orm
    .insert(apiKeysTable)
    .values({
      id: randomUUID(),
      name: input.name,
      prefix: generated.prefix,
      keyHash: hashApiKeySecret(generated.plaintextKey),
      status: input.status ?? "active",
      expiresAt: input.expires_at ?? null,
      allowedModels: encodeNullableStringArray(input.allowed_models ?? null),
      trafficClass: normalizeTrafficClass(input.traffic_class),
      accountScopeEnabled: input.account_scope_enabled ?? 0,
      assignedAccountIds: encodeStringArray(input.assigned_account_ids ?? []),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    })
    .returning()
    .get();

  if (!inserted) throw new Error("api key insert failed");
  return { apiKey: toApiKey(inserted, now), plaintextKey: generated.plaintextKey };
}

export function updateApiKey(id: string, patch: ApiKeyPatch, now = Date.now()): ApiKey | null {
  const values: ApiKeyUpdateValues = { updatedAt: now };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.expires_at !== undefined) values.expiresAt = patch.expires_at;
  if (patch.allowed_models !== undefined) values.allowedModels = encodeNullableStringArray(patch.allowed_models);
  if (patch.traffic_class !== undefined) values.trafficClass = normalizeTrafficClass(patch.traffic_class);
  if (patch.account_scope_enabled !== undefined) values.accountScopeEnabled = patch.account_scope_enabled;
  if (patch.assigned_account_ids !== undefined) {
    values.assignedAccountIds = encodeStringArray(patch.assigned_account_ids);
  }

  orm.update(apiKeysTable).set(values).where(eq(apiKeysTable.id, id)).run();
  return getApiKey(id, now);
}

export function deleteApiKey(id: string): void {
  orm.delete(apiKeysTable).where(eq(apiKeysTable.id, id)).run();
}

export function regenerateApiKey(id: string, now = Date.now()): ApiKeyWithPlaintext | null {
  const generated = generateApiKeySecret();
  orm
    .update(apiKeysTable)
    .set({
      prefix: generated.prefix,
      keyHash: hashApiKeySecret(generated.plaintextKey),
      updatedAt: now,
      lastUsedAt: null,
    })
    .where(eq(apiKeysTable.id, id))
    .run();
  const apiKey = getApiKey(id, now);
  return apiKey ? { apiKey, plaintextKey: generated.plaintextKey } : null;
}

export function validateApiKeySecret(secret: string | null, now = Date.now()): ApiKeyValidationResult {
  if (!secret) return { ok: false, apiKey: null, reason: "invalid" };
  const row = orm
    .select()
    .from(apiKeysTable)
    .where(eq(apiKeysTable.keyHash, hashApiKeySecret(secret)))
    .get();
  if (!row) return { ok: false, apiKey: null, reason: "invalid" };

  const apiKey = toApiKey(row, now);
  if (apiKey.status !== "active") return { ok: false, apiKey, reason: "inactive" };
  if (apiKey.expires_at !== null && apiKey.expires_at <= now) {
    return { ok: false, apiKey, reason: "expired" };
  }

  touchApiKeyLastUsed(apiKey.id, now);
  apiKey.last_used_at = now;
  return { ok: true, apiKey, reason: "valid" };
}

export function touchApiKeyLastUsed(id: string, now = Date.now()): void {
  orm.update(apiKeysTable).set({ lastUsedAt: now }).where(eq(apiKeysTable.id, id)).run();
}

export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function generateApiKeySecret(): { prefix: string; plaintextKey: string } {
  const prefix = `sk-cclb_${randomBytes(6).toString("base64url")}`;
  return {
    prefix,
    plaintextKey: `${prefix}_${randomBytes(32).toString("base64url")}`,
  };
}

function toApiKey(row: ApiKeyRow, now: number): ApiKey {
  const status = row.status === "inactive" ? "inactive" : "active";
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    status,
    computed_status: computedStatus(status, row.expiresAt, now),
    expires_at: row.expiresAt,
    allowed_models: decodeNullableStringArray(row.allowedModels),
    traffic_class: row.trafficClass,
    account_scope_enabled: row.accountScopeEnabled,
    assigned_account_ids: decodeStringArray(row.assignedAccountIds),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_used_at: row.lastUsedAt,
  };
}

function computedStatus(status: ApiKeyStatus, expiresAt: number | null, now: number): ApiKeyComputedStatus {
  if (status !== "active") return "inactive";
  if (expiresAt !== null && expiresAt <= now) return "expired";
  return "active";
}

function normalizeTrafficClass(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : "default";
}

function encodeNullableStringArray(value: string[] | null): string | null {
  return value === null ? null : encodeStringArray(value);
}

function encodeStringArray(value: string[]): string {
  return JSON.stringify(normalizeStringArray(value));
}

function decodeNullableStringArray(value: string | null): string[] | null {
  if (value === null) return null;
  return decodeStringArray(value);
}

function decodeStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? normalizeStringArray(parsed) : [];
  } catch {
    return [];
  }
}

function normalizeStringArray(value: unknown[]): string[] {
  return Array.from(
    new Set(value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))),
  );
}

interface ApiKeyUpdateValues {
  name?: string;
  status?: ApiKeyStatus;
  expiresAt?: number | null;
  allowedModels?: string | null;
  trafficClass?: string;
  accountScopeEnabled?: number;
  assignedAccountIds?: string;
  updatedAt: number;
}
