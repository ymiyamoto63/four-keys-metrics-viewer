/**
 * 収集サイクルの結合テスト（#11 の完了条件）。
 *
 * GitHub クライアントはフェイク（`testing.ts`）で、**ネットワークには一切出ない**。
 * DB はインメモリの SQLite（`db/testing.ts`）で、マイグレーション適用済みのものを使う。
 */

import { describe, expect, it } from "vitest";
import type { Db } from "../db/index.ts";
import { findCollectionCursor, recordFollowProgress } from "../db/store.ts";
import { openTestDatabase } from "../db/testing.ts";
import { listDeploymentCommits } from "../deploy/assignment.ts";
import { deployRuleKey } from "../deploy/index.ts";
import {
  type GitHubClient,
  GitHubRateLimitError,
  GitHubRequestError,
  type ListCommitsParams,
  type Repo,
} from "../github/client.ts";
import type { Scope } from "../scopes.ts";
import { runCollection } from "./index.ts";
import { type FakeCommit, type FakeGitHubClient, fakeGitHubClient } from "./testing.ts";

const NOW = new Date("2026-09-20T06:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

const SCOPE: Scope = {
  id: "sample-app",
  owner: "acme",
  repo: "sample-app",
  deployRule: { name: "default_branch", granularity: "merge_only" },
  backfillDays: 30,
};

/**
 * 45 日分の合成履歴。3 日おきに merge commit、その間に通常のコミットを 1 つ置く。
 * merge commit が `merge_only` でのデプロイになる。
 */
function history(): FakeCommit[] {
  const commits: FakeCommit[] = [];
  for (let day = 0; day <= 45; day += 1) {
    const at = daysAgo(day);
    commits.push({ sha: `plain-${day}`, committedAt: at, parentShas: [`plain-${day + 1}`] });
    if (day % 3 === 0) {
      commits.push({
        sha: `merge-${day}`,
        committedAt: at,
        parentShas: [`plain-${day}`, `feature-${day}`],
      });
    }
  }
  return commits;
}

function pullRequests() {
  return [0, 3, 6, 40].map((day) => ({
    number: 100 + day,
    createdAt: daysAgo(day + 1),
    mergedAt: daysAgo(day),
  }));
}

function counts(db: Db): Record<string, number> {
  const table = (name: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
  return {
    commits: table("commits"),
    pullRequests: table("pull_requests"),
    deployEvents: table("deploy_events"),
    compareCache: table("compare_cache"),
    cursors: table("collection_cursors"),
  };
}

/** 30 日前まで収集済みで、そこから追いついていない DB を作る。 */
async function behindBy30Days(client: GitHubClient): Promise<Db> {
  const db = openTestDatabase();
  await collect(db, client);
  recordFollowProgress(db, SCOPE.id, daysAgo(30));
  return db;
}

function collect(db: Db, client: GitHubClient | undefined, scopes: Scope[] = [SCOPE]) {
  return runCollection({
    db,
    scopes,
    client,
    trigger: "startup",
    now: NOW,
    chunkDays: 10,
  });
}

describe("収集サイクル", () => {
  it("生イベントを取り込み、デプロイを検出してコミットを割り当てる", async () => {
    const db = openTestDatabase();
    const client = fakeGitHubClient({ commits: history(), pullRequests: pullRequests() });

    const outcome = await collect(db, client);

    expect(outcome.succeeded).toEqual([SCOPE.id]);
    expect(outcome.failed).toEqual([]);

    const after = counts(db);
    expect(after.commits).toBeGreaterThan(0);
    expect(after.pullRequests).toBeGreaterThan(0);
    expect(after.deployEvents).toBeGreaterThan(0);

    // 最古のデプロイ以外は差分コミットが割り当たっている（#15）。
    const assigned = listDeploymentCommits(db, SCOPE.id, deployRuleKey(SCOPE.deployRule));
    expect(assigned[0]?.status).toBe("oldest");
    expect(assigned.slice(1).every((deployment) => deployment.status === "assigned")).toBe(true);
    expect(assigned.slice(1).some((deployment) => deployment.commitShas.length > 0)).toBe(true);

    // 収集カーソルは「どこまで最新を追ったか」と「どこまで過去へ遡ったか」の両方を持つ。
    const cursor = findCollectionCursor(db, SCOPE.id);
    expect(cursor?.followedUntil).toBe(NOW.toISOString());
    expect(cursor?.backfillComplete).toBe(true);
    expect(cursor?.lastSuccessAt).not.toBeNull();
    expect(cursor?.lastError).toBeNull();
  });

  it("2 回連続で実行しても行数が増えない（冪等）", async () => {
    const db = openTestDatabase();
    const client = fakeGitHubClient({ commits: history(), pullRequests: pullRequests() });

    await collect(db, client);
    const first = counts(db);
    await collect(db, client);
    const second = counts(db);

    expect(second).toEqual(first);
  });

  it("30 日分の遅れがある状態から、中断・再開を挟んでも追いつける", async () => {
    const full = fakeGitHubClient({ commits: history(), pullRequests: pullRequests() });

    // 「前回の起動が 30 日前だった」状態の DB を 2 つ作る。片方は中断を挟んで、
    // もう片方は一度で追いつかせ、結果が一致することを確かめる。
    const db = await behindBy30Days(full);
    const reference = await behindBy30Days(full);

    // 1 サイクル目: 2 窓目でレート制限に当たって中断する。
    const firstOutcome = await collect(db, failAfterCommitCalls(full, 1));

    expect(firstOutcome.rateLimited).toBe(true);
    expect(firstOutcome.failed).toEqual([SCOPE.id]);
    expect(findCollectionCursor(db, SCOPE.id)?.lastError).toContain("レート制限");
    // 取り終えた窓の分だけは確定していて、現在時刻には届いていない。
    const midway = findCollectionCursor(db, SCOPE.id)?.followedUntil ?? "";
    expect(Date.parse(midway)).toBeGreaterThan(Date.parse(daysAgo(30)));
    expect(Date.parse(midway)).toBeLessThan(NOW.getTime());

    // 2 サイクル目: 続きから再開して追いつく。
    const secondOutcome = await collect(db, full);

    expect(secondOutcome.succeeded).toEqual([SCOPE.id]);
    expect(findCollectionCursor(db, SCOPE.id)?.followedUntil).toBe(NOW.toISOString());
    expect(findCollectionCursor(db, SCOPE.id)?.lastError).toBeNull();

    // 中断を挟んでも、一度で取り切った場合と同じ状態に落ち着く。
    await collect(reference, full);
    expect(counts(db)).toEqual(counts(reference));
  });

  it("GITHUB_TOKEN が未設定なら、黙って空振りさせず収集失敗として記録する", async () => {
    const db = openTestDatabase();

    const outcome = await collect(db, undefined);

    expect(outcome.failed).toEqual([SCOPE.id]);
    const cursor = findCollectionCursor(db, SCOPE.id);
    expect(cursor?.lastError).toContain("GITHUB_TOKEN");
    expect(cursor?.lastSuccessAt).toBeNull();
  });

  it("1 スコープが権限エラーで落ちても、他スコープは最後まで収集する", async () => {
    const db = openTestDatabase();
    const other: Scope = { ...SCOPE, id: "other-app", repo: "other-app" };
    const client = failingRepo(
      fakeGitHubClient({ commits: history(), pullRequests: pullRequests() }),
      "other-app",
    );

    const outcome = await collect(db, client, [other, SCOPE]);

    expect(outcome.failed).toEqual(["other-app"]);
    expect(outcome.succeeded).toEqual([SCOPE.id]);
    expect(findCollectionCursor(db, SCOPE.id)?.lastError).toBeNull();
  });

  it("workflow_run ルールのスコープではワークフロー実行からデプロイを検出する", async () => {
    const db = openTestDatabase();
    const scope: Scope = {
      ...SCOPE,
      deployRule: { name: "workflow_run", workflow: "deploy.yml" },
    };
    const client = fakeGitHubClient({
      commits: history(),
      workflowRuns: [
        {
          id: 1,
          headSha: "plain-2",
          path: "deploy.yml",
          conclusion: "success",
          completedAt: daysAgo(2),
        },
        {
          id: 2,
          headSha: "plain-9",
          path: "deploy.yml",
          conclusion: "success",
          completedAt: daysAgo(9),
        },
        {
          id: 3,
          headSha: "plain-5",
          path: "deploy.yml",
          conclusion: "failure",
          completedAt: daysAgo(5),
        },
      ],
    });

    await collect(db, client, [scope]);

    const assigned = listDeploymentCommits(db, scope.id, deployRuleKey(scope.deployRule));
    expect(assigned.map((deployment) => deployment.headSha)).toEqual(["plain-9", "plain-2"]);
    expect(assigned[1]?.status).toBe("assigned");
  });
});

/** 指定回数だけコミット取得を通し、それ以降はレート制限で落ちるクライアント。 */
function failAfterCommitCalls(client: FakeGitHubClient, allowed: number): GitHubClient {
  let seen = 0;
  return {
    ...client,
    async *listCommits(repo: Repo, params?: ListCommitsParams) {
      seen += 1;
      if (seen > allowed) {
        throw new GitHubRateLimitError(
          "https://api.github.com/repos/acme/sample-app/commits",
          null,
          null,
        );
      }
      yield* client.listCommits(repo, params);
    },
  };
}

/** 特定のリポジトリだけ 404 を返すクライアント（PAT の対象リポジトリ選択漏れの再現）。 */
function failingRepo(client: FakeGitHubClient, repoName: string): GitHubClient {
  return {
    ...client,
    async *listCommits(repo: Repo, params?: ListCommitsParams) {
      if (repo.repo === repoName) {
        throw new GitHubRequestError(
          404,
          `https://api.github.com/repos/${repo.owner}/${repo.repo}`,
          "",
        );
      }
      yield* client.listCommits(repo, params);
    },
  };
}
