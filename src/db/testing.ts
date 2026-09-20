import Database from "better-sqlite3";
import type { Db } from "./index.ts";
import { migrate } from "./migrate.ts";

/** テスト用のインメモリ DB。マイグレーション適用済みで返す。 */
export function openTestDatabase(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
