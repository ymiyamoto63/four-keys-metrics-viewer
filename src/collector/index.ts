import type { Db } from "../db/index.ts";
import { logger } from "../logger.ts";

export type CollectionTrigger = "startup" | "schedule";

/**
 * 収集サイクル 1 回分。中身は #10〜#12 で実装する。
 *
 * ここで確立しておく約束は 2 つ。
 * - 例外を外に投げない。1 スコープの失敗が他スコープやプロセスを巻き込まない（ADR-0003 引き継ぎ）
 * - 起動時（追いつき）と定期実行で同じ入口を通る（ADR-0007 決定 4）
 */
export async function runCollection(_db: Db, trigger: CollectionTrigger): Promise<void> {
  logger.info("収集サイクルを開始", { trigger });
  logger.warn("収集は未実装のため、何もせず終了する", { trigger, issues: [10, 11, 12] });
}
