import { describe, expect, it } from "vitest";
import { findCollectionCursor, recordFollowProgress } from "../db/store.ts";
import { openTestDatabase } from "../db/testing.ts";
import { GitHubRateLimitError } from "../github/client.ts";
import { planFollowWindow, runFollow } from "./follow.ts";
import type { CollectionWindow } from "./window.ts";

const NOW = new Date("2026-09-20T06:00:00Z");
const SCOPE = { id: "sample-app" };

function recording(windows: CollectionWindow[]) {
  return async (window: CollectionWindow): Promise<void> => {
    windows.push(window);
  };
}

describe("最新を追う収集の窓決め", () => {
  it("初回は窓を作らない（最新側はバックフィルの最初の窓が覆うため）", () => {
    expect(planFollowWindow({ cursor: undefined, now: NOW })).toEqual({ kind: "caught-up" });
    expect(planFollowWindow({ cursor: { followedUntil: null }, now: NOW })).toEqual({
      kind: "caught-up",
    });
  });

  it("前回の到達点から重ね取り分だけ遡って現在時刻までを取る", () => {
    const plan = planFollowWindow({
      cursor: { followedUntil: "2026-09-20T05:00:00Z" },
      now: NOW,
      overlapDays: 7,
      chunkDays: 30,
    });

    expect(plan).toEqual({
      kind: "window",
      window: { since: "2026-09-13T05:00:00.000Z", until: "2026-09-20T06:00:00.000Z" },
      reachesNow: true,
    });
  });

  it("遅れが分割日数を超えると、1 窓では現在時刻に届かない", () => {
    const plan = planFollowWindow({
      cursor: { followedUntil: "2026-06-20T06:00:00Z" },
      now: NOW,
      overlapDays: 0,
      chunkDays: 30,
    });

    expect(plan).toEqual({
      kind: "window",
      window: { since: "2026-06-20T06:00:00.000Z", until: "2026-07-20T06:00:00.000Z" },
      reachesNow: false,
    });
  });

  it("重ね取りが 1 窓分以上あると同じ範囲を取り直し続けるため、設定を拒否する", () => {
    expect(() =>
      planFollowWindow({
        cursor: { followedUntil: "2026-09-20T05:00:00Z" },
        now: NOW,
        overlapDays: 30,
        chunkDays: 30,
      }),
    ).toThrow(/重ね取り日数/);
  });

  it("カーソルの時刻が壊れていたら、黙って未着手に落とさず落ちる", () => {
    expect(() => planFollowWindow({ cursor: { followedUntil: "昨日" }, now: NOW })).toThrow(
      /followed_until/,
    );
  });
});

describe("最新を追う収集", () => {
  it("初回は取りに行かず、追いつき起点だけを置く", async () => {
    const db = openTestDatabase();
    const windows: CollectionWindow[] = [];

    const result = await runFollow(db, SCOPE, recording(windows), { now: NOW });

    expect(windows).toEqual([]);
    expect(result.followedUntil).toBe(NOW.toISOString());
    expect(findCollectionCursor(db, SCOPE.id)?.followedUntil).toBe(NOW.toISOString());
  });

  it("30 日分の遅れがあっても、窓を分けて現在時刻まで追いつく", async () => {
    const db = openTestDatabase();
    recordFollowProgress(db, SCOPE.id, "2026-08-21T06:00:00Z");
    const windows: CollectionWindow[] = [];

    await runFollow(db, SCOPE, recording(windows), {
      now: NOW,
      chunkDays: 10,
      overlapDays: 0,
    });

    expect(windows.map((window) => [window.since, window.until])).toEqual([
      ["2026-08-21T06:00:00.000Z", "2026-08-31T06:00:00.000Z"],
      ["2026-08-31T06:00:00.000Z", "2026-09-10T06:00:00.000Z"],
      ["2026-09-10T06:00:00.000Z", "2026-09-20T06:00:00.000Z"],
    ]);
    expect(findCollectionCursor(db, SCOPE.id)?.followedUntil).toBe("2026-09-20T06:00:00.000Z");
  });

  it("中断した窓の分はカーソルを進めず、次回は同じ窓から再開する", async () => {
    const db = openTestDatabase();
    recordFollowProgress(db, SCOPE.id, "2026-08-21T06:00:00Z");
    const first: CollectionWindow[] = [];

    await expect(
      runFollow(
        db,
        SCOPE,
        async (window) => {
          first.push(window);
          if (first.length === 2) {
            throw new GitHubRateLimitError("https://api.github.com/x", null, null);
          }
        },
        { now: NOW, chunkDays: 10, overlapDays: 0 },
      ),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);

    // 1 窓目までは確定している。
    expect(findCollectionCursor(db, SCOPE.id)?.followedUntil).toBe("2026-08-31T06:00:00.000Z");

    const second: CollectionWindow[] = [];
    await runFollow(db, SCOPE, recording(second), { now: NOW, chunkDays: 10, overlapDays: 0 });

    expect(second.map((window) => window.since)).toEqual([
      "2026-08-31T06:00:00.000Z",
      "2026-09-10T06:00:00.000Z",
    ]);
    expect(findCollectionCursor(db, SCOPE.id)?.followedUntil).toBe("2026-09-20T06:00:00.000Z");
  });

  it("追いつき済みでも、重ね取り分だけは取り直す（後から現れる出来事を拾うため）", async () => {
    const db = openTestDatabase();
    recordFollowProgress(db, SCOPE.id, NOW.toISOString());
    const windows: CollectionWindow[] = [];

    await runFollow(db, SCOPE, recording(windows), { now: NOW, chunkDays: 30, overlapDays: 7 });

    expect(windows).toEqual([
      { since: "2026-09-13T06:00:00.000Z", until: "2026-09-20T06:00:00.000Z" },
    ]);
  });

  it("重ね取りは最初の窓にだけ効き、2 窓目以降は直前の窓の続きから取る", async () => {
    // ここで毎回重ねると 1 窓あたりの前進が縮み、長い追いつきほど同じ範囲を取り直す。
    const db = openTestDatabase();
    recordFollowProgress(db, SCOPE.id, "2026-08-21T06:00:00Z");
    const windows: CollectionWindow[] = [];

    await runFollow(db, SCOPE, recording(windows), { now: NOW, chunkDays: 10, overlapDays: 7 });

    expect(windows.map((window) => [window.since, window.until])).toEqual([
      ["2026-08-14T06:00:00.000Z", "2026-08-24T06:00:00.000Z"],
      ["2026-08-24T06:00:00.000Z", "2026-09-03T06:00:00.000Z"],
      ["2026-09-03T06:00:00.000Z", "2026-09-13T06:00:00.000Z"],
      ["2026-09-13T06:00:00.000Z", "2026-09-20T06:00:00.000Z"],
    ]);
  });

  it("重ね取りを 0 にすると、追いつき済みのスコープは 1 度も取りに行かない", async () => {
    const db = openTestDatabase();
    recordFollowProgress(db, SCOPE.id, NOW.toISOString());
    const windows: CollectionWindow[] = [];

    await runFollow(db, SCOPE, recording(windows), { now: NOW, overlapDays: 0 });

    expect(windows).toEqual([]);
  });
});
