import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { appliedMigrations, migrate, rollbackLast } from "./migrate.ts";
import { listCommits, saveCommit } from "./store.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

const ALL_MIGRATIONS = [
  "001_commits",
  "002_pull_requests",
  "003_deploy_events",
  "004_compare_cache",
  "005_collection_cursors",
  "006_incidents",
  "007_indexes",
  "008_collection_cursor_followed_until",
];

function emptyDatabase() {
  return new Database(":memory:");
}

/** 001 だけが適用済みの、古い DB を再現する。 */
function databaseAtFirstMigration() {
  const db = emptyDatabase();
  db.exec(readFileSync(join(MIGRATIONS_DIR, "001_commits.sql"), "utf8"));
  db.exec(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
    "001_commits",
    "2026-09-01T00:00:00Z",
  );
  return db;
}

describe("マイグレーション", () => {
  it("空の DB に適用すると、適用済みの一覧が記録される", () => {
    const db = emptyDatabase();

    migrate(db);

    expect(appliedMigrations(db)).toEqual(ALL_MIGRATIONS);
  });

  it("2 回適用しても壊れず、記録も増えない", () => {
    const db = emptyDatabase();

    migrate(db);
    migrate(db);

    expect(appliedMigrations(db)).toEqual(ALL_MIGRATIONS);
  });

  it("2 回目の適用で既存のデータが消えない", () => {
    const db = emptyDatabase();
    migrate(db);
    saveCommit(db, {
      scopeId: "four-keys-metrics-viewer",
      sha: "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07",
      committedAt: "2026-09-20T04:19:33Z",
      authoredAt: "2026-09-20T04:19:33Z",
      message: "適用前に入れたコミット",
      raw: {},
    });

    migrate(db);

    expect(listCommits(db, "four-keys-metrics-viewer")).toHaveLength(1);
  });

  it("古い DB は、未適用のマイグレーションだけを適用して追いつく", () => {
    const db = databaseAtFirstMigration();

    migrate(db);

    expect(appliedMigrations(db)).toEqual(ALL_MIGRATIONS);
  });

  it("追いつくときに、既にあるデータを壊さない", () => {
    const db = databaseAtFirstMigration();
    saveCommit(db, {
      scopeId: "four-keys-metrics-viewer",
      sha: "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07",
      committedAt: "2026-09-20T04:19:33Z",
      authoredAt: "2026-09-20T04:19:33Z",
      message: "古いスキーマの時点で入っていたコミット",
      raw: {},
    });

    migrate(db);

    expect(listCommits(db, "four-keys-metrics-viewer")).toHaveLength(1);
  });

  it("直近のマイグレーションを 1 つ取り消せる", () => {
    const db = emptyDatabase();
    migrate(db);

    rollbackLast(db);

    expect(appliedMigrations(db)).toEqual(ALL_MIGRATIONS.slice(0, -1));
  });

  it("取り消した後に再適用できる", () => {
    const db = emptyDatabase();
    migrate(db);
    rollbackLast(db);

    migrate(db);

    expect(appliedMigrations(db)).toEqual(ALL_MIGRATIONS);
  });

  it("すべて取り消すと、記録が空になる", () => {
    const db = emptyDatabase();
    migrate(db);

    for (let i = 0; i < ALL_MIGRATIONS.length; i += 1) {
      rollbackLast(db);
    }

    expect(appliedMigrations(db)).toEqual([]);
  });

  it("取り消すマイグレーションが無ければ何もしない", () => {
    const db = emptyDatabase();

    expect(() => rollbackLast(db)).not.toThrow();
    expect(appliedMigrations(db)).toEqual([]);
  });
});
