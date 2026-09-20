/**
 * HTTP の経路（#20）。
 *
 * ## URL の階層
 *
 * ADR-0003 が決めた 2 階層（サマリ → 指標詳細）を、そのまま URL の階層にする。
 *
 * - `/` — 先頭のスコープのサマリへ転送する
 * - `/scopes/:scopeId` — サマリ（#20）。期間は `?weeks=`
 * - `/scopes/:scopeId/metrics/:metric` — 指標詳細（#21）。週は `?week=YYYY-MM-DD`
 *
 * **スコープを URL の第 1 階層に置く**のは、指標がスコープ単位でしか存在しないため
 * （`CONTEXT.md`）。`/metrics/deploy-frequency?scope=...` の形にすると
 * 「スコープを外した指標」という URL が書けてしまい、合算の入口になる。
 * 3 階層目（個別イベント）は作らない。GitHub へ外部リンクする（ADR-0003）。
 *
 * URL の生成は `charts.ts` の `summaryHref` / `metricDetailHref` に寄せてある。
 * ここで解釈する形とあちらで作る形は必ず対で直すこと。
 */

import { type Context, Hono } from "hono";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { Scope } from "../scopes.ts";
import { isMetricKey, metricDetailHref, summaryHref } from "./charts.ts";
import { loadWeekEvidence } from "./evidence.ts";
import { DEFAULT_PERIOD_WEEKS, PeriodQueryError, parsePeriodWeeks, periodOf } from "./period.ts";
import { loadScopeMetrics } from "./scope-metrics.ts";
import { MetricDetail } from "./views/metric-detail.tsx";
import { NoticePage } from "./views/notice-page.tsx";
import { Summary } from "./views/summary.tsx";

export type AppOptions = {
  config: Config;
  db: Db;
  /** `scopes.toml` の内容（ADR-0005）。画面はここにあるスコープしか表示しない。 */
  scopes: readonly Scope[];
  /** 現在時刻。収集状態の「n 時間前」と集計期間の終端に使う。テストで固定できるよう注入する。 */
  now?: () => Date;
};

