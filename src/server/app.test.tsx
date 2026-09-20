/**
 * サマリ画面（#20）のレンダリング結果を HTML 文字列として検査する。
 *
 * ここで固定しているのは見た目ではなく、**消えると指標が嘘をつく要素**である。
 *
 * - 収集状態（最終収集成功時刻・バックフィル進捗）は MVP の必須要件（ADR-0007 / #20）。
 *   将来これを削ると、このファイルのテストが落ちる
 * - デプロイ検出ルールの説明（ADR-0001 決定 5）
 * - 複数スコープを**合算しない**（`README.md` のアンチパターン）
 * - チャートの点のリンク先が #21 の URL 設計と一致すること
 *
 * DB は使うが（`db/testing.ts` のインメモリ）、ネットワークには出ない。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/index.ts";
import { openTestDatabase } from "../db/testing.ts";
import { weekOf } from "../metrics/week.ts";
import type { Scope } from "../scopes.ts";
import { createApp } from "./app.tsx";
import { seedScope, TEST_CONFIG, testScope } from "./testing.ts";
import { deployRuleSentence } from "./views/scope-notices.tsx";

/** 固定の「現在時刻」。2026-09-17（木）18:00 JST。 */
const NOW = new Date("2026-09-17T09:00:00Z");
const LAST_SUCCESS_AT = "2026-09-17T06:00:00Z";
const BACKFILLED_UNTIL = "2026-06-01T00:00:00Z";

/** デプロイを置く週（収集済み範囲の内側）。 */
const DEPLOY_1 = "2026-08-12T02:00:00Z";
const DEPLOY_2 = "2026-08-13T02:00:00Z";
const BASE_DEPLOY = "2026-08-05T02:00:00Z";
const TARGET_WEEK = weekOf(DEPLOY_1).key;

const ALPHA = testScope({ id: "alpha" });
const BETA = testScope({ id: "beta", repo: "beta" });

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

async function summaryHtml(db: Db, scopes: readonly Scope[] = [ALPHA], path = "/scopes/alpha") {
  const response = await app(db, scopes).request(path);
  expect(response.status).toBe(200);
  return await response.text();
}

let db: Db;

beforeEach(() => {
  db = openTestDatabase();
});

describe("収集状態の常時表示（MVP の必須要件 / ADR-0007）", () => {
  it("最終収集成功時刻とバックフィル進捗を出す", async () => {
    seedAlpha(db);
    const html = await summaryHtml(db);

    expect(html).toContain("収集状態");
    expect(html).toContain('data-testid="collection-status"');
    // 絶対時刻（JST 表記）と、どれくらい古いかの相対表現の両方を出す。
    expect(html).toContain("2026-09-17 15:00 JST");
    expect(html).toContain("約 3 時間前");
    expect(html).toContain("バックフィル進捗");
    expect(html).toContain("まで遡り済み");
    // 1 年を目標に 6/1 まで遡った状態。割合が出ていること。
    expect(html).toMatch(/data-backfill-percent="\d+"/);
  });

  it("一度も収集していないスコープでも節ごと消えない", async () => {
    // カーソルが無い = 収集を一度も試していない。ここで表示が消えると、
    // 「データが無い」と「収集していない」が画面上で区別できなくなる。
    seedScope(db, { scope: ALPHA, deployments: [] });
    const html = await summaryHtml(db);

    expect(html).toContain('data-testid="collection-status"');
    expect(html).toContain("まだ一度も成功していません");
    expect(html).toContain("未着手");
  });

  it("直前の収集失敗を出す（PAT 期限切れの検知手段 / #24）", async () => {
    seedScope(db, {
      scope: ALPHA,
      deployments: [],
      cursor: {
        backfilledUntil: BACKFILLED_UNTIL,
        lastSuccessAt: LAST_SUCCESS_AT,
        lastError: "GITHUB_TOKEN が未設定です",
      },
    });
    const html = await summaryHtml(db);

    expect(html).toContain('data-testid="collection-error"');
    expect(html).toContain("GITHUB_TOKEN が未設定です");
    expect(html).toContain("docs/operations.md");
  });
});

describe("デプロイ検出ルールの常時表示（ADR-0001 決定 5）", () => {
  it("default_branch / merge_only の文を出す", async () => {
    seedAlpha(db);
    const html = await summaryHtml(db);

    expect(html).toContain("このスコープは「デフォルトブランチへの merge＝デプロイ」");
    expect(html).toContain("default_branch / granularity = merge_only");
  });

  it("粒度とルールの種類が文から読み取れる", () => {
    expect(deployRuleSentence({ name: "default_branch", granularity: "merge_only" })).toContain(
      "merge＝デプロイ",
    );
    expect(deployRuleSentence({ name: "default_branch", granularity: "all_pushes" })).toContain(
      "全コミット",
    );
    expect(deployRuleSentence({ name: "workflow_run", workflow: "deploy.yml" })).toContain(
      "deploy.yml",
    );
  });
});

