import { describe, expect, it } from "vitest";
import {
  findCollectionCursor,
  listCommits,
  recordCollectionSuccess,
  saveCommit,
} from "../db/store.ts";
import { openTestDatabase } from "../db/testing.ts";
import { GitHubRateLimitError } from "../github/client.ts";
import { runBackfill } from "./backfill.ts";
import type { CollectionWindow } from "./window.ts";

const NOW = new Date("2026-09-20T06:00:00Z");
const SCOPE = { id: "sample-app", backfillDays: 90 };

/** 窓ごとに 1 コミットを保存する収集。窓の取得が実際に保存まで進むことを再現する。 */
function savingCollection(db: ReturnType<typeof openTestDatabase>, windows: CollectionWindow[]) {
  return async (window: CollectionWindow): Promise<void> => {
    windows.push(window);
    saveCommit(db, {
      scopeId: SCOPE.id,
      sha: `sha-${window.since}`,
      committedAt: window.since,
      authoredAt: window.since,
      message: `${window.since} 〜 ${window.until} の窓で取得したコミット`,
      raw: {},
    });
  };
}

describe("分割バックフィル", () => {
  it("バックフィル範囲の端まで、窓を分けて隙間なく遡る", async () => {
    const db = openTestDatabase();
    const windows: CollectionWindow[] = [];

    const result = await runBackfill(db, SCOPE, savingCollection(db, windows), {
      now: NOW,
      chunkDays: 30,
    });

    expect(windows.map((window) => [window.since, window.until])).toEqual([
      ["2026-08-21T06:00:00.000Z", "2026-09-20T06:00:00.000Z"],
      ["2026-07-22T06:00:00.000Z", "2026-08-21T06:00:00.000Z"],
      ["2026-06-22T06:00:00.000Z", "2026-07-22T06:00:00.000Z"],
    ]);
    expect(result.progress.complete).toBe(true);
    expect(result.progress.coveredDays).toBe(90);
    expect(findCollectionCursor(db, SCOPE.id)).toMatchObject({
      backfilledUntil: "2026-06-22T06:00:00.000Z",
      backfillComplete: true,
    });
  });

  it("完了後は過去方向の取得を一切行わない", async () => {
    const db = openTestDatabase();
    await runBackfill(db, SCOPE, savingCollection(db, []), { now: NOW, chunkDays: 30 });

    const windows: CollectionWindow[] = [];
    const result = await runBackfill(db, SCOPE, savingCollection(db, windows), {
      now: NOW,
      chunkDays: 30,
    });

    expect(windows).toEqual([]);
    expect(result.progress.complete).toBe(true);
  });

  it("取得に失敗した窓の分はカーソルを進めず、同じ窓から再開する", async () => {
    const db = openTestDatabase();
    const firstRun: CollectionWindow[] = [];
    const save = savingCollection(db, firstRun);

    // 2 窓目の途中でレート制限に当たる（保存まで進んだあとに落ちる、最悪のタイミング）。
    await expect(
      runBackfill(
        db,
        SCOPE,
        async (window) => {
          await save(window);
          if (firstRun.length === 2) {
            throw new GitHubRateLimitError(
              "https://api.github.com/repos/o/sample-app/commits",
              "2026-09-20T07:00:00Z",
              null,
            );
          }
        },
        { now: NOW, chunkDays: 30 },
      ),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);

    // 取り終えた 1 窓目までは確定し、落ちた 2 窓目は未確定のまま。
    expect(findCollectionCursor(db, SCOPE.id)).toMatchObject({
      backfilledUntil: "2026-08-21T06:00:00.000Z",
      backfillComplete: false,
    });

    const secondRun: CollectionWindow[] = [];
    const result = await runBackfill(db, SCOPE, savingCollection(db, secondRun), {
      now: NOW,
      chunkDays: 30,
    });

    // 再開は落ちた窓から。範囲は 2 回の実行を通して連続している（欠落なし）。
    expect(secondRun[0]?.until).toBe("2026-08-21T06:00:00.000Z");
    expect(result.progress.complete).toBe(true);
    const covered = [...firstRun, ...secondRun].map((window) => [window.since, window.until]);
    expect(covered).toEqual([
      ["2026-08-21T06:00:00.000Z", "2026-09-20T06:00:00.000Z"],
      ["2026-07-22T06:00:00.000Z", "2026-08-21T06:00:00.000Z"],
      ["2026-07-22T06:00:00.000Z", "2026-08-21T06:00:00.000Z"],
      ["2026-06-22T06:00:00.000Z", "2026-07-22T06:00:00.000Z"],
    ]);
    // 取り直した窓の保存は upsert なので、行は重複していない（重複なし）。
    expect(listCommits(db, SCOPE.id)).toHaveLength(3);
  });

  it("バックフィル範囲を狭めたら、1 窓も取らずに完了にする", async () => {
    const db = openTestDatabase();
    await runBackfill(db, SCOPE, savingCollection(db, []), { now: NOW, chunkDays: 30 });

    const windows: CollectionWindow[] = [];
    const result = await runBackfill(
      db,
      { id: SCOPE.id, backfillDays: 30 },
      savingCollection(db, windows),
      { now: NOW, chunkDays: 30 },
    );

    expect(windows).toEqual([]);
    expect(result.progress.complete).toBe(true);
  });

  it("最終収集成功時刻と直前の失敗には触らない", async () => {
    const db = openTestDatabase();
    recordCollectionSuccess(db, SCOPE.id, "2026-09-19T05:00:00Z");

    await runBackfill(db, SCOPE, savingCollection(db, []), { now: NOW, chunkDays: 30 });

    // 「どこまで遡ったか」と「いつ収集に成功したか」は別々に進む。
    expect(findCollectionCursor(db, SCOPE.id)).toMatchObject({
      lastSuccessAt: "2026-09-19T05:00:00Z",
      lastError: null,
      backfillComplete: true,
    });
  });
});