export function createApp({ config, db, scopes, now = () => new Date() }: AppOptions): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const first = scopes[0];
    if (first === undefined) {
      // `loadScopes` が 0 件を拒否するので通常ここへは来ない（ADR-0005）。
      return c.html(
        <NoticePage
          title="スコープがありません"
          message="`scopes.toml` にスコープが 1 つも定義されていません。"
        />,
        500,
      );
    }
    return c.redirect(summaryHref(first.id, DEFAULT_PERIOD_WEEKS));
  });

  app.get("/scopes/:scopeId", (c) => {
    const scope = scopes.find((candidate) => candidate.id === c.req.param("scopeId"));
    if (scope === undefined) {
      return unknownScope(c, scopes);
    }

    let weeks: ReturnType<typeof parsePeriodWeeks>;
    try {
      weeks = parsePeriodWeeks(c.req.query("weeks"));
    } catch (error) {
      if (!(error instanceof PeriodQueryError)) {
        throw error;
      }
      return c.html(
        <NoticePage
          title="その期間は選べません"
          message={error.message}
          backHref={summaryHref(scope.id, DEFAULT_PERIOD_WEEKS)}
          backLabel={`${scope.id} のサマリへ`}
        />,
        400,
      );
    }

    const at = now();
    // 指標の集計値は保存しない（ADR-0002）。毎リクエストここで計算し直す。
    const metrics = loadScopeMetrics(db, scope, periodOf(weeks, at), at);

    return c.html(
      <Summary
        metrics={metrics}
        scopes={scopes}
        weeks={weeks}
        environment={{
          databasePath: config.databasePath,
          collectCron: config.collectCron,
          githubTokenPresent: config.githubToken !== undefined,
        }}
      />,
    );
  });

  /**
   * 指標詳細（#21）。ADR-0003 の 2 階層目。
   *
   * `week` を必須にせず、未指定なら**期間の最終週**にする。サマリの点から来る経路では必ず
   * 付いているが、URL を手で削ったときに 400 で止めるほどの誤りではない（週の選択は
   * 期間の選択と違い、値そのものを変えずに見る場所を変えるだけ）。
   * 一方、**期間の外や週開始日でない `week` は 400 で止める**。空の一覧を返すと、
   * 収集の穴（ADR-0007）と URL の誤りが画面上で同じ空白に見えるため。
   */
  app.get("/scopes/:scopeId/metrics/:metric", (c) => {
    const scope = scopes.find((candidate) => candidate.id === c.req.param("scopeId"));
    if (scope === undefined) {
      return unknownScope(c, scopes);
    }
    const metric = c.req.param("metric");
    if (!isMetricKey(metric)) {
      return c.html(
        <NoticePage
          title="知らない指標です"
          message={`指標 \`${metric}\` はありません。MVP の対象はデプロイ頻度と変更のリードタイムの 2 つです。`}
          backHref={summaryHref(scope.id, DEFAULT_PERIOD_WEEKS)}
          backLabel={`${scope.id} のサマリへ`}
        />,
        404,
      );
    }

    let weeks: ReturnType<typeof parsePeriodWeeks>;
    try {
      weeks = parsePeriodWeeks(c.req.query("weeks"));
    } catch (error) {
      if (!(error instanceof PeriodQueryError)) {
        throw error;
      }
      return c.html(
        <NoticePage
          title="その期間は選べません"
          message={error.message}
          backHref={summaryHref(scope.id, DEFAULT_PERIOD_WEEKS)}
          backLabel={`${scope.id} のサマリへ`}
        />,
        400,
      );
    }

    const at = now();
    // 集計値は保存しない（ADR-0002）。サマリと同じ入口を毎リクエスト通す。
    const metrics = loadScopeMetrics(db, scope, periodOf(weeks, at), at);
    const weekKeys = metrics.leadTime.weeks.map((week) => week.week);
    const latestWeek = weekKeys[weekKeys.length - 1];
    const week = c.req.query("week") ?? latestWeek;

    const evidence = week === undefined ? undefined : loadWeekEvidence(db, metrics, week);
    if (evidence === undefined) {
      const first = weekKeys[0];
      return c.html(
        <NoticePage
          title="その週は表示できません"
          message={
            `週 \`${week ?? ""}\` はこの集計期間にありません。` +
            `指定できるのは ${first ?? "-"} 〜 ${latestWeek ?? "-"} の、JST 月曜始まりの週開始日です。`
          }
          backHref={
            latestWeek === undefined
              ? summaryHref(scope.id, weeks)
              : metricDetailHref(scope.id, metric, latestWeek, weeks)
          }
          backLabel="最新の週へ"
        />,
        400,
      );
    }

    return c.html(
      <MetricDetail
        metrics={metrics}
        metric={metric}
        evidence={evidence}
        weeks={weeks}
        weekKeys={weekKeys}
      />,
    );
  });

  app.get("/healthz", (c) => {
    const row = db.prepare("select 1 as ok").get() as { ok: number } | undefined;
    return c.json({ status: row?.ok === 1 ? "ok" : "degraded" });
  });

  return app;
}

/**
 * 知らないスコープ。**空のサマリを返さない。**
 *
 * 存在しない `scope_id` に対して空のグラフを返すと、収集が届いていないスコープと
 * 見分けが付かない（ADR-0004 の空白と同じ形で混ざる）。404 で止める。
 */
function unknownScope(c: Context, scopes: readonly Scope[]): ReturnType<Context["html"]> {
  const first = scopes[0];
  return c.html(
    <NoticePage
      title="知らないスコープです"
      message={`そのスコープは \`scopes.toml\` にありません。表示できるのは ${scopes
        .map((scope) => scope.id)
        .join(" / ")} です。`}
      backHref={first === undefined ? undefined : summaryHref(first.id, DEFAULT_PERIOD_WEEKS)}
      backLabel="サマリへ"
    />,
    404,
  );
}
