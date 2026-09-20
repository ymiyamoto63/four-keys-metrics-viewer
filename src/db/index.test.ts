import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./index.ts";
import { listCommits, saveCommit } from "./store.ts";

const dirs: string[] = [];

function temporaryDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "fkv-"));
  dirs.push(dir);
  return join(dir, "nested", "four-keys.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("DB を開く", () => {
  it("開いた直後からコミットを保存できる", () => {
    const db = openDatabase(temporaryDatabasePath());

    saveCommit(db, {
      scopeId: "four-keys-metrics-viewer",
      sha: "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07",
      committedAt: "2026-09-20T04:19:33Z",
      authoredAt: "2026-09-20T04:19:33Z",
      message: "起動直後に保存できる",
      raw: {},
    });

    expect(listCommits(db, "four-keys-metrics-viewer")).toHaveLength(1);
  });

  it("開き直しても保存済みのデータが残る", () => {
    const path = temporaryDatabasePath();
    const first = openDatabase(path);
    saveCommit(first, {
      scopeId: "four-keys-metrics-viewer",
      sha: "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07",
      committedAt: "2026-09-20T04:19:33Z",
      authoredAt: "2026-09-20T04:19:33Z",
      message: "再起動をまたぐ",
      raw: {},
    });
    first.close();

    const second = openDatabase(path);

    expect(listCommits(second, "four-keys-metrics-viewer")[0]?.message).toBe("再起動をまたぐ");
  });
});
