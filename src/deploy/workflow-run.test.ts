import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discardDerivedData, listDeployments } from "../db/store.ts";
import { openTestDatabase } from "../db/testing.ts";
import type { GitHubClient, ListWorkflowRunsParams, Repo } from "../github/client.ts";
import {
  collectWorkflowRunDeployments,
  isDeployRun,
  projectWorkflowRun,
  type WorkflowRunScope,
  workflowRunRuleKey,
} from "./workflow-run.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

/** 実レスポンス（`GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs` の 1 件）。 */
function workflowRunFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, "workflow_run.json"), "utf8"));
}

/** 実レスポンスを土台に、テストで効かせたい項目だけ差し替える。 */
function runWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...workflowRunFixture(), ...overrides };
}

const SCOPE: WorkflowRunScope = {
  id: "sample",
  owner: "ymiyamoto63",
  repo: "sample-repo",
  deployRule: { name: "workflow_run", workflow: "deploy.yml" },
};

/**
 * フェイクのクライアント。ページ単位の配列を受け取り、`listWorkflowRuns` の
 * AsyncGenerator としてページを跨いで流す。ネットワークには一切出ない。
 */
function fakeClient(pages: unknown[][]): GitHubClient & {
  readonly calls: { repo: Repo; params: ListWorkflowRunsParams | undefined }[];
} {
  const calls: { repo: Repo; params: ListWorkflowRunsParams | undefined }[] = [];
  const notUsed = () => {
    throw new Error("workflow_run ルールはこの API を使わない");
  };
  return {
    calls,
    listCommits: notUsed,
    listPullRequests: notUsed,
    compare: notUsed,
    async *listWorkflowRuns(repo, params) {
      calls.push({ repo, params });
      for (const page of pages) {
        for (const run of page) {
          yield run;
        }
      }
    },
  };
}

describe("ワークフロー実行の射影", () => {
  it("正規化した項目を実レスポンスから取り出す", () => {
    const run = projectWorkflowRun(workflowRunFixture());

    expect(run.id).toBe(35484884080);
    expect(run.headSha).toBe("859b040cdc7b407a5937dee8af10ddcf79eeb195");
    expect(run.status).toBe("completed");
    expect(run.conclusion).toBe("success");
    expect(run.runStartedAt).toBe("2026-09-20T02:47:06Z");
    expect(run.workflowName).toBe("build-and-deploy");
    expect(run.workflowPath).toBe(".github/workflows/build_and_deploy.yml");
    expect(run.htmlUrl).toBe("https://github.com/vercel/next.js/actions/runs/35484884080");
  });

  it("完了時刻には updated_at を採る（レスポンスに完了時刻のフィールドが無いため）", () => {
    const run = projectWorkflowRun(workflowRunFixture());

    expect(run.completedAt).toBe("2026-09-20T02:54:14Z");
    // 開始時刻ではない。両者が同じだと、この区別が効いていない。
    expect(run.completedAt).not.toBe(run.runStartedAt);
  });

  it("run_started_at が無い古い実行では created_at で代用する", () => {
    const fixture = workflowRunFixture();
    delete fixture.run_started_at;

    expect(projectWorkflowRun(fixture).runStartedAt).toBe("2026-09-20T02:47:06Z");
  });

  it("raw には列挙した項目だけを残す", () => {
    const { raw } = projectWorkflowRun(workflowRunFixture());

    expect(Object.keys(raw).sort()).toEqual([
      "conclusion",
      "head_sha",
      "html_url",
      "id",
      "name",
      "path",
      "run_attempt",
      "run_started_at",
      "status",
      "updated_at",
    ]);
  });

  it("ユーザー情報を raw に持ち込まない", () => {
    const { raw } = projectWorkflowRun(workflowRunFixture()) as { raw: Record<string, unknown> };

    // 個人単位の集計を構造的に不可能にしておく（README のアンチパターン / docs/raw-columns.md）。
    expect(raw.actor).toBeUndefined();
    expect(raw.triggering_actor).toBeUndefined();
    expect(raw.head_commit).toBeUndefined();
    // 本アプリが一切使わない巨大な項目も持たない。
    expect(raw.repository).toBeUndefined();
    expect(raw.head_repository).toBeUndefined();
    expect(raw.pull_requests).toBeUndefined();
  });

  it("raw が生レスポンスより十分に小さい", () => {
    const original = JSON.stringify(workflowRunFixture()).length;
    const projected = JSON.stringify(projectWorkflowRun(workflowRunFixture()).raw).length;

    // 実測: 12,901 B → 350 B 前後。大半は repository / head_repository / 各種 *_url。
    expect(original).toBeGreaterThan(12000);
    expect(projected).toBeLessThan(500);
  });
});

