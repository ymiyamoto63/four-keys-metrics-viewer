/**
 * 再開可能な分割バックフィル（#12 / ADR-0007 決定 6）。
 *
 * 窓の決め方は `window.ts`（純粋関数）、何を取得するかは呼び出し元（#11）が渡す。
 * ここの責務は 1 つだけ——**取り終えた窓の分だけカーソルを進める**ことである。
 *
 * ## 例外は握り潰さずに投げる
 *
 * レート制限（`GitHubRateLimitError`）も権限エラーも、ここでは分類せずそのまま投げる。
 * スコープ単位の失敗分離と収集サイクルの中断は `per-scope.ts` の担当であり、
 * ここで捕まえると「1 スコープの失敗」と「credential 全体の失敗」の区別が消える。
 *
 * 投げる前に**取り終えた窓までのカーソルは確定している**ため、中断した分は
 * 次の収集サイクルが同じ窓から拾い直す。取得が途中まで進んでいた窓は丸ごと取り直しになるが、
 * 保存は upsert（`store.ts`）なので行は重複しない。
 */

import type { Db } from "../db/index.ts";
import { findCollectionCursor, recordBackfillProgress } from "../db/store.ts";
import { logger } from "../logger.ts";
import type { Scope } from "../scopes.ts";
import {
  type BackfillProgress,
  type CollectionWindow,
  DEFAULT_BACKFILL_CHUNK_DAYS,
  describeBackfillProgress,
  planBackfillWindow,
} from "./window.ts";

/**
 * 時間窓 1 つ分の取得と保存。
 *
 * 「過去に遡る収集」と「最新を追う収集」で同じ形にしてある（#11 と共通化）。
 * 解決した時点で、その窓の保存が終わっている必要がある。
 */
export type WindowCollection = (window: CollectionWindow) => Promise<void>;

export type BackfillOptions = {
  now?: Date;
  chunkDays?: number;
};

export type BackfillResult = {
  /** この呼び出しで取り終えた窓。新しい順。すでに完了していた場合は空。 */
  windows: CollectionWindow[];
  /** 画面（#20）に出す進捗。正常に返った時点では必ず完了している。 */
  progress: BackfillProgress;
};

/**
 * バックフィルを、範囲の端に届くか例外が出るまで窓単位で進める。
 *
 * 1 周回で 1 窓に留めないのは、常時稼働しない構成では周回そのものが滅多に来ないため
 * （ADR-0007 決定 3）。「次の 1 時間後」を待つと 1 年分に 12 時間の稼働が必要になる。
 * 分割の意味は 1 周回の量を抑えることではなく、**中断の粒度を窓に揃えること**にある。
 */
export async function runBackfill(
  db: Db,
  scope: Pick<Scope, "id" | "backfillDays">,
  collect: WindowCollection,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const windows: CollectionWindow[] = [];
  // 窓は必ず過去方向へ進むため本来は不要だが、計画側の不具合で無限ループに落ちないよう上限を置く。
  const limit =
    Math.ceil(scope.backfillDays / (options.chunkDays ?? DEFAULT_BACKFILL_CHUNK_DAYS)) + 1;

  for (let attempt = 0; attempt <= limit; attempt += 1) {
    const cursor = findCollectionCursor(db, scope.id);
    const plan = planBackfillWindow({
      cursor,
      backfillDays: scope.backfillDays,
      chunkDays: options.chunkDays,
      now: options.now,
    });

    if (plan.kind === "complete") {
      if (cursor !== undefined && !cursor.backfillComplete) {
        // バックフィル範囲が狭められた場合など、1 窓も取らずに完了に届くことがある。
        recordBackfillProgress(db, scope.id, cursor.backfilledUntil, true);
        logger.info("バックフィルはすでに範囲の端に届いている", {
          scopeId: scope.id,
          backfilledUntil: cursor.backfilledUntil,
        });
      }
      return result(db, scope, windows, options.now);
    }

    await collect(plan.window);
    // カーソルを進めるのは取得と保存が終わったあと。ここより手前で中断すれば同じ窓から再開する。
    recordBackfillProgress(db, scope.id, plan.window.since, plan.reachesTarget);
    windows.push(plan.window);
    logger.info("バックフィルの窓を取り終えた", {
      scopeId: scope.id,
      since: plan.window.since,
      until: plan.window.until,
      reachesTarget: plan.reachesTarget,
    });

    if (plan.reachesTarget) {
      return result(db, scope, windows, options.now);
    }
  }

  throw new Error(
    `バックフィルの窓が ${limit} 回でも範囲の端に届きませんでした（scope=${scope.id}）`,
  );
}

function result(
  db: Db,
  scope: Pick<Scope, "id" | "backfillDays">,
  windows: CollectionWindow[],
  now: Date | undefined,
): BackfillResult {
  return {
    windows,
    progress: describeBackfillProgress({
      cursor: findCollectionCursor(db, scope.id),
      backfillDays: scope.backfillDays,
      now,
    }),
  };
}
