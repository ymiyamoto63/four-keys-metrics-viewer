/**
 * 指標詳細画面（#21）のレンダリング結果を HTML 文字列として検査する。
 *
 * 固定しているのは見た目ではなく、**消えると柱 4（算出ロジックの開示）が果たせなくなる要素**。
 *
 * - 選択した週の根拠イベント（デプロイとコミット）が 1 件ずつ並ぶこと
 * - 各行から GitHub の該当ページへ外部リンクすること（ADR-0003 決定 3）
 * - 3 区間内訳が出ること、**PR を経由しないコミットで 0 ではなく「なし」と出ること**（#18）
 * - 収集状態とデプロイ検出ルールがこの画面でも消えないこと（ADR-0007 / ADR-0001 決定 5）
 * - **個別イベントの自前詳細画面へのリンクが 1 本も無いこと**（3 階層目を作らない約束）
 * - 不正な `week` / 未知の `metric` / 未登録スコープの扱い
 *
 * DB はインメモリ（`db/testing.ts`）。**ネットワークには出ない。**
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/index.ts";
import { openTestDatabase } from "../db/testing.ts";
import { weekOf } from "../metrics/week.ts";
import type { Scope } from "../scopes.ts";
import { createApp } from "./app.tsx";
import { seedScope, TEST_CONFIG, testScope } from "./testing.ts";

/** 固定の「現在時刻」。2026-09-17（木）18:00 JST。 */
const NOW = new Date("2026-09-17T09:00:00Z");
const LAST_SUCCESS_AT = "2026-09-17T06:00:00Z";
const BACKFILLED_UNTIL = "2026-06-01T00:00:00Z";

const BASE_DEPLOY = "2026-08-05T02:00:00Z";
const DEPLOY_1 = "2026-08-12T02:00:00Z";
const DEPLOY_2 = "2026-08-13T02:00:00Z";
/** 根拠を確かめる週（d1 と d2 の両方が入る）。 */
const TARGET_WEEK = weekOf(DEPLOY_1).key;

const ALPHA = testScope({ id: "alpha" });

/**
 * 1 週に 2 デプロイ・7 コミットを置く。内訳の有無を両方作るのが狙い。
 *
 * - `c1` / `c2` / `c3` — PR 経由。時刻が順に並ぶので **3 区間内訳あり**
 * - `d1` — マージコミット。PR には当たるが時刻の順序が合わず **内訳なし**（#18）
 * - `c4` / `c5` / `d2` — PR を経由しない直接 push。**内訳なし**
 */
function seedAlpha(db: Db, scope: Scope = ALPHA): void {
  seedScope(db, {
    scope,
    deployments: [
      { sha: "d0", deployedAt: BASE_DEPLOY },
      { sha: "d1", deployedAt: DEPLOY_1, commitShas: ["c1", "c2", "c3", "d1"] },
      { sha: "d2", deployedAt: DEPLOY_2, commitShas: ["c4", "c5", "d2"] },
    ],
    commits: [
      { sha: "c1", committedAt: "2026-08-10T02:00:00Z" },
      { sha: "c2", committedAt: "2026-08-10T05:00:00Z" },
      { sha: "c3", committedAt: "2026-08-11T02:00:00Z" },
      { sha: "c4", committedAt: "2026-08-12T05:00:00Z" },
      { sha: "c5", committedAt: "2026-08-12T22:00:00Z" },
      { sha: "d1", committedAt: DEPLOY_1 },
      { sha: "d2", committedAt: DEPLOY_2 },
    ],
    pullRequests: [
      {
        number: 1,
        createdAt: "2026-08-10T03:00:00Z",
        mergedAt: "2026-08-11T03:00:00Z",
        mergeCommitSha: "d1",
        headSha: "c1",
      },
      {
        number: 2,
        createdAt: "2026-08-10T06:00:00Z",
        mergedAt: "2026-08-11T06:00:00Z",
        mergeCommitSha: null,
        headSha: "c2",
      },
      {
        number: 3,
        createdAt: "2026-08-11T04:00:00Z",
        mergedAt: "2026-08-11T20:00:00Z",
        mergeCommitSha: null,
        headSha: "c3",
      },
    ],
    cursor: {
      backfilledUntil: BACKFILLED_UNTIL,
      backfillComplete: false,
      lastSuccessAt: LAST_SUCCESS_AT,
    },
  });
}

function app(db: Db, scopes: readonly Scope[] = [ALPHA]) {
  return createApp({ config: TEST_CONFIG, db, scopes, now: () => NOW });
}

function detailPath(metric: string, week: string = TARGET_WEEK): string {
  return `/scopes/alpha/metrics/${metric}?week=${week}&weeks=26`;
}

