/**
 * 指標の計算結果を `WeeklyLineChart`（#19）へ渡す形にまとめる（#20）。
 *
 * URL 設計も**ここ 1 箇所**に置く。サマリ（#20）が作るリンク先と指標詳細（#21）が
 * 受け取る経路が別々の文字列リテラルで書かれていると、片方を直したときにもう片方が
 * 静かに 404 になる。`metricDetailHref` と `MetricRoutes` を両画面で共有する。
 *
 * `views/chart.tsx` からは**型だけ**を借りる。JSX を import しないので、
 * この関数群はレンダリングを起こさずにテストできる。
 */

import type { DeployFrequencyResult } from "../metrics/deploy-frequency.ts";
import {
  toChartWeeks,
  toDeployCountPoints,
  toDeployIntervalMedianPoints,
} from "../metrics/deploy-frequency.ts";
import type { LeadTimeMetrics } from "../metrics/lead-time.ts";
import {
  LEAD_TIME_UNIT_LABEL,
  toLeadTimeBreakdownChart,
  toLeadTimeChart,
} from "../metrics/lead-time.ts";
import type { PeriodWeeks } from "./period.ts";
import type { WeeklyLineChartProps } from "./views/chart.tsx";

/**
 * 指標詳細（#21）の URL に入る指標の識別子。
 *
 * `/scopes/:scopeId/metrics/:metric?week=YYYY-MM-DD` の `:metric` がこれ。
 * MVP の対象はスループット側 2 指標だけ（`README.md`）。
 */
export const METRIC_KEYS = ["deploy-frequency", "lead-time"] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/** 画面に出す指標名。用語は `CONTEXT.md` に合わせる。 */
export const METRIC_LABELS: Record<MetricKey, string> = {
  "deploy-frequency": "デプロイ頻度",
  "lead-time": "変更のリードタイム",
};

export function isMetricKey(value: string): value is MetricKey {
  return (METRIC_KEYS as readonly string[]).includes(value);
}

/** サマリ（#20）の URL。スコープは URL の第 1 階層に置く（#21 の詳細はこの下に入る）。 */
export function summaryHref(scopeId: string, weeks: PeriodWeeks): string {
  return `/scopes/${encodeURIComponent(scopeId)}?weeks=${weeks}`;
}

/**
 * 指標詳細（#21）の URL。
 *
 * `week` はチャートの点が指す週（JST 月曜始まりの週開始日）。`weeks` を持ち回すのは、
 * 詳細から戻ったときに期間が既定へ巻き戻らないようにするため。
 */
export function metricDetailHref(
  scopeId: string,
  metric: MetricKey,
  week: string,
  weeks: PeriodWeeks,
): string {
  return `/scopes/${encodeURIComponent(scopeId)}/metrics/${metric}?week=${week}&weeks=${weeks}`;
}

/**
 * `WeeklyLineChart` にそのまま渡せる props（`pointHref` は呼び出し側が足す）。
 *
 * `missingWeekNote` をここに含めるのは、**空白の理由を知っているのは指標の側だけ**だからである
 * （#21）。チャートは「どの系列にも値が無い週」しか知らず、それが収集の穴（ADR-0007）なのか
 * 標本数ゲート（ADR-0004）なのかを言えない。言えない側に文言を持たせると、
 * どちらか一方の理由で両方を説明することになる。
 */
export type ChartSpec = Pick<
  WeeklyLineChartProps,
  "title" | "weeks" | "series" | "unitLabel" | "missingWeekNote"
>;

/**
 * デプロイ頻度（主指標 = 週あたりのデプロイ回数）。
 *
 * 副指標のデプロイ間隔中央値はここには出さない。同じ図に重ねると単位（回 / 時間）が混ざり、
 * 別の図として並べるとサマリ 1 枚に 3 つの図が積み上がる。間隔は #21 の担当にする。
 */
