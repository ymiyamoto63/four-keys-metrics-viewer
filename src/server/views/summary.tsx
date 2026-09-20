/**
 * サマリ画面（#20）。ADR-0003 が決めた 2 階層の 1 枚目。
 *
 * ## この画面が守っていること
 *
 * - **スコープは 1 つずつ表示する。** 合算・横並び比較・ランキング・単一スコアへの集約・
 *   目標値の提示はしない（`README.md` のアンチパターン / `CONTEXT.md` のスコープ）。
 *   切り替えはリンクだけで、他スコープの数値はこのページに一切現れない。
 * - **デプロイ検出ルールと収集状態を常時出す**（ADR-0001 決定 5 / ADR-0007）。
 *   どちらも `scope-notices.tsx`。
 * - **「収集済みで 0 件の週」と「収集がカバーしていない週」を言い分ける。**
 *   チャートでは両方とも点の有無に潰れてしまうため、潰す前の `coverage`（#17）を
 *   `CoverageNote` で別途説明する。
 * - **収集の手動トリガボタンは置かない**（#11 で却下済み。起動＝最新化、ADR-0007 決定 4）。
 */

import type { DeployFrequencyResult } from "../../metrics/deploy-frequency.ts";
import type { Scope } from "../../scopes.ts";
import { deployFrequencyChart, leadTimeChart, metricDetailHref, summaryHref } from "../charts.ts";
import { formatJstDate } from "../format.ts";
import { PERIOD_WEEK_OPTIONS, type PeriodWeeks } from "../period.ts";
import type { ScopeMetrics } from "../scope-metrics.ts";
import { WeeklyLineChart } from "./chart.tsx";
import { Layout } from "./layout.tsx";
import { CollectionStatusPanel, DeployRuleNotice } from "./scope-notices.tsx";

export type SummaryProps = {
  metrics: ScopeMetrics;
  /** 切り替え用の一覧。**数値は持ち込まない**（合算・比較を作れないようにする）。 */
  scopes: readonly Scope[];
  weeks: PeriodWeeks;
  environment: {
    databasePath: string;
    collectCron: string;
    githubTokenPresent: boolean;
  };
};

export function Summary({ metrics, scopes, weeks, environment }: SummaryProps) {
  const { scope, period, deployFrequency, leadTime, collection } = metrics;

  return (
    <Layout title={`${scope.id} — サマリ`}>
      <ScopeSwitcher scopes={scopes} current={scope} weeks={weeks} />

      <h1>{scope.id}</h1>

      <CollectionStatusPanel status={collection} />
      <DeployRuleNotice scope={scope} />

      <PeriodSelector scope={scope} weeks={weeks} />
      <p class="fk-hint" data-testid="period">
        集計期間: {formatJstDate(period.from)} 〜 {formatJstDate(period.to)}（{weeks} 週・JST
        月曜始まり）
      </p>

      <WeeklyLineChart
        {...deployFrequencyChart(deployFrequency)}
        pointHref={(week) => metricDetailHref(scope.id, "deploy-frequency", week, weeks)}
      />
      <WeeklyLineChart
        {...leadTimeChart(leadTime)}
        pointHref={(week) => metricDetailHref(scope.id, "lead-time", week, weeks)}
      />
      <p class="fk-hint">
        チャートの点をクリックすると、その週の根拠（デプロイとコミット）を出す指標詳細へ移動します。
        線が途切れている週の理由（収集の穴なのか、標本が少ないのか）は下の「グラフの空白について」を
        参照してください。
      </p>

      <CoverageNote result={deployFrequency} />

      <section class="fk-notice">
        <h2>動作環境</h2>
        <dl>
          <dt>DB ファイル</dt>
          <dd>
            <code>{environment.databasePath}</code>
          </dd>
          <dt>収集スケジュール</dt>
          <dd>
            <code>{environment.collectCron}</code>
          </dd>
          <dt>GitHub トークン</dt>
          <dd>
            {environment.githubTokenPresent
              ? "設定済み"
              : "未設定（収集は失敗として記録されます。上の収集状態を確認してください）"}
          </dd>
        </dl>
        <p class="fk-hint">
          収集の手動トリガボタンはありません。起動時に自動で追いつき、稼働中は
          <code>{environment.collectCron}</code> で収集します（ADR-0007 決定 4 / #11）。
        </p>
      </section>
    </Layout>
  );
}