describe("デプロイとみなす実行の判定", () => {
  it("conclusion が success の実行だけをデプロイとみなす", () => {
    expect(isDeployRun(projectWorkflowRun(runWith({ conclusion: "success" })))).toBe(true);

    for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "action_required"]) {
      expect(isDeployRun(projectWorkflowRun(runWith({ conclusion })))).toBe(false);
    }
  });

  it("未完了の実行（conclusion が null）はデプロイとみなさない", () => {
    const run = projectWorkflowRun(runWith({ status: "in_progress", conclusion: null }));

    expect(isDeployRun(run)).toBe(false);
  });
});

describe("デプロイ検出ルールの識別子", () => {
  it("対象ワークフローを含む", () => {
    expect(workflowRunRuleKey("deploy.yml")).toBe("workflow_run:deploy.yml");
  });

  it("ワークフローを差し替えると、古いワークフローで検出したデプロイが破棄される", async () => {
    const db = openTestDatabase();
    await collectWorkflowRunDeployments(db, fakeClient([[workflowRunFixture()]]), SCOPE);

    // 対象ワークフローが変われば、デプロイの集合そのものが変わる（ADR-0001）。
    // 識別子にワークフローが入っているので、discardDerivedData の破棄が効く。
    discardDerivedData(db, SCOPE.id, workflowRunRuleKey("release.yml"));

    expect(listDeployments(db, SCOPE.id, workflowRunRuleKey("deploy.yml"))).toHaveLength(0);
  });
});