export function deployFrequencyChart(result: DeployFrequencyResult): ChartSpec {
  return {
    title: `${METRIC_LABELS["deploy-frequency"]}（週あたりのデプロイ回数）`,
    weeks: toChartWeeks(result),
    unitLabel: " 回",
    series: [{ name: "デプロイ数", role: "primary", points: toDeployCountPoints(result) }],
    // デプロイ頻度の空白は**標本不足ではない**。収集済みの週はデプロイ 0 件でも 0 として
    // 点が打たれる（#17）ので、点が無い＝その週を数え切れていない、以外にならない。
    missingWeekNote: (count) =>
      `値を出していない ${count} 週は、収集がその週の全体に届いていない週です（ADR-0007）。` +
      "デプロイが 0 件だった週は欠損ではなく 0 として点を打っています。",
  };
}

/**
 * デプロイ頻度の**副指標**（デプロイ間隔の中央値）。詳細画面（#21）だけに出す。
 *
 * サマリに並べないのは #20 の判断（`deployFrequencyChart` のコメント）どおり。単位が
 * 回 / 時間で混ざるためで、ここは「デプロイ頻度をもう一段掘る」画面なので並べてよい。
 */
export function deployIntervalChart(result: DeployFrequencyResult): ChartSpec {
  return {
    title: `デプロイ間隔の中央値（${LEAD_TIME_UNIT_LABEL}）`,
    weeks: toChartWeeks(result),
    unitLabel: ` ${LEAD_TIME_UNIT_LABEL}`,
    series: [
      { name: "間隔の中央値", role: "primary", points: toDeployIntervalMedianPoints(result) },
    ],
    // 間隔だけは主指標と違い、標本数ゲート（ADR-0004）でも空白になる。両方を書く。
    missingWeekNote: (count) =>
      `値を出していない ${count} 週は、デプロイ間隔の標本が足りない週（ADR-0004）か、` +
      "収集がその週の全体に届いていない週（ADR-0007）です。下の根拠イベントで確かめられます。",
  };
}

/** 変更のリードタイム。中央値を主線に p75 / p90 を重ねる（ADR-0004）。 */
export function leadTimeChart(metrics: LeadTimeMetrics): ChartSpec {
  const chart = toLeadTimeChart(metrics);
  return {
    title: `${METRIC_LABELS["lead-time"]}（${chart.unitLabel}）`,
    weeks: chart.weeks,
    unitLabel: ` ${chart.unitLabel}`,
    series: chart.series,
    missingWeekNote: (count) =>
      `値を出していない ${count} 週は、標本（コミット）が ${metrics.minSamples} 件未満の週` +
      "（ADR-0004）か、収集がその週の全体に届いていない週（ADR-0007）です。" +
      "どちらなのかは収集状態と下の根拠イベントで確かめられます。",
  };
}

/**
 * リードタイムの 3 区間内訳（コミット → PR open → merge → デプロイ）の週次推移。#21。
 *
 * **合計側とは別の標本数ゲートを通っている**（#18）。内訳を持つ標本は PR に結び付いた
 * コミットだけなので、合計が出ている週でも内訳が空白になることがある。文言でそう言う。
 */
export function leadTimeBreakdownChart(metrics: LeadTimeMetrics): ChartSpec {
  const chart = toLeadTimeBreakdownChart(metrics);
  return {
    title: `リードタイムの 3 区間内訳（各区間の中央値・${chart.unitLabel}）`,
    weeks: chart.weeks,
    unitLabel: ` ${chart.unitLabel}`,
    series: chart.series,
    missingWeekNote: (count) =>
      `内訳を出していない ${count} 週は、内訳を持つ標本（PR に結び付いたコミット）が ` +
      `${metrics.minSamples} 件未満の週です。合計リードタイムが出ている週でも、` +
      "その週のコミットが直接 push ばかりなら内訳は出ません（#18）。",
  };
}