async function detailHtml(db: Db, metric = "lead-time", week: string = TARGET_WEEK) {
  const response = await app(db).request(detailPath(metric, week));
  expect(response.status).toBe(200);
  return await response.text();
}

/** HTML から `href` の値をすべて取り出す（属性は必ず `"` で囲まれる）。 */
function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "");
}

/** `<tr data-testid="evidence-commit" data-commit-sha="..."> ... </tr>` を 1 行ぶん切り出す。 */
function commitRow(html: string, sha: string): string {
  const start = html.indexOf(`data-commit-sha="${sha}"`);
  expect(start, `コミット ${sha} の行が無い`).toBeGreaterThan(-1);
  const end = html.indexOf("</tr>", start);
  return html.slice(start, end);
}

let db: Db;

beforeEach(() => {
  db = openTestDatabase();
});

describe("根拠イベント一覧（柱 4 の中心）", () => {
  it("選択した週のデプロイを列挙する", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    expect(html).toContain('data-testid="evidence-list"');
    // この週のデプロイは d1 と d2 の 2 件。前の週の d0 は出さない。
    expect(html.match(/data-testid="evidence-deployment"/g)).toHaveLength(2);
    expect(html).toContain("2026-08-12 11:00 JST");
    expect(html).toContain("2026-08-13 11:00 JST");
  });

  it("選択した週のコミットを 1 件ずつ列挙する", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    // d1 が運んだ 4 件 + d2 が運んだ 3 件。**1 標本 = 1 コミット**（ADR-0004）。
    expect(html.match(/data-testid="evidence-commit"/g)).toHaveLength(7);
    for (const sha of ["c1", "c2", "c3", "c4", "c5", "d1", "d2"]) {
      expect(html).toContain(`data-commit-sha="${sha}"`);
    }
  });

  it("隣の週を選ぶと別の根拠が出る（週を取り違えていない）", async () => {
    seedAlpha(db);
    const html = await detailHtml(db, "lead-time", weekOf(BASE_DEPLOY).key);

    // d0 は期間内で最も古いデプロイなので差分の base が決まらない（#15）。
    expect(html.match(/data-testid="evidence-deployment"/g)).toHaveLength(1);
    expect(html).toContain("割り当てなし");
    expect(html).not.toContain('data-commit-sha="c1"');
  });

  it("デプロイが無い週は空の一覧ではなく理由を出す", async () => {
    seedAlpha(db);
    const html = await detailHtml(db, "deploy-frequency", "2026-09-14");
    expect(html).toContain('data-testid="evidence-empty"');
  });
});

describe("各行から GitHub の該当ページへ外部リンクする（ADR-0003 決定 3）", () => {
  it("コミットの行が GitHub のコミットページを指す", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    expect(commitRow(html, "c1")).toContain('href="https://github.com/acme/alpha/commit/c1"');
    expect(commitRow(html, "c4")).toContain('href="https://github.com/acme/alpha/commit/c4"');
  });

  it("PR を持つ行が GitHub の PR ページを指す", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    expect(commitRow(html, "c1")).toContain('href="https://github.com/acme/alpha/pull/1"');
    expect(commitRow(html, "c1")).toContain("#1");
  });

  it("デプロイの行も GitHub を指す（default_branch では対象コミットのページ）", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    expect(html).toContain('href="https://github.com/acme/alpha/commit/d1"');
    expect(html).toContain("コミットのページへ");
  });

  it("workflow_run ルールではワークフロー実行のページを指す", async () => {
    const scope = testScope({
      id: "alpha",
      deployRule: { name: "workflow_run", workflow: "deploy.yml" },
    });
    seedAlpha(db, scope);

    const response = await createApp({
      config: TEST_CONFIG,
      db,
      scopes: [scope],
      now: () => NOW,
    }).request(detailPath("deploy-frequency"));
    const html = await response.text();

    expect(html).toContain('href="https://github.com/acme/alpha/actions/runs/');
    expect(html).toContain("ワークフロー実行のページへ");
  });
});

describe("3 階層目を作らない（個別イベントの自前詳細画面を持たない）", () => {
  it("アプリ内リンクはサマリと指標詳細だけで、個別イベントの URL が存在しない", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    const allowed =
      /^(\/|https:\/\/github\.com\/|\/scopes\/[^/?]+(\?[^"]*)?$|\/scopes\/[^/?]+\/metrics\/(deploy-frequency|lead-time)(\?[^"]*)?$)/;
    for (const href of hrefsOf(html)) {
      expect(allowed.test(href), `想定外のリンク先が増えている: ${href}`).toBe(true);
    }

    // 3 階層目を作るならこうなる、という形の URL が 1 本も無いこと。
    for (const href of hrefsOf(html).filter((value) => !value.startsWith("https://"))) {
      expect(href).not.toMatch(/\/(commits?|deployments?|events?|pulls?)\//);
    }
  });
});