describe("workflow_run ルールによるデプロイの収集", () => {
  it("成功した実行が 1 件ずつデプロイとして記録される", async () => {
    const db = openTestDatabase();
    const client = fakeClient([
      [
        runWith({ id: 1, head_sha: "a".repeat(40), updated_at: "2026-09-18T10:05:00Z" }),
        runWith({ id: 2, head_sha: "b".repeat(40), updated_at: "2026-09-19T10:05:00Z" }),
      ],
    ]);

    const result = await collectWorkflowRunDeployments(db, client, SCOPE);

    expect(result.examined).toBe(2);
    const deployments = listDeployments(db, SCOPE.id, workflowRunRuleKey("deploy.yml"));
    expect(deployments).toHaveLength(2);
    // デプロイ時刻は実行の完了時刻、commit_sha は実行の head SHA（#14）。
    expect(deployments.map((d) => [d.commitSha, d.deployedAt])).toEqual([
      ["a".repeat(40), "2026-09-18T10:05:00Z"],
      ["b".repeat(40), "2026-09-19T10:05:00Z"],
    ]);
  });

  it("対象ワークフローを GitHub 側にも渡す", async () => {
    const db = openTestDatabase();
    const client = fakeClient([[]]);

    await collectWorkflowRunDeployments(db, client, SCOPE, {
      since: "2026-09-01T00:00:00Z",
      until: "2026-09-20T00:00:00Z",
    });

    expect(client.calls).toEqual([
      {
        repo: { owner: "ymiyamoto63", repo: "sample-repo" },
        params: {
          workflow: "deploy.yml",
          branch: undefined,
          status: "completed",
          created: "2026-09-01T00:00:00Z..2026-09-20T00:00:00Z",
        },
      },
    ]);
  });

  it("失敗・キャンセルした実行はデプロイとして数えない", async () => {
    const db = openTestDatabase();
    const client = fakeClient([
      [
        runWith({ id: 1, head_sha: "a".repeat(40), conclusion: "failure" }),
        runWith({ id: 2, head_sha: "b".repeat(40), conclusion: "cancelled" }),
        runWith({ id: 3, head_sha: "c".repeat(40), conclusion: "skipped" }),
        runWith({ id: 4, head_sha: "d".repeat(40), status: "in_progress", conclusion: null }),
        runWith({ id: 5, head_sha: "e".repeat(40), conclusion: "success" }),
      ],
    ]);

    const result = await collectWorkflowRunDeployments(db, client, SCOPE);

    expect(result.examined).toBe(5);
    const deployments = listDeployments(db, SCOPE.id, workflowRunRuleKey("deploy.yml"));
    expect(deployments.map((d) => d.commitSha)).toEqual(["e".repeat(40)]);
  });

  it("同じ入力で 2 回流してもデプロイの行が増えない", async () => {
    const db = openTestDatabase();
    const pages = [
      [runWith({ id: 1, head_sha: "a".repeat(40) }), runWith({ id: 2, head_sha: "b".repeat(40) })],
    ];

    await collectWorkflowRunDeployments(db, fakeClient(pages), SCOPE);
    await collectWorkflowRunDeployments(db, fakeClient(pages), SCOPE);

    // 中断した窓は丸ごと取り直しになる（#12）。upsert なので行は重複しない。
    expect(listDeployments(db, SCOPE.id, workflowRunRuleKey("deploy.yml"))).toHaveLength(2);
  });

  it("同じコミットの再実行では行が増えず、デプロイ時刻だけが更新される", async () => {
    const db = openTestDatabase();
    const headSha = "a".repeat(40);

    await collectWorkflowRunDeployments(
      db,
      fakeClient([[runWith({ id: 1, head_sha: headSha, updated_at: "2026-09-19T10:05:00Z" })]]),
      SCOPE,
    );
    await collectWorkflowRunDeployments(
      db,
      fakeClient([
        [
          runWith({
            id: 1,
            head_sha: headSha,
            run_attempt: 2,
            updated_at: "2026-09-19T12:30:00Z",
          }),
        ],
      ]),
      SCOPE,
    );

    const deployments = listDeployments(db, SCOPE.id, workflowRunRuleKey("deploy.yml"));
    expect(deployments).toHaveLength(1);
    expect(deployments[0]?.deployedAt).toBe("2026-09-19T12:30:00Z");
  });

  it("ページを跨いだ実行もすべて処理する", async () => {
    const db = openTestDatabase();
    const page = (offset: number) =>
      Array.from({ length: 100 }, (_, index) => {
        const n = offset + index;
        return runWith({ id: n, head_sha: String(n).padStart(40, "0") });
      });
    const client = fakeClient([page(0), page(100), page(200)]);

    const result = await collectWorkflowRunDeployments(db, client, SCOPE);

    expect(result.examined).toBe(300);
    // 2 ページ目以降を取りこぼすと、古いデプロイが黙って欠ける。
    expect(listDeployments(db, SCOPE.id, workflowRunRuleKey("deploy.yml"))).toHaveLength(300);
  });

  it("他スコープのデプロイと混ざらない", async () => {
    const db = openTestDatabase();
    const pages = [[runWith({ id: 1, head_sha: "a".repeat(40) })]];

    await collectWorkflowRunDeployments(db, fakeClient(pages), SCOPE);
    await collectWorkflowRunDeployments(db, fakeClient(pages), { ...SCOPE, id: "other" });

    expect(listDeployments(db, SCOPE.id, workflowRunRuleKey("deploy.yml"))).toHaveLength(1);
    expect(listDeployments(db, "other", workflowRunRuleKey("deploy.yml"))).toHaveLength(1);
  });
});
