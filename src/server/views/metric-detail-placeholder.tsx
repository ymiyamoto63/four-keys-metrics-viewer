/**
 * 指標詳細（#21）の**足場**。中身はまだ無い。
 *
 * ## なぜ空のページを置くのか
 *
 * サマリ（#20）のチャートの点は `/scopes/:scopeId/metrics/:metric?week=YYYY-MM-DD` へ
 * リンクする。#21 が入るまでこの経路が 404 だと、
 * 「点から詳細へ辿れる」という #20 の完了条件を**画面上で確認できない**。
 * URL 設計（`charts.ts` の `metricDetailHref`）を先に固定し、遷移だけ通しておく。
 *
 * ## #21 がここに実装するもの（`gh issue view 21`）
 *
 * - 指標ごとの詳細チャート（リードタイムは中央値の主線に p75 / p90 を薄く重ねる）
 * - **根拠イベント一覧**: 選択した週に含まれたデプロイとコミットを列挙する
 * - 各行から **GitHub の該当 PR / コミット / ワークフロー実行へ外部リンク**する
 *   （個別イベントの詳細画面は自前で作らない。ADR-0003 が 3 階層目を却下した理由）
 * - リードタイムの **3 区間内訳**（コミット → PR open → merge → デプロイ）。
 *   `toLeadTimeBreakdownChart`（#18）がそのまま使える
 *
 * ## #21 がそのまま使えるもの
 *
 * - `loadScopeMetrics(db, scope, period, now)`（`server/scope-metrics.ts`）—
 *   `deployFrequency.weeks` / `leadTime.weeks` を `week` で引けば、その週の
 *   `samples` / `excluded` / `coverage` が揃っている。`input` には生の標本も入っている
 * - `CollectionStatusPanel` / `DeployRuleNotice`（`views/scope-notices.tsx`）—
 *   詳細画面でも収集状態とデプロイ検出ルールは常時出すこと（ADR-0007 / ADR-0001 決定 5）
 * - `deployFrequencyChart` / `leadTimeChart`（`server/charts.ts`）
 * - PR の `htmlUrl` は `pull_requests` に保存済み（`db/store.ts`）。コミットとワークフロー実行の
 *   URL は `raw` から取れる（`docs/raw-columns.md`）
 */

import type { Scope } from "../../scopes.ts";
import { METRIC_LABELS, type MetricKey, summaryHref } from "../charts.ts";
import type { PeriodWeeks } from "../period.ts";
import { Layout } from "./layout.tsx";

export type MetricDetailPlaceholderProps = {
  scope: Scope;
  metric: MetricKey;
  /** 選択された週（JST 月曜始まりの週開始日）。指定なしでこの URL に来ることもある。 */
  week: string | undefined;
  weeks: PeriodWeeks;
};

export function MetricDetailPlaceholder({
  scope,
  metric,
  week,
  weeks,
}: MetricDetailPlaceholderProps) {
  const label = METRIC_LABELS[metric];
  return (
    <Layout title={`${label} — ${scope.id}`}>
      <p>
        <a href={summaryHref(scope.id, weeks)}>← {scope.id} のサマリへ戻る</a>
      </p>
      <h1 data-testid="metric-detail-title">
        {label}
        {week === undefined ? "" : `（${week} の週）`}
      </h1>
      <section class="fk-notice" data-testid="metric-detail-placeholder">
        <h2>この画面はまだ実装されていません（#21）</h2>
        <p>
          ここには、選択した週の<strong>根拠イベント一覧</strong>
          （その週に含まれたデプロイとコミット）と、各行から GitHub の該当 PR / コミット /
          ワークフロー実行への外部リンク、リードタイムの 3 区間内訳が入ります。
        </p>
        <dl>
          <dt>スコープ</dt>
          <dd>
            <code>{scope.id}</code>
          </dd>
          <dt>指標</dt>
          <dd>
            <code>{metric}</code>
          </dd>
          <dt>週</dt>
          <dd>
            <code>{week ?? "（未指定）"}</code>
          </dd>
        </dl>
      </section>
    </Layout>
  );
}
