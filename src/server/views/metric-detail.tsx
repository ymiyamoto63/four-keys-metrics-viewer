/**
 * 指標詳細画面（#21）。ADR-0003 が決めた 2 階層の 2 枚目で、**最後の 1 枚**。
 *
 * ## この画面が果たすもの
 *
 * `README.md` 柱 4「算出ロジックを開示する」の UI 側。サマリ（#20）が「推移」を見せ、
 * ここが「その点がどの出来事から出たのか」を見せる。中心は `EvidenceList`（根拠イベント一覧）で、
 * チャートはその文脈を与えるために置いてある。
 *
 * ## この画面が守っていること
 *
 * - **収集状態とデプロイ検出ルールを常時出す**（ADR-0007 / ADR-0001 決定 5）。理由は #20 と同じ。
 *   ここだけ消すと、根拠イベント一覧が「何をデプロイとみなした一覧なのか」「いつ時点の
 *   データなのか」が読めない一覧になる
 * - **3 階層目を作らない**（ADR-0003 決定 3）。行のリンク先は GitHub であって自前の画面ではない
 * - **合算・ランキング・単一スコア・目標値を出さない**（`README.md` のアンチパターン）。
 *   この画面に現れるのは 1 スコープ・1 指標・1 週ぶんだけで、他と足せる形の値は無い
 */

import type { Scope } from "../../scopes.ts";
import {
  deployFrequencyChart,
  deployIntervalChart,
  leadTimeBreakdownChart,
  leadTimeChart,
  METRIC_LABELS,
  type MetricKey,
  metricDetailHref,
  summaryHref,
} from "../charts.ts";
import type { WeekEvidence } from "../evidence.ts";
import { formatJstDate } from "../format.ts";
import type { PeriodWeeks } from "../period.ts";
import type { ScopeMetrics } from "../scope-metrics.ts";
import { WeeklyLineChart } from "./chart.tsx";
import { EvidenceList } from "./evidence-list.tsx";
import { Layout } from "./layout.tsx";
import { CollectionStatusPanel, DeployRuleNotice } from "./scope-notices.tsx";

export type MetricDetailProps = {
  metrics: ScopeMetrics;
  metric: MetricKey;
  /** 選択された週の根拠。週の妥当性は経路側（`app.tsx`）で確かめてある。 */
  evidence: WeekEvidence;
  weeks: PeriodWeeks;
  /** 期間内の全週（前後の週へ移るリンクに使う）。古い順。 */
  weekKeys: readonly string[];
};

export function MetricDetail({ metrics, metric, evidence, weeks, weekKeys }: MetricDetailProps) {
  const { scope, period, deployFrequency, leadTime, collection } = metrics;
  const label = METRIC_LABELS[metric];

  return (
    <Layout title={`${label}（${evidence.week} の週） — ${scope.id}`}>
      <p>
        <a href={summaryHref(scope.id, weeks)}>← {scope.id} のサマリへ戻る</a>
      </p>

      <h1 data-testid="metric-detail-title">
        {label}（{evidence.week} の週）
      </h1>
      <p class="fk-hint" data-testid="period">
        スコープ <code>{scope.id}</code> / 集計期間 {formatJstDate(period.from)} 〜{" "}
        {formatJstDate(period.to)}（{weeks} 週・JST 月曜始まり）
      </p>

      {/*
        収集状態とデプロイ検出ルールは詳細画面でも常時表示する（#20 と同じ理由）。
        古いデータを現在の状態として読ませないため。ここを削ると
        `metric-detail.test.tsx` が落ちる。
      */}
      <CollectionStatusPanel status={collection} />
      <DeployRuleNotice scope={scope} />

      <WeekSwitcher
        scope={scope}
        metric={metric}
        week={evidence.week}
        weeks={weeks}
        weekKeys={weekKeys}
      />

      {metric === "deploy-frequency" ? (
        <>
          <WeeklyLineChart
            {...deployFrequencyChart(deployFrequency)}
            pointHref={(week) => metricDetailHref(scope.id, metric, week, weeks)}
          />
          <WeeklyLineChart
            {...deployIntervalChart(deployFrequency)}
            pointHref={(week) => metricDetailHref(scope.id, metric, week, weeks)}
          />
        </>
      ) : (
        <>
          <WeeklyLineChart
            {...leadTimeChart(leadTime)}
            pointHref={(week) => metricDetailHref(scope.id, metric, week, weeks)}
          />
          <WeeklyLineChart
            {...leadTimeBreakdownChart(leadTime)}
            pointHref={(week) => metricDetailHref(scope.id, metric, week, weeks)}
          />
        </>
      )}

      <WeekSummary evidence={evidence} metric={metric} />

      <EvidenceList evidence={evidence} leadTime={leadTime} />
    </Layout>
  );
}

