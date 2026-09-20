/**
 * 収集カバレッジの判定（#16 の土台、#17 の完了条件）。
 *
 * ## なぜ要るか
 *
 * デプロイ頻度において **0 件は欠損ではなく本物の値 0** である（その週はデプロイしなかった、
 * という実データ）。欠損になるのは**収集がその週をまだカバーしていない場合だけ**。
 * 生イベントだけを見ていると両者はどちらも「行が無い」として現れ、区別が付かない。
 * 収集カーソル（`CollectionCoverage`）と週を突き合わせるのがこのファイルの仕事。
 *
 * ADR-0007 の構成ではアプリは常時稼働しない。したがって「直近が欠けている」状態は
 * 例外ではなく通常である。ここを曖昧にすると、利用者は**まだ集めていない範囲を
 * 「デプロイが無かった範囲」と読む**。
 *
 * ここも純粋関数だけ。DB も GitHub も触らない。
 */

import type { CollectionCoverage } from "./types.ts";
import { parseInstant, type Week } from "./week.ts";

/**
 * 週が収集でどこまでカバーされているか。
 *
 * - `covered` — 週の全体が収集済み。**0 件なら本物の 0**
 * - `partial` — 週の一部だけ収集済み。数え上げは終わっていない
 *   （バックフィルの端の週と、進行中の今週が必ずこれになる）
 * - `uncovered` — 一切収集していない。**データなし**
 */
export type WeekCoverage = "covered" | "partial" | "uncovered";

/** 収集済み範囲。両端とも ISO8601。 */
export type CollectedRange = {
  from: string;
  to: string;
};

/**
 * 収集済み範囲を求める。カバーしている範囲が無ければ `null`。
 *
 * 古い端は `backfilled_until`（そこまで遡った）、新しい端は `last_success_at`
 * （そこまで追いついた）。**どちらかが欠けていれば範囲は無いものとして扱う。**
 * 例えばバックフィルだけ進んで「最新を追う収集」が一度も成功していない場合、
 * 直近側がどこまで埋まっているか分からない。分からない側は
 * 「カバーしていない」に倒す — 過少申告は「まだ集めていません」と表示されるだけだが、
 * 過大申告は**架空の 0 を本物の 0 として見せる**ため。
 */
export function collectedRange(coverage: CollectionCoverage): CollectedRange | null {
  if (coverage.backfilledUntil === null || coverage.lastSuccessAt === null) {
    return null;
  }
  const fromMs = parseInstant(coverage.backfilledUntil, "backfilled_until");
  const toMs = parseInstant(coverage.lastSuccessAt, "last_success_at");
  if (toMs <= fromMs) {
    return null;
  }
  return { from: coverage.backfilledUntil, to: coverage.lastSuccessAt };
}

/** 週が収集済み範囲にどれだけ収まっているかを判定する。 */
export function classifyWeekCoverage(coverage: CollectionCoverage, week: Week): WeekCoverage {
  const range = collectedRange(coverage);
  if (range === null) {
    return "uncovered";
  }
  const fromMs = parseInstant(range.from, "backfilled_until");
  const toMs = parseInstant(range.to, "last_success_at");
  const startMs = parseInstant(week.startedAt, "週の開始時刻");
  // 週は [startedAt, endedAt) の半開区間なので、重なりの判定も終端を含めない。
  const endMs = parseInstant(week.endedAt, "週の終了時刻");

  if (endMs <= fromMs || startMs >= toMs) {
    return "uncovered";
  }
  if (startMs >= fromMs && endMs <= toMs) {
    return "covered";
  }
  return "partial";
}
