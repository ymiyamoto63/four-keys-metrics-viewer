import { describe, expect, it } from "vitest";
import { collectionStatusOf } from "./collection-status.ts";
import { testScope } from "./testing.ts";

/**
 * 収集状態は #20 の必須要件（ADR-0007）。ここでは「何時間前か」「どこまで遡ったか」の
 * 算術だけを固定する。表示側の文言は `app.test.tsx`。
 */

const NOW = new Date("2026-09-17T09:00:00Z");
const SCOPE = testScope({ backfillDays: 100 });

describe("collectionStatusOf", () => {
  it("カーソルが無ければ「まだ一度も収集していない」と言い切る", () => {
    const status = collectionStatusOf(undefined, SCOPE, NOW);

    expect(status.neverCollected).toBe(true);
    expect(status.lastSuccessAt).toBeNull();
    expect(status.staleHours).toBeNull();
    expect(status.backfill.percent).toBe(0);
    expect(status.backfill.remainingDays).toBe(100);
  });

  it("最終収集成功からの経過時間を時間単位で出す", () => {
    const status = collectionStatusOf(
      {
        scopeId: SCOPE.id,
        backfilledUntil: null,
        backfillComplete: false,
        followedUntil: null,
        lastSuccessAt: "2026-09-15T09:00:00Z",
        lastError: null,
      },
      SCOPE,
      NOW,
    );

    expect(status.staleHours).toBe(48);
    expect(status.neverCollected).toBe(false);
  });

  it("バックフィルの進捗を割合と残り日数にする", () => {
    // 目標 100 日 = 2026-06-09。40 日ぶん遡った状態。
    const status = collectionStatusOf(
      {
        scopeId: SCOPE.id,
        backfilledUntil: "2026-08-08T09:00:00Z",
        backfillComplete: false,
        followedUntil: null,
        lastSuccessAt: "2026-09-17T08:00:00Z",
        lastError: null,
      },
      SCOPE,
      NOW,
    );

    expect(status.backfill.percent).toBe(40);
    expect(status.backfill.remainingDays).toBe(60);
    expect(status.backfill.complete).toBe(false);
  });

  it("完了していれば 100% と言い切る", () => {
    const status = collectionStatusOf(
      {
        scopeId: SCOPE.id,
        backfilledUntil: "2026-06-09T09:00:00Z",
        backfillComplete: true,
        followedUntil: null,
        lastSuccessAt: "2026-09-17T08:00:00Z",
        lastError: null,
      },
      SCOPE,
      NOW,
    );

    expect(status.backfill.percent).toBe(100);
    expect(status.backfill.remainingDays).toBe(0);
  });

  it("目標より古くまで遡っていても 100% を超えない", () => {
    const status = collectionStatusOf(
      {
        scopeId: SCOPE.id,
        backfilledUntil: "2020-01-01T00:00:00Z",
        backfillComplete: false,
        followedUntil: null,
        lastSuccessAt: "2026-09-17T08:00:00Z",
        lastError: null,
      },
      SCOPE,
      NOW,
    );

    expect(status.backfill.percent).toBe(100);
    expect(status.backfill.remainingDays).toBe(0);
  });
});
