/**
 * 期間の選択（#20）。クエリパラメータ `?weeks=` で表示する週数を選ぶ。
 *
 * 選べる値を固定の選択肢に絞ってあるのは、期間が**指標の見え方を変える**からである。
 * 任意の日数を受けると「同じスコープの同じ週なのに、リンクの出所によって
 * 別の期間のグラフが出る」状態を作れてしまい、`README.md` 柱 4（算出ロジックの開示）と
 * 「比較の軸を過去の自分たちに置く」使い方の両方が緩む。
 *
 * 不正な値は**黙って既定へ落とさず落とす**（ADR-0005 と同じ姿勢）。
 * 期間が勝手に変わったことに気付かないまま「デプロイ頻度が下がった」と読むより、
 * 「その期間は選べません」と言われるほうが安全である。
 */

import type { Period } from "../metrics/week.ts";

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** 画面で選べる週数。 */
export const PERIOD_WEEK_OPTIONS = [12, 26, 52] as const;

export type PeriodWeeks = (typeof PERIOD_WEEK_OPTIONS)[number];

/** 既定は半年（26 週）。52 週は既定のバックフィル範囲（1 年）の端まで使い切る。 */
export const DEFAULT_PERIOD_WEEKS: PeriodWeeks = 26;

export class PeriodQueryError extends Error {}

/** `?weeks=` を読む。未指定は既定値、選択肢外は `PeriodQueryError`。 */
export function parsePeriodWeeks(raw: string | undefined): PeriodWeeks {
  if (raw === undefined || raw === "") {
    return DEFAULT_PERIOD_WEEKS;
  }
  const value = Number(raw);
  const option = PERIOD_WEEK_OPTIONS.find((candidate) => candidate === value);
  if (option === undefined) {
    throw new PeriodQueryError(
      `期間 \`weeks=${raw}\` は選べません。${PERIOD_WEEK_OPTIONS.join(" / ")} のいずれかを指定してください`,
    );
  }
  return option;
}

/**
 * 週数を集計期間へ直す。**現在の週を含めて `weeks` 週**になるように始端を決める
 * （`weeksBetween` が両端の週を含むため、`weeks - 1` 週ぶん遡る）。
 */
export function periodOf(weeks: PeriodWeeks, now: Date): Period {
  return {
    from: new Date(now.getTime() - (weeks - 1) * MS_PER_WEEK).toISOString(),
    to: now.toISOString(),
  };
}
