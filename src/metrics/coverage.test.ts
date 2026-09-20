import { describe, expect, it } from "vitest";
import { classifyWeekCoverage, collectedRange } from "./coverage.ts";
import type { CollectionCoverage } from "./types.ts";
import { weekOf } from "./week.ts";

/** 2026-09-14 週（JST 月曜 00:00 = 2026-09-13T15:00:00Z 〜 2026-09-20T15:00:00Z）。 */
const WEEK = weekOf("2026-09-15T02:00:00Z");

function coverage(overrides: Partial<CollectionCoverage> = {}): CollectionCoverage {
  return {
    backfilledUntil: "2026-08-01T00:00:00Z",
    backfillComplete: true,
    lastSuccessAt: "2026-09-25T00:00:00Z",
    ...overrides,
  };
}

describe("収集済み範囲", () => {
  it("遡った端と追いついた端で挟む", () => {
    expect(collectedRange(coverage())).toEqual({
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-25T00:00:00Z",
    });
  });

  it("バックフィル未着手なら範囲は無い", () => {
    expect(collectedRange(coverage({ backfilledUntil: null }))).toBeNull();
  });

  it("最新を追う収集が一度も成功していなければ範囲は無い", () => {
    // 直近側がどこまで埋まっているか分からない。分からない側はカバーしていないに倒す
    // （架空の 0 を本物の 0 として見せないため）。
    expect(collectedRange(coverage({ lastSuccessAt: null }))).toBeNull();
  });
});

describe("週のカバレッジ", () => {
  it("週の全体が収集済みなら covered（0 件は本物の 0）", () => {
    expect(classifyWeekCoverage(coverage(), WEEK)).toBe("covered");
  });

  it("週の端にちょうど揃っていても covered", () => {
    expect(
      classifyWeekCoverage(
        coverage({
          backfilledUntil: WEEK.startedAt,
          lastSuccessAt: WEEK.endedAt,
        }),
        WEEK,
      ),
    ).toBe("covered");
  });

  it("収集がその週に一切届いていなければ uncovered（データなし）", () => {
    expect(
      classifyWeekCoverage(
        coverage({
          backfilledUntil: "2026-09-21T00:00:00Z",
          lastSuccessAt: "2026-09-28T00:00:00Z",
        }),
        WEEK,
      ),
    ).toBe("uncovered");
  });

  it("週より新しい範囲しか収集していなくても uncovered", () => {
    expect(
      classifyWeekCoverage(
        coverage({ backfilledUntil: "2026-07-01T00:00:00Z", lastSuccessAt: WEEK.startedAt }),
        WEEK,
      ),
    ).toBe("uncovered");
  });

  it("バックフィルが週の途中までしか遡れていなければ partial", () => {
    expect(classifyWeekCoverage(coverage({ backfilledUntil: "2026-09-16T00:00:00Z" }), WEEK)).toBe(
      "partial",
    );
  });

  it("進行中の今週（最終成功が週の途中）は partial", () => {
    // 常時稼働しない構成（ADR-0007）では、直近が欠けているのが通常の状態である。
    expect(classifyWeekCoverage(coverage({ lastSuccessAt: "2026-09-17T00:00:00Z" }), WEEK)).toBe(
      "partial",
    );
  });

  it("バックフィル完了フラグはカバー範囲を広げない", () => {
    // 完了は「その範囲まで遡り終えた」であって「それより前も収集済み」ではない。
    expect(
      classifyWeekCoverage(
        coverage({ backfilledUntil: "2026-09-21T00:00:00Z", backfillComplete: true }),
        WEEK,
      ),
    ).toBe("uncovered");
  });

  it("収集カーソルが空なら、どの週も uncovered", () => {
    expect(
      classifyWeekCoverage(
        { backfilledUntil: null, backfillComplete: false, lastSuccessAt: null },
        WEEK,
      ),
    ).toBe("uncovered");
  });

  it("カーソルの時刻が壊れていたら落ちる", () => {
    expect(() => classifyWeekCoverage(coverage({ backfilledUntil: "きのう" }), WEEK)).toThrow(
      /backfilled_until/,
    );
  });
});