/**
 * この週の値そのもの。**目標値も達成度も書かない**（`README.md` のアンチパターン）。
 *
 * 書くのは「いくつだったか」と「何件から出したか」だけ。良し悪しの判定はこのアプリの仕事ではなく、
 * 画面は会話のきっかけを出すところまでに留める。
 */
function WeekSummary({ evidence, metric }: { evidence: WeekEvidence; metric: MetricKey }) {
  const { deployFrequency, leadTime } = evidence;

  return (
    <section class="fk-notice" data-testid="week-summary">
      <h2>{evidence.week} の週の値</h2>
      {metric === "deploy-frequency" ? (
        <dl>
          <dt>デプロイ回数</dt>
          <dd data-testid="week-deploy-count">
            {deployFrequency.deployCount === null
              ? `値なし（実際に数え上がったのは ${deployFrequency.observedDeployCount} 件ですが、収集がこの週を数え切れていないため主指標としては出しません）`
              : `${deployFrequency.deployCount} 回`}
          </dd>
          <dt>デプロイ間隔の中央値</dt>
          <dd data-testid="week-deploy-interval">
            {deployFrequency.deployIntervalHours === undefined
              ? `値なし（間隔の標本 ${deployFrequency.deployIntervalSampleCount} 件では代表値を出しません。ADR-0004）`
              : `${deployFrequency.deployIntervalHours.median.toFixed(1)} 時間（標本 ${deployFrequency.deployIntervalSampleCount} 件）`}
          </dd>
        </dl>
      ) : (
        <dl>
          <dt>合計リードタイム</dt>
          <dd data-testid="week-lead-time">
            {leadTime.summary === null
              ? `値なし（標本 ${leadTime.samples.length} 件では代表値を出しません。ADR-0004）`
              : `中央値 ${leadTime.summary.median.toFixed(1)} 時間 / p75 ${leadTime.summary.p75.toFixed(1)} 時間 / p90 ${leadTime.summary.p90.toFixed(1)} 時間（標本 ${leadTime.summary.count} 件）`}
          </dd>
          <dt>3 区間内訳（中央値）</dt>
          <dd data-testid="week-lead-time-breakdown">
            {leadTime.breakdown === null
              ? "値なし（内訳を持つ標本が足りません。PR を経由しないコミットには内訳がありません）"
              : `コミット → PR open ${leadTime.breakdown.commitToPrOpen.median.toFixed(1)} 時間 / PR open → merge ${leadTime.breakdown.prOpenToMerge.median.toFixed(1)} 時間 / merge → デプロイ ${leadTime.breakdown.mergeToDeploy.median.toFixed(1)} 時間（標本 ${leadTime.breakdown.count} 件）`}
          </dd>
        </dl>
      )}
      <p class="fk-hint">
        このアプリは目標値を提示しません。比較の軸は他チームではなく過去の自分たちです（
        <code>README.md</code> のアンチパターン）。
      </p>
    </section>
  );
}

/**
 * 前後の週へ移る導線。**チャートの点を押し直さなくても隣の週を見られるようにする。**
 *
 * 週の並びは集計期間から作る（`weeksBetween`）ので、デプロイが 1 件も無い週も飛ばさずに
 * 辿れる。飛ばすと「デプロイが無かった週」を一覧で確かめる経路が画面から消える。
 */
function WeekSwitcher({
  scope,
  metric,
  week,
  weeks,
  weekKeys,
}: {
  scope: Scope;
  metric: MetricKey;
  week: string;
  weeks: PeriodWeeks;
  weekKeys: readonly string[];
}) {
  const index = weekKeys.indexOf(week);
  const previous = index > 0 ? weekKeys[index - 1] : undefined;
  const next = index >= 0 && index < weekKeys.length - 1 ? weekKeys[index + 1] : undefined;

  return (
    <nav class="fk-switcher" data-testid="week-switcher" aria-label="週の切り替え">
      <span class="fk-switcher__label">週</span>
      <ul>
        <li>
          {previous === undefined ? (
            <span class="fk-hint">← これ以上は期間の外です</span>
          ) : (
            <a href={metricDetailHref(scope.id, metric, previous, weeks)}>← {previous} の週</a>
          )}
        </li>
        <li>
          <span aria-current="page" class="fk-switcher__current">
            {week}
          </span>
        </li>
        <li>
          {next === undefined ? (
            <span class="fk-hint">これ以上は期間の外です →</span>
          ) : (
            <a href={metricDetailHref(scope.id, metric, next, weeks)}>{next} の週 →</a>
          )}
        </li>
      </ul>
    </nav>
  );
}
