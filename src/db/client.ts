import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as tables from "./schema";

const DB_PATH = process.env.DB_PATH ?? "./data/cc-lb.db";

if (DB_PATH !== ":memory:") {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

export const db = new Database(DB_PATH, { create: true });
export const orm = drizzle(db, { schema: tables });

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_init",
    sql: `
      CREATE TABLE accounts (
        id                      TEXT PRIMARY KEY,
        name                    TEXT NOT NULL,
        auth_type               TEXT NOT NULL DEFAULT 'oauth_refresh',
        device_id_override      TEXT,
        access_token            TEXT,
        refresh_token           TEXT,
        expires_at              INTEGER,
        refresh_token_issued_at INTEGER,
        scopes                  TEXT,
        created_at              INTEGER NOT NULL,
        last_used               INTEGER,
        priority                INTEGER NOT NULL DEFAULT 0,
        request_count           INTEGER NOT NULL DEFAULT 0,
        session_start           INTEGER,
        session_request_count   INTEGER NOT NULL DEFAULT 0,
        rate_limit_status       TEXT,
        rate_limit_reset        INTEGER,
        rate_limit_remaining    INTEGER,
        rate_limited_until      INTEGER,
        consecutive_rate_limits INTEGER NOT NULL DEFAULT 0,
        needs_reauth            INTEGER NOT NULL DEFAULT 0,
        paused                  INTEGER NOT NULL DEFAULT 0,
        pause_reason            TEXT
      );

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE sticky_sessions (
        key        TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        status     TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE request_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT,
        ts         INTEGER NOT NULL,
        status     INTEGER,
        model      TEXT,
        outcome    TEXT
      );
      CREATE INDEX idx_request_log_ts ON request_log(ts);
      CREATE INDEX idx_request_log_account_ts ON request_log(account_id, ts);

      CREATE TABLE oauth_sessions (
        id         TEXT PRIMARY KEY,
        verifier   TEXT NOT NULL,
        state      TEXT NOT NULL,
        account_id TEXT,
        name       TEXT,
        priority   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_oauth_sessions_expires_at ON oauth_sessions(expires_at);
    `,
  },
  {
    id: "002_request_log_account_ts",
    sql: "CREATE INDEX IF NOT EXISTS idx_request_log_account_ts ON request_log(account_id, ts);",
  },
  {
    id: "003_oauth_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_sessions (
        id         TEXT PRIMARY KEY,
        verifier   TEXT NOT NULL,
        state      TEXT NOT NULL,
        account_id TEXT,
        name       TEXT,
        priority   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires_at ON oauth_sessions(expires_at);
    `,
  },
  {
    id: "004_request_log_details",
    sql: `
      ALTER TABLE request_log ADD COLUMN method TEXT;
      ALTER TABLE request_log ADD COLUMN path TEXT;
      ALTER TABLE request_log ADD COLUMN failover_attempt INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE request_log ADD COLUMN latency_ms INTEGER;
      ALTER TABLE request_log ADD COLUMN total_ms INTEGER;
      ALTER TABLE request_log ADD COLUMN error TEXT;
      ALTER TABLE request_log ADD COLUMN upstream_request_id TEXT;
      ALTER TABLE request_log ADD COLUMN input_tokens INTEGER;
      ALTER TABLE request_log ADD COLUMN output_tokens INTEGER;
      ALTER TABLE request_log ADD COLUMN cache_read_tokens INTEGER;
      ALTER TABLE request_log ADD COLUMN cache_creation_tokens INTEGER;
      ALTER TABLE request_log ADD COLUMN cost_usd REAL;
      CREATE INDEX IF NOT EXISTS idx_request_log_outcome_ts ON request_log(outcome, ts);
    `,
  },
  {
    id: "005_api_keys",
    sql: `
      CREATE TABLE IF NOT EXISTS api_keys (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        prefix                TEXT NOT NULL,
        key_hash              TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'active',
        expires_at            INTEGER,
        allowed_models        TEXT,
        traffic_class         TEXT NOT NULL DEFAULT 'default',
        account_scope_enabled INTEGER NOT NULL DEFAULT 0,
        assigned_account_ids  TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        last_used_at          INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
      CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);
    `,
  },
  {
    id: "006_request_log_raw_http",
    sql: `
      ALTER TABLE request_log ADD COLUMN raw_request_headers TEXT;
      ALTER TABLE request_log ADD COLUMN raw_request_body TEXT;
      ALTER TABLE request_log ADD COLUMN raw_response_headers TEXT;
      ALTER TABLE request_log ADD COLUMN raw_response_body TEXT;
    `,
  },
  {
    id: "007_request_log_raw_upstream_request",
    sql: `
      ALTER TABLE request_log ADD COLUMN raw_upstream_request_headers TEXT;
      ALTER TABLE request_log ADD COLUMN raw_upstream_request_body TEXT;
    `,
  },
];

function migrate() {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);");
  const applied = new Set(db.query<{ id: string }, []>("SELECT id FROM migrations").all().map((row) => row.id));
  const insert = db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)");
  const tx = db.transaction((migration: { id: string; sql: string }) => {
    db.exec(migration.sql);
    insert.run(migration.id, Date.now());
  });

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.id)) tx(migration);
  }
  ensureColumn("request_log", "api_key_id", "TEXT");
  ensureColumn("request_log", "raw_request_headers", "TEXT");
  ensureColumn("request_log", "raw_request_body", "TEXT");
  ensureColumn("request_log", "raw_upstream_request_headers", "TEXT");
  ensureColumn("request_log", "raw_upstream_request_body", "TEXT");
  ensureColumn("request_log", "raw_response_headers", "TEXT");
  ensureColumn("request_log", "raw_response_body", "TEXT");
  ensureColumn("accounts", "auth_type", "TEXT NOT NULL DEFAULT 'oauth_refresh'");
  ensureColumn("accounts", "device_id_override", "TEXT");
  ensureColumn("accounts", "usage_windows", "TEXT");
  ensureColumn("accounts", "usage_checked_at", "INTEGER");
  ensureColumn("accounts", "rate_limit_5h_utilization", "REAL");
  ensureColumn("accounts", "rate_limit_5h_reset", "INTEGER");
  ensureColumn("accounts", "rate_limit_7d_utilization", "REAL");
  ensureColumn("accounts", "rate_limit_7d_reset", "INTEGER");
  ensureColumn("sticky_sessions", "status", "TEXT NOT NULL DEFAULT 'active'");
  dropColumn("accounts", "access_token");
  dropColumn("accounts", "refresh_token");
  dropColumn("accounts", "expires_at");
  dropColumn("accounts", "refresh_token_issued_at");
  dropColumn("accounts", "scopes");
  db.exec("CREATE INDEX IF NOT EXISTS idx_request_log_api_key_ts ON request_log(api_key_id, ts);");
}

migrate();

function ensureColumn(table: string, column: string, definition: string): void {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function dropColumn(table: string, column: string): void {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column};`);
}