describe("3 区間内訳（コミット → PR open → merge → デプロイ）", () => {
  it("PR を経由したコミットは 3 区間の値を出す", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);
    const row = commitRow(html, "c1");

    expect(row).toContain('data-testid="breakdown-commit-to-pr-open"');
    expect(row).toContain('data-testid="breakdown-pr-open-to-merge"');
    expect(row).toContain('data-testid="breakdown-merge-to-deploy"');
    // c1: コミット 08-10T02:00 → PR open 03:00（1.0h）→ merge 08-11T03:00（24.0h）
    //     → デプロイ 08-12T02:00（23.0h）
    expect(row).toContain("1.0 時間");
    expect(row).toContain("24.0 時間");
    expect(row).toContain("23.0 時間");
  });

  it("PR を経由しないコミットは 0 ではなく「なし」と出す（#18）", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);
    const row = commitRow(html, "c4");

    expect(row).toContain('data-testid="breakdown-absent"');
    expect(row).toContain("なし（PR を経由していないコミット）");
    // **ここが要点。** 0 で埋めると「0 秒でレビューされた PR」が実在したように読める。
    expect(row).not.toContain("0.0 時間");
    expect(row).not.toContain('data-testid="breakdown-pr-open-to-merge"');
  });

  it("PR には当たるが時刻の順序が合わないコミットも「なし」と出す", async () => {
    seedAlpha(db);
    const row = commitRow(await detailHtml(db), "d1");

    expect(row).toContain('data-testid="breakdown-absent"');
    expect(row).toContain("PR の時刻が区間の順序と合わない");
  });

  it("週次の内訳チャートと、選択週の内訳の両方を出す", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    expect(html).toContain("リードタイムの 3 区間内訳");
    expect(html).toContain('data-testid="week-lead-time-breakdown"');
    expect(html).toMatch(/data-testid="week-lead-time-breakdown"[^>]*>[^<]*コミット → PR open/);
  });
});

describe("収集状態とデプロイ検出ルールを詳細画面でも常時出す", () => {
  it("収集状態（最終収集成功・バックフィル進捗）が出る", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    expect(html).toContain('data-testid="collection-status"');
    expect(html).toContain("2026-09-17 15:00 JST");
    expect(html).toContain("バックフィル進捗");
  });

  it("デプロイ検出ルールの説明が出る", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    expect(html).toContain('data-testid="deploy-rule"');
    expect(html).toContain("このスコープは「デフォルトブランチへの merge＝デプロイ」");
  });

  it("どちらもデプロイ頻度側の詳細でも出る", async () => {
    seedAlpha(db);
    const html = await detailHtml(db, "deploy-frequency");

    expect(html).toContain('data-testid="collection-status"');
    expect(html).toContain('data-testid="deploy-rule"');
  });
});

describe("標本から外れたものを隠さない", () => {
  it("compare が打ち切られたデプロイを出す（#18）", async () => {
    seedScope(db, {
      scope: ALPHA,
      deployments: [
        { sha: "d0", deployedAt: BASE_DEPLOY },
        { sha: "d1", deployedAt: DEPLOY_1, commitShas: ["c1"], truncated: true },
      ],
      commits: [
        { sha: "c1", committedAt: "2026-08-10T02:00:00Z" },
        { sha: "d1", committedAt: DEPLOY_1 },
      ],
      cursor: { backfilledUntil: BACKFILLED_UNTIL, lastSuccessAt: LAST_SUCCESS_AT },
    });

    const html = await detailHtml(db);

    expect(html).toContain('data-testid="exclusion-truncated"');
    expect(html).toMatch(/data-testid="exclusion-truncated"[^>]*>1 件/);
    expect(html).toContain("差分が打ち切られています");
  });

  it("コミットが見つからない SHA を出す", async () => {
    seedScope(db, {
      scope: ALPHA,
      deployments: [
        { sha: "d0", deployedAt: BASE_DEPLOY },
        { sha: "d1", deployedAt: DEPLOY_1, commitShas: ["c1", "missing-sha"] },
      ],
      commits: [
        { sha: "c1", committedAt: "2026-08-10T02:00:00Z" },
        { sha: "d1", committedAt: DEPLOY_1 },
      ],
      cursor: { backfilledUntil: BACKFILLED_UNTIL, lastSuccessAt: LAST_SUCCESS_AT },
    });

    const html = await detailHtml(db);

    expect(html).toContain('data-testid="exclusion-unknown"');
    expect(html).toContain("missing-sha");
  });

  it("収集カバレッジと標本数を出して「なぜ値が出ないか」に答える", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    expect(html).toContain('data-testid="exclusion-note"');
    expect(html).toContain('data-testid="exclusion-coverage"');
    expect(html).toContain('data-testid="exclusion-sample-count"');
    expect(html).toContain('data-testid="exclusion-orphan"');
  });

  it("収集がカバーしていない週ではその旨を出す", async () => {
    seedAlpha(db);
    // バックフィルは 2026-06-01 まで。それより前の週はデータが無い。
    const html = await detailHtml(db, "deploy-frequency", "2026-04-06");

    expect(html).toContain("収集がカバーしていません");
    expect(html).toContain("デプロイが無かったという意味ではありません");
  });
});

