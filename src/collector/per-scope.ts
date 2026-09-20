import type { Db } from "../db/index.ts";
import { recordCollectionFailure, recordCollectionSuccess } from "../db/store.ts";
import { GitHubRateLimitError } from "../github/client.ts";
import { logger } from "../logger.ts";

/**
 * スコープ単位の失敗分離（#10 / ADR-0006）。
 *
 * 収集は複数スコープをまとめて回すが、**1 スコープの失敗を他スコープに波及させない**。
 * private リポジトリを対象にする以上、PAT の対象リポジトリ選択漏れや権限設定ミスは
 * 403 / 404 として現れる。これで収集サイクル全体が止まると、
 * 設定が正しい他スコープの指標まで黙って古くなる。
 *
 * ただし**レート制限だけは例外**として全体を止める。レート制限は credential 単位で効くため、
 * 残りのスコープを試しても 403 を積むだけで、GitHub への無駄な負荷にしかならない。
 * 待機はしない（`client.ts` 冒頭のコメント参照）。中断した分は次の収集サイクルが拾う。
 *
 * 呼び出し元は収集ジョブ（#11）。スコープ一覧は設定ファイル（#9）から来る。
 */

/** 1 スコープ分の収集。失敗は例外で表す。 */
export type ScopeCollection = (scopeId: string) => Promise<void>;

export type PerScopeOutcome = {
  succeeded: string[];
  failed: string[];
  /** レート制限で中断したため、着手しなかったスコープ。 */
  skipped: string[];
  rateLimited: boolean;
};

export async function collectPerScope(
  db: Db,
  scopeIds: string[],
  collect: ScopeCollection,
): Promise<PerScopeOutcome> {
  const outcome: PerScopeOutcome = {
    succeeded: [],
    failed: [],
    skipped: [],
    rateLimited: false,
  };

  for (const [index, scopeId] of scopeIds.entries()) {
    try {
      await collect(scopeId);
      recordCollectionSuccess(db, scopeId);
      outcome.succeeded.push(scopeId);
      logger.info("スコープの収集に成功した", { scopeId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 失敗は収集カーソルに残す。最終収集成功時刻は上書きしないため、
      // 画面（#20）には「いつから古いか」と「なぜ止まったか」の両方が出る。
      recordCollectionFailure(db, scopeId, message);
      outcome.failed.push(scopeId);

      if (error instanceof GitHubRateLimitError) {
        outcome.rateLimited = true;
        outcome.skipped = scopeIds.slice(index + 1);
        logger.warn("レート制限のため収集サイクルを中断する", {
          scopeId,
          resetAt: error.resetAt,
          skipped: outcome.skipped,
        });
        break;
      }

      logger.error("スコープの収集に失敗した（他スコープは続行する）", { scopeId, error: message });
    }
  }

  return outcome;
}
