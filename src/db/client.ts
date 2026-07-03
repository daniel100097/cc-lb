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
        updated_at INTEGER NOT NULL
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
}

migrate();