describe("サマリへ戻る導線と週の切り替え", () => {
  it("サマリへのリンクが期間を保つ", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);
    expect(html).toContain('href="/scopes/alpha?weeks=26"');
  });

  it("前後の週へ移れる", async () => {
    seedAlpha(db);
    const html = await detailHtml(db);

    expect(html).toContain('data-testid="week-switcher"');
    expect(html).toContain("2026-08-03&amp;weeks=26");
    expect(html).toContain("2026-08-17&amp;weeks=26");
  });
});

describe("合算・ランキング・目標値を出さない（README のアンチパターン）", () => {
  it("他スコープの数値も目標値もこの画面に現れない", async () => {
    seedAlpha(db);
    seedScope(db, {
      scope: testScope({ id: "beta", repo: "beta" }),
      deployments: [
        { sha: "b1", deployedAt: DEPLOY_1 },
        { sha: "b2", deployedAt: DEPLOY_2 },
      ],
      cursor: { backfilledUntil: BACKFILLED_UNTIL, lastSuccessAt: LAST_SUCCESS_AT },
    });

    const html = await detailHtml(db);

    expect(html).toContain("2 回");
    expect(html).not.toContain("b1");
    expect(html).not.toContain("/scopes/beta");
    // 目標値・達成度・順位はどこにも出さない（「目標 365 日」はバックフィルの進捗で、
    // 指標の目標値ではない。だから文字列 "目標" ではなく評価の語で確かめる）。
    expect(html).not.toContain("達成");
    expect(html).not.toContain("目標値は");
    expect(html).toContain("このアプリは目標値を提示しません");
  });
});

describe("URL の誤りを空白として見せない", () => {
  it("週開始日でない week は 400", async () => {
    seedAlpha(db);
    const response = await app(db).request("/scopes/alpha/metrics/lead-time?week=2026-08-11");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("JST 月曜始まりの週開始日");
  });

  it("日付ですらない week も 400", async () => {
    seedAlpha(db);
    const response = await app(db).request("/scopes/alpha/metrics/lead-time?week=last");
    expect(response.status).toBe(400);
  });

  it("期間の外の week は 400", async () => {
    seedAlpha(db);
    const response = await app(db).request("/scopes/alpha/metrics/lead-time?week=2020-01-06");
    expect(response.status).toBe(400);
  });

  it("week 未指定なら期間の最終週を出す（落とさない）", async () => {
    seedAlpha(db);
    const response = await app(db).request("/scopes/alpha/metrics/lead-time");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`${weekOf(NOW).key} の週`);
  });

  it("知らない指標は 404", async () => {
    seedAlpha(db);
    const response = await app(db).request(
      `/scopes/alpha/metrics/change-fail-rate?week=${TARGET_WEEK}`,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("知らない指標です");
  });

  it("未登録のスコープは 404（空の詳細を返さない）", async () => {
    seedAlpha(db);
    const response = await app(db).request(`/scopes/unknown/metrics/lead-time?week=${TARGET_WEEK}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("scopes.toml");
  });

  it("選べない期間は 400", async () => {
    seedAlpha(db);
    const response = await app(db).request(
      `/scopes/alpha/metrics/lead-time?week=${TARGET_WEEK}&weeks=9999`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("選べません");
  });
});

describe("チャートの欠損週の文言（#20 からの申し送り）", () => {
  it("デプロイ頻度の空白を「標本不足」と説明しない", async () => {
    seedAlpha(db);
    const html = await detailHtml(db, "deploy-frequency");

    expect(html).toContain("収集がその週の全体に届いていない");
    expect(html).toContain("0 件だった週は欠損ではなく 0 として点を打っています");
    expect(html).not.toContain("データ点が少ない");
  });

  it("リードタイムの空白は標本不足と収集の穴の両方を挙げる", async () => {
    seedAlpha(db);
    const html = await detailHtml(db, "lead-time");

    expect(html).toContain("標本（コミット）が 3 件未満の週");
    expect(html).toContain("収集がその週の全体に届いていない週（ADR-0007）");
  });
});