describe("スコープは 1 つずつ表示する（合算しない）", () => {
  it("他スコープのデプロイを足し込まない", async () => {
    seedAlpha(db);
    // beta には同じ週に 3 件。合算すると 5 件になる。
    seedScope(db, {
      scope: BETA,
      deployments: [
        { sha: "b1", deployedAt: DEPLOY_1 },
        { sha: "b2", deployedAt: DEPLOY_2 },
        { sha: "b3", deployedAt: "2026-08-14T02:00:00Z" },
      ],
      cursor: { backfilledUntil: BACKFILLED_UNTIL, lastSuccessAt: LAST_SUCCESS_AT },
    });

    const html = await summaryHtml(db, [ALPHA, BETA]);

    // チャートの点のツールチップは `<週> <系列名> <値><単位>`（chart.tsx）。
    expect(html).toContain(`${TARGET_WEEK} デプロイ数 2 回`);
    expect(html).not.toContain("デプロイ数 5");
    expect(html).not.toContain("デプロイ数 3");
  });

  it("切り替えはリンクだけで、他スコープの数値は出さない", async () => {
    seedAlpha(db);
    seedScope(db, {
      scope: BETA,
      deployments: [{ sha: "b1", deployedAt: DEPLOY_1 }],
      cursor: { backfilledUntil: BACKFILLED_UNTIL, lastSuccessAt: LAST_SUCCESS_AT },
    });

    const html = await summaryHtml(db, [ALPHA, BETA]);

    expect(html).toContain('data-testid="scope-switcher"');
    expect(html).toContain('href="/scopes/beta?weeks=26"');
    // 図は 2 つ（デプロイ頻度・リードタイム）だけ。スコープごとに増やさない＝横並び比較をしない。
    expect(html.match(/<figcaption>/g)).toHaveLength(2);
    expect(html).not.toContain("/scopes/beta/metrics/");
  });
});

describe("チャートの点から指標詳細（#21）へ遷移できる", () => {
  it("点のリンク先が #21 の URL 設計と一致する", async () => {
    seedAlpha(db);
    const html = await summaryHtml(db);

    expect(html).toContain(
      `href="/scopes/alpha/metrics/deploy-frequency?week=${TARGET_WEEK}&amp;weeks=26"`,
    );
    expect(html).toContain(
      `href="/scopes/alpha/metrics/lead-time?week=${TARGET_WEEK}&amp;weeks=26"`,
    );
  });

  it("そのリンク先が 404 にならない（#21 が入るまでの足場）", async () => {
    seedAlpha(db);
    const response = await app(db).request(
      `/scopes/alpha/metrics/lead-time?week=${TARGET_WEEK}&weeks=26`,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("変更のリードタイム");
    expect(html).toContain(TARGET_WEEK);
    expect(html).toContain('href="/scopes/alpha?weeks=26"');
  });

  it("知らない指標は 404", async () => {
    seedAlpha(db);
    const response = await app(db).request("/scopes/alpha/metrics/change-fail-rate");
    expect(response.status).toBe(404);
  });
});

describe("「収集済みで 0 件の週」と「収集がカバーしていない週」を区別する", () => {
  it("週ごとのカバレッジを数えて説明を添える", async () => {
    seedAlpha(db);
    const html = await summaryHtml(db);

    expect(html).toContain('data-testid="coverage-note"');
    // 収集済みでデプロイが無かった週は「本物の 0」として点を打つ。
    expect(html).toContain("デプロイ 0 件の週が");
    // 収集が届いていない週（2026-06-01 より前）は値なし。
    expect(html).toMatch(/収集がカバーしていない週[\s\S]*?データがありません/);
    expect(html).toContain("収集の途中の週");
  });
});

describe("期間の選択", () => {
  it("weeks で週数が変わる", async () => {
    seedAlpha(db);
    const html = await summaryHtml(db, [ALPHA], "/scopes/alpha?weeks=12");

    // x 軸の目盛り（`<line data-week>`）は「デプロイ頻度」「リードタイム」の 2 図ぶん出る。
    expect(html.match(/data-week="/g)?.length).toBeGreaterThanOrEqual(24);
    expect(html).toContain("12 週・JST");
    expect(html).toContain(`week=${TARGET_WEEK}&amp;weeks=12`);
  });

  it("選べない期間は 400 で止める（黙って既定へ落とさない）", async () => {
    seedAlpha(db);
    const response = await app(db).request("/scopes/alpha?weeks=9999");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("選べません");
  });
});

describe("経路", () => {
  it("/ は先頭スコープのサマリへ転送する", async () => {
    seedAlpha(db);
    const response = await app(db, [ALPHA, BETA]).request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/scopes/alpha?weeks=26");
  });

  it("知らないスコープは 404（空のサマリを返さない）", async () => {
    seedAlpha(db);
    const response = await app(db).request("/scopes/unknown");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("scopes.toml");
  });

  it("#19 の暫定プレビュー経路は残っていない", async () => {
    seedAlpha(db);
    const response = await app(db).request("/_preview/chart");
    expect(response.status).toBe(404);
  });

  it("/healthz は従来どおり", async () => {
    const response = await app(db).request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
