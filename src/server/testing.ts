/**
 * 画面のテスト用の種データ（#20）。**ネットワークには一切出ない**（DB とメモリだけ）。
 *
 * 収集ジョブを回さずに「収集済みのスコープ」を作れるようにしてある。収集を通すと
 * GitHub API が要るうえ、カーソルの値（＝カバレッジ）をテストから固定できない。
 */

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import {
  saveCollectionCursor,
  saveCommit,
  saveCompareCache,
  saveDeployment,
  savePullRequest,
} from "../db/store.ts";
import { deployRuleKey } from "../deploy/index.ts";
import type { Scope } from "../scopes.ts";

export const TEST_CONFIG: Config = {
  host: "127.0.0.1",
  port: 3000,
  databasePath: "/tmp/four-keys-test.sqlite",
  scopesPath: "./scopes.toml",
  githubToken: "test-token",
  collectCron: "0 * * * *",
  collectOnStartup: false,
};

export function testScope(overrides: Partial<Scope> = {}): Scope {
  return {
    id: "alpha",
    owner: "acme",
    repo: "alpha",
    deployRule: { name: "default_branch", granularity: "merge_only" },
    backfillDays: 365,
    ...overrides,
  };
}

export type SeedDeployment = {
  sha: string;
  deployedAt: string;
  /** 直前のデプロイとの差分コミット。`undefined` なら compare 未取得（`pending`）にする。 */
  commitShas?: string[];
};

export type SeedOptions = {
  scope: Scope;
  deployments: SeedDeployment[];
  /** コミットの committer date。`deployments` の差分に現れる SHA はここに入れておく。 */
  commits?: { sha: string; committedAt: string }[];
  pullRequests?: {
    number: number;
    createdAt: string;
    mergedAt: string | null;
    mergeCommitSha: string | null;
    headSha: string;
  }[];
  /** 収集カーソル。省略すると「一度も収集していない」スコープになる。 */
  cursor?: {
    backfilledUntil: string | null;
    backfillComplete?: boolean;
    lastSuccessAt: string | null;
    lastError?: string | null;
  };
};

/** スコープ 1 つ分の生イベント・デプロイ・compare・収集カーソルを書き込む。 */
export function seedScope(db: Db, options: SeedOptions): void {
  const { scope } = options;
  const detectionRule = deployRuleKey(scope.deployRule);

  for (const commit of options.commits ?? []) {
    saveCommit(db, {
      scopeId: scope.id,
      sha: commit.sha,
      committedAt: commit.committedAt,
      authoredAt: commit.committedAt,
      message: `commit ${commit.sha}`,
      raw: {},
    });
  }

  for (const pr of options.pullRequests ?? []) {
    savePullRequest(db, {
      scopeId: scope.id,
      number: pr.number,
      title: `PR #${pr.number}`,
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      mergeCommitSha: pr.mergeCommitSha,
      headSha: pr.headSha,
      baseSha: "base",
      baseRef: "main",
      htmlUrl: `https://github.com/${scope.owner}/${scope.repo}/pull/${pr.number}`,
      raw: {},
    });
  }

  const ordered = [...options.deployments].sort((a, b) => a.deployedAt.localeCompare(b.deployedAt));
  for (const [index, deployment] of ordered.entries()) {
    saveDeployment(db, {
      scopeId: scope.id,
      detectionRule,
      commitSha: deployment.sha,
      deployedAt: deployment.deployedAt,
      raw: {},
    });
    const previous = ordered[index - 1];
    if (previous === undefined || deployment.commitShas === undefined) {
      continue;
    }
    saveCompareCache(db, {
      scopeId: scope.id,
      detectionRule,
      baseSha: previous.sha,
      headSha: deployment.sha,
      commitShas: deployment.commitShas,
      truncated: false,
    });
  }

  if (options.cursor !== undefined) {
    saveCollectionCursor(db, {
      scopeId: scope.id,
      backfilledUntil: options.cursor.backfilledUntil,
      backfillComplete: options.cursor.backfillComplete ?? false,
      followedUntil: options.cursor.lastSuccessAt,
      lastSuccessAt: options.cursor.lastSuccessAt,
      lastError: options.cursor.lastError ?? null,
    });
  }
}
