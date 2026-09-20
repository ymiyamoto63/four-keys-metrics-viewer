/**
 * 収集状態の表示モデル（#20）。
 *
 * ## なぜ画面の必須要素なのか
 *
 * 収集状態の表示は「親切な付加情報」ではなく **指標の正しさの一部**である。理由は 2 つ。
 *
 * 1. ADR-0004 で「データ不足の週は値を出さない」と決めたため、**収集が壊れている期間と、
 *    本当にデプロイが無かった期間が画面上では同じ空白に見える**（#20）。
 * 2. ADR-0007 でアプリは常時稼働しなくなり、**データが古いことが通常状態**になった。
 *    最終収集成功時刻を出さないと、利用者は古いデータを現在の状態として読む。
 *
 * 加えて、PAT の期限切れで収集が静かに止まった場合、これが唯一の検知手段である
 * （`docs/operations.md` / #24 の運用手順がこの表示に依存している）。
 *
 * ここは `collection_cursors` の 1 行を「画面が言えること」へ翻訳するだけの純粋関数に保つ。
 * DB も時計も触らない（`now` は引数で受け取る）ので、経過時間や進捗率をそのままテストできる。
 */

import type { CollectionCursor } from "../db/store.ts";
import type { Scope } from "../scopes.ts";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** バックフィル進捗（ADR-0007 決定 6 / 引き継ぎ決定「バックフィル進捗を常時表示する」）。 */
export type BackfillProgress = {
  /** バックフィルの目標下端（`now - backfillDays`）。ISO8601。 */
  targetFrom: string;
  /** どこまで過去へ遡ったか。`null` は未着手。 */
  backfilledUntil: string | null;
  /** 目標下端まで遡り終えたか。 */
  complete: boolean;
  /** 遡り済みの割合（0〜100 の整数）。未着手は 0、完了は 100。 */
  percent: number;
  /** 目標下端まで残っている日数。完了なら 0。 */
  remainingDays: number;
  /** 設定上のバックフィル範囲（日数）。 */
  targetDays: number;
};

/** 画面に常時出す収集状態。 */
export type CollectionStatus = {
  scopeId: string;
  /**
   * 最終収集成功時刻。`null` は**一度も収集サイクルが成功していない**。
   * 「収集済み範囲の新しい端」でもある（`metrics/coverage.ts`）。
   */
  lastSuccessAt: string | null;
  /** 最終収集成功からの経過時間（時間・切り捨て）。`lastSuccessAt` が無ければ `null`。 */
  staleHours: number | null;
  /** 直前の収集失敗。`null` なら直近の収集は失敗していない。 */
  lastError: string | null;
  /** 収集カーソルの行自体が無い＝このスコープはまだ 1 度も収集を試していない。 */
  neverCollected: boolean;
  backfill: BackfillProgress;
};

/**
 * 収集カーソルを表示モデルへ翻訳する。
 *
 * カーソルが無い場合も**「不明」ではなく「まだ収集していない」と言い切れる形**で返す。
 * ここを `undefined` のまま画面へ渡すと、表示が「出す／出さない」の分岐になり、
 * 「収集状態は常時表示」（ADR-0007）が分岐の片側で簡単に消える。
 */
export function collectionStatusOf(
  cursor: CollectionCursor | undefined,
  scope: Scope,
  now: Date,
): CollectionStatus {
  const nowMs = now.getTime();
  const targetFromMs = nowMs - scope.backfillDays * MS_PER_DAY;
  const lastSuccessAt = cursor?.lastSuccessAt ?? null;

  return {
    scopeId: scope.id,
    lastSuccessAt,
    staleHours:
      lastSuccessAt === null
        ? null
        : Math.max(0, Math.floor((nowMs - Date.parse(lastSuccessAt)) / MS_PER_HOUR)),
    lastError: cursor?.lastError ?? null,
    neverCollected: cursor === undefined,
    backfill: backfillProgressOf(cursor, scope, nowMs, targetFromMs),
  };
}

function backfillProgressOf(
  cursor: CollectionCursor | undefined,
  scope: Scope,
  nowMs: number,
  targetFromMs: number,
): BackfillProgress {
  const targetFrom = new Date(targetFromMs).toISOString();
  const backfilledUntil = cursor?.backfilledUntil ?? null;
  const complete = cursor?.backfillComplete ?? false;

  if (complete) {
    return {
      targetFrom,
      backfilledUntil,
      complete: true,
      percent: 100,
      remainingDays: 0,
      targetDays: scope.backfillDays,
    };
  }
  if (backfilledUntil === null) {
    return {
      targetFrom,
      backfilledUntil: null,
      complete: false,
      percent: 0,
      remainingDays: scope.backfillDays,
      targetDays: scope.backfillDays,
    };
  }

  const untilMs = Date.parse(backfilledUntil);
  const spanMs = nowMs - targetFromMs;
  // 遡った量 / 目標範囲。設定を縮めた直後などに 100% を超えうるので丸め込む。
  const coveredMs = Math.min(Math.max(nowMs - untilMs, 0), spanMs);
  return {
    targetFrom,
    backfilledUntil,
    complete: false,
    percent: spanMs <= 0 ? 100 : Math.round((coveredMs / spanMs) * 100),
    remainingDays: Math.max(0, Math.ceil((untilMs - targetFromMs) / MS_PER_DAY)),
    targetDays: scope.backfillDays,
  };
}
