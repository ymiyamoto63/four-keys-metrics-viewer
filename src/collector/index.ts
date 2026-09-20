import type { Db } from "../db/index.ts";
import { logger } from "../logger.ts";

export type CollectionTrigger = "startup" | "schedule";

/**
 * 収集サイクル 1 回分。中身は #10〜#12 で実装する。
 *
 * ここで確立しておく約束は 2 つ。
 * - 例外を外に投げない。1 スコープの失敗が他スコープやプロセスを巻き込まない（ADR-0003 引き継ぎ）
 * - 起動時（追いつき）と定期実行で同じ入口を通る（ADR-0007 決定 4）
 *
 * 部品は切り出し済みで、あとは #11 が繋ぐだけになっている。
 * - スコープ単位の失敗分離: `per-scope.ts`（#10）
 * - 過去へ遡る収集の分割と再開: `backfill.ts` / `window.ts`（#12）
 *
 * #11 はスコープ一覧（#9）を `collectPerScope` に渡し、各スコープの中で `runBackfill` に
 * 「この窓のコミット・PR を取って保存する」処理を渡す。最新を追う収集も同じ窓の形で書く。
 */
export async function runCollection(_db: Db, trigger: CollectionTrigger): Promise<void> {
  logger.info("収集サイクルを開始", { trigger });
  logger.warn("収集は未実装のため、何もせず終了する", { trigger, issues: [11] });
}
