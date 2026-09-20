import { describe, expect, it } from "vitest";
import { describeBackfillProgress, planBackfillWindow } from "./window.ts";

const NOW = new Date("2026-09-20T06:00:00Z");

describe("次に取得する時間窓", () => {
  it("未着手のスコープは、現在時刻から分割日数だけ遡る窓を取る", () => {
    const plan = planBackfillWindow({
      cursor: undefined,
      backfillDays: 365,
      chunkDays: 30,
      now: NOW,
    });

    expect(plan).toEqual({
      kind: "window",
      window: { since: "2026-08-21T06:00:00.000Z", until: "2026-09-20T06:00:00.000Z" },
      reachesTarget: false,
    });
  });

  it("2 周目は前回の窓の古い端から続きを取る（重複も欠落もしない）", () => {
    const first = planBackfillWindow({
      cursor: undefined,
      backfillDays: 365,
      chunkDays: 30,
      now: NOW,
    });
    if (first.kind !== "window") {
      throw new Error("1 周目は窓が出るはず");
    }

    const second = planBackfillWindow({
      cursor: { backfilledUntil: first.window.since, backfillComplete: false },
      backfillDays: 365,
      chunkDays: 30,
      now: NOW,
    });

    expect(second).toMatchObject({
      kind: "window",
      window: { since: "2026-07-22T06:00:00.000Z", until: first.window.since },
    });
  });

  it("バックフィル範囲の端を越えて遡らない", () => {
    const plan = planBackfillWindow({
      // 目標（30 日前）まで残り 5 日の状態。
      cursor: { backfilledUntil: "2026-08-26T06:00:00Z", backfillComplete: false },
      backfillDays: 30,
      chunkDays: 30,
      now: NOW,
    });

    expect(plan).toEqual({
      kind: "window",
      window: { since: "2026-08-21T06:00:00.000Z", until: "2026-08-26T06:00:00Z" },
      reachesTarget: true,
    });
  });

  it("完了済みのスコープには窓を出さない（過去方向の取得を行わない）", () => {
    const plan = planBackfillWindow({
      cursor: { backfilledUntil: "2025-09-20T06:00:00Z", backfillComplete: true },
      backfillDays: 365,
      chunkDays: 30,
      now: NOW,
    });

    expect(plan).toEqual({ kind: "complete" });
  });

  it("バックフィル範囲を狭めると、完了フラグが無くても遡る先は残らない", () => {
    const plan = planBackfillWindow({
      cursor: { backfilledUntil: "2026-01-01T00:00:00Z", backfillComplete: false },
      backfillDays: 30,
      chunkDays: 30,
      now: NOW,
    });

    expect(plan).toEqual({ kind: "complete" });
  });

  it("バックフィル範囲を広げると、完了済みでも遡り直せる", () => {
    // 完了フラグは範囲に対する状態でしかない。範囲を広げたら立て直す必要がある。
    const plan = planBackfillWindow({
      cursor: { backfilledUntil: "2025-09-20T06:00:00Z", backfillComplete: false },
      backfillDays: 730,
      chunkDays: 30,
      now: NOW,
    });

    expect(plan).toMatchObject({ kind: "window" });
  });

  it("分割日数が 0 以下なら、遡れない窓を返さずに落ちる", () => {
    expect(() =>
      planBackfillWindow({ cursor: undefined, backfillDays: 365, chunkDays: 0, now: NOW }),
    ).toThrow(/正の数/);
  });

  it("カーソルの時刻が壊れていたら、黙って取り直さずに落ちる", () => {
    expect(() =>
      planBackfillWindow({
        cursor: { backfilledUntil: "きのう", backfillComplete: false },
        backfillDays: 365,
        now: NOW,
      }),
    ).toThrow(/backfilled_until/);
  });
});

describe("バックフィルの進捗", () => {
  it("未着手なら 0 日分", () => {
    const progress = describeBackfillProgress({
      cursor: undefined,
      backfillDays: 365,
      now: NOW,
    });

    expect(progress).toEqual({
      backfilledUntil: null,
      target: "2025-09-20T06:00:00.000Z",
      targetDays: 365,
      coveredDays: 0,
      complete: false,
    });
  });

  it("遡った日数を、目標日数とあわせて持つ（画面表示用）", () => {
    const progress = describeBackfillProgress({
      cursor: { backfilledUntil: "2026-08-21T06:00:00Z", backfillComplete: false },
      backfillDays: 365,
      now: NOW,
    });

    expect(progress.coveredDays).toBe(30);
    expect(progress.targetDays).toBe(365);
    expect(progress.complete).toBe(false);
  });

  it("完了済みなら、目標日数まで満たしたものとして扱う", () => {
    const progress = describeBackfillProgress({
      cursor: { backfilledUntil: "2025-09-19T00:00:00Z", backfillComplete: true },
      backfillDays: 365,
      now: NOW,
    });

    expect(progress.coveredDays).toBe(365);
    expect(progress.complete).toBe(true);
  });
});
