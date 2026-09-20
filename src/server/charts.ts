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
import { toChartWeeks, toDeployCountPoints } from "../metrics/deploy-frequency.ts";
import type { LeadTimeMetrics } from "../metrics/lead-time.ts";
import { toLeadTimeChart } from "../metrics/lead-time.ts";
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

/** `WeeklyLineChart` にそのまま渡せる props（`pointHref` は呼び出し側が足す）。 */
export type ChartSpec = Pick<WeeklyLineChartProps, "title" | "weeks" | "series" | "unitLabel">;

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
  };
}