/**
 * スコープの切り替え。**リンクだけ**を並べる。
 *
 * ここに各スコープの数値を添えると、それは横並び比較そのものになる
 * （`README.md`「チーム間の競争を煽らない」）。順序は `scopes.toml` の記載順のままにし、
 * 指標による並べ替え＝ランキングを作らない。
 */
function ScopeSwitcher({
  scopes,
  current,
  weeks,
}: {
  scopes: readonly Scope[];
  current: Scope;
  weeks: PeriodWeeks;
}) {
  return (
    <nav class="fk-switcher" data-testid="scope-switcher" aria-label="スコープの切り替え">
      <span class="fk-switcher__label">スコープ</span>
      <ul>
        {scopes.map((scope) => (
          <li key={scope.id}>
            {scope.id === current.id ? (
              <span aria-current="page" class="fk-switcher__current">
                {scope.id}
              </span>
            ) : (
              <a href={summaryHref(scope.id, weeks)}>{scope.id}</a>
            )}
          </li>
        ))}
      </ul>
      <p class="fk-hint">
        スコープは 1 つずつ表示します。合算・横並び比較・ランキング・目標値の提示はしません（
        <code>README.md</code> のアンチパターン）。
      </p>
    </nav>
  );
}

function PeriodSelector({ scope, weeks }: { scope: Scope; weeks: PeriodWeeks }) {
  return (
    <nav class="fk-switcher" data-testid="period-selector" aria-label="期間の選択">
      <span class="fk-switcher__label">期間</span>
      <ul>
        {PERIOD_WEEK_OPTIONS.map((option) => (
          <li key={option}>
            {option === weeks ? (
              <span aria-current="page" class="fk-switcher__current">
                {option} 週
              </span>
            ) : (
              <a href={summaryHref(scope.id, option)}>{option} 週</a>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * 「収集済みで 0 件の週」と「収集がカバーしていない週」の区別（#20 の完了条件）。
 *
 * チャートに渡す時点で `covered` かつ 0 件の週は `0`、それ以外は `null` に潰れる（#17）。
 * 潰れた後では「点が無い」としか読めないので、潰す前の `DeployFrequencyWeek.coverage` を
 * ここで読み直して週数と週の並びを添える。これが無いと、ADR-0004 が意図的に作った空白が
 * 「デプロイが無かった週」と同じ見た目のまま残る。
 */
function CoverageNote({ result }: { result: DeployFrequencyResult }) {
  const covered = result.weeks.filter((week) => week.coverage === "covered");
  const zero = covered.filter((week) => week.deployCount === 0);
  const partial = result.weeks.filter((week) => week.coverage === "partial");
  const uncovered = result.weeks.filter((week) => week.coverage === "uncovered");

  return (
    <section class="fk-notice" data-testid="coverage-note">
      <h2>グラフの空白について</h2>
      <dl>
        <dt>収集済みの週</dt>
        <dd data-testid="coverage-covered">
          {covered.length} 週（うち <strong>デプロイ 0 件の週が {zero.length} 週</strong>。
          これは欠損ではなく実データの 0 なので、点を打っています）
        </dd>
        <dt>収集の途中の週</dt>
        <dd data-testid="coverage-partial">
          {partial.length} 週
          {partial.length === 0
            ? ""
            : `（${partial.map((week) => `${week.week.key}: 現在 ${week.observedDeployCount} 件`).join(" / ")}）`}
          。週の一部しか数えていないため値を出していません
        </dd>
        <dt>収集がカバーしていない週</dt>
        <dd data-testid="coverage-uncovered">
          {uncovered.length} 週
          {uncovered.length === 0 ? "" : `（${rangeLabel(uncovered.map((w) => w.week.key))}）`}。
          <strong>データがありません</strong>（デプロイが無かったという意味ではありません）
        </dd>
      </dl>
      <p class="fk-hint">
        収集済み範囲の新しい端は上の「最終収集成功」、古い端はバックフィル進捗です（
        <code>src/metrics/coverage.ts</code>）。
      </p>
    </section>
  );
}

function rangeLabel(keys: readonly string[]): string {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) {
    return "";
  }
  return first === last ? first : `${first} 〜 ${last}`;
}
