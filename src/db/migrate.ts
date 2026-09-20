import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./index.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql"))
    .map((name) => name.replace(/\.sql$/, ""))
    .sort();
}

function ensureLedger(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
  )`);
}

/** 適用済みマイグレーションの名前を、適用された順に返す。 */
export function appliedMigrations(db: Db): string[] {
  ensureLedger(db);
  const rows = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as {
    name: string;
  }[];
  return rows.map((row) => row.name);
}

/** 未適用のマイグレーションだけを名前順に適用する。 */
export function migrate(db: Db): void {
  ensureLedger(db);
  const applied = new Set(appliedMigrations(db));

  for (const name of migrationNames()) {
    if (applied.has(name)) {
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf8");
    // 1 マイグレーションは全適用されるか、全く適用されないかのどちらかにする。
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        name,
        new Date().toISOString(),
      );
    })();
  }
}

/**
 * 直近に適用したマイグレーションを 1 つ取り消す。適用済みが無ければ何もしない。
 *
 * **生イベントを落とす操作である。** テーブルを DROP するため、取り消した分のデータは戻らない
 * （バックフィルで再取得はできるが、既定 1 年より古い分は戻らない）。手順は
 * `docs/db-migrations.md` を参照。
 */
export function rollbackLast(db: Db): void {
  const applied = appliedMigrations(db);
  const last = applied.at(-1);
  if (last === undefined) {
    return;
  }

  const sql = readFileSync(join(MIGRATIONS_DIR, `${last}.down.sql`), "utf8");
  db.transaction(() => {
    db.exec(sql);
    db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(last);
  })();
}
