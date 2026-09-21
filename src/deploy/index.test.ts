import { describe, expect, it } from "vitest";
import { fakeGitHubClient } from "../collector/testing.ts";
import { listDeployments, saveCommit } from "../db/store.ts";
import { openTestDatabase } from "../db/testing.ts";
import type { Scope } from "../scopes.ts";
import { createDeployDetection, deployRuleKey } from "./index.ts";

const WINDOW = { since: "2026-09-01T00:00:00Z", until: "2026-09-20T00:00:00Z" };

function scope(deployRule: Scope["deployRule"]): Scope {
  return { id: "sample-app", owner: "acme", repo: "sample-app", deployRule, backfillDays: 365 };
}

describe("デプロイ検出ルールのルールキー", () => {
  it("default_branch は粒度まで含む", () => {
    expect(deployRuleKey({ name: "default_branch", granularity: "merge_only" })).toBe(
      "default_branch:merge_only",
    );
    expect(deployRuleKey({ name: "default_branch", granularity: "all_pushes" })).toBe(
      "default_branch:all_pushes",
    );
  });

  it("workflow_run は対象ワークフローまで含む", () => {
    expect(deployRuleKey({ name: "workflow_run", workflow: "deploy.yml" })).toBe(
      "workflow_run:deploy.yml",
    );
  });
});

describe("デプロイ検出ルールのディスパッチ", () => {
  it("default_branch では窓ごとに外部 API を叩かず、保存済みのコミットから確定させる", async () => {
    const db = openTestDatabase();
    const client = fakeGitHubClient();
    for (const [sha, parents] of [
      ["merge-1", ["p1", "p2"]],
      ["plain-1", ["p1"]],
    ] as const) {
      saveCommit(db, {
        scopeId: "sample-app",
        sha,
        committedAt: "2026-09-10T00:00:00Z",
        authoredAt: "2026-09-10T00:00:00Z",
        message: sha,
        raw: { parents: parents.map((p) => ({ sha: p })) },
      });
    }

    const detection = createDeployDetection(
      db,
      client,
      scope({ name: "default_branch", granularity: "merge_only" }),
    );
    await detection.collectWindow(WINDOW);

    // 窓の時点では外部 API を一切叩かず、デプロイもまだ無い。
    expect(client.calls.workflowRuns).toEqual([]);
    expect(listDeployments(db, "sample-app", detection.ruleKey)).toEqual([]);

    await detection.finalize();

    expect(listDeployments(db, "sample-app", detection.ruleKey).map((d) => d.commitSha)).toEqual([
      "merge-1",
    ]);
  });

  it("workflow_run では窓ごとにワークフロー実行を取り、成功実行だけをデプロイにする", async () => {
    const db = openTestDatabase();
    const client = fakeGitHubClient({
      workflowRuns: [
        {
          id: 1,
          headSha: "sha-ok",
          path: "deploy.yml",
          conclusion: "success",
          completedAt: "2026-09-10T00:00:00Z",
        },
        {
          id: 2,
          headSha: "sha-ng",
          path: "deploy.yml",
          conclusion: "failure",
          completedAt: "2026-09-11T00:00:00Z",
        },
        {
          id: 3,
          headSha: "sha-out",
          path: "deploy.yml",
          conclusion: "success",
          completedAt: "2026-08-01T00:00:00Z",
        },
      ],
    });

    const detection = createDeployDetection(
      db,
      client,
      scope({ name: "workflow_run", workflow: "deploy.yml" }),
    );
    await detection.collectWindow(WINDOW);
    await detection.finalize();

    expect(client.calls.workflowRuns[0]).toMatchObject({
      workflow: "deploy.yml",
      created: `${WINDOW.since}..${WINDOW.until}`,
    });
    expect(listDeployments(db, "sample-app", detection.ruleKey).map((d) => d.commitSha)).toEqual([
      "sha-ok",
    ]);
  });
});
