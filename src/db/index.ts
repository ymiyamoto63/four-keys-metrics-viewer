import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { logger } from "../logger.ts";
import { appliedMigrations, migrate } from "./migrate.ts";

export type Db = Database.Database;

/**
 * SQLite を開き、未適用のマイグレーションを適用して返す。
 */
export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  // 収集ジョブの書き込みと画面の読み取りが同時に走るため WAL にする。
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // 収集ジョブと HTTP リクエストが同一プロセス内で競合したときに即座に諦めない。
  db.pragma("busy_timeout = 5000");

  migrate(db);

  logger.info("SQLite を開いた", {
    path,
    journalMode: db.pragma("journal_mode", { simple: true }),
    migrations: appliedMigrations(db).length,
  });
  return db;
}
