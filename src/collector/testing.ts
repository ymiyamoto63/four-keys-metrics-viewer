/**
 * 収集ジョブのテスト用フェイク GitHub クライアント（#11）。
 *
 * **ネットワークには一切出ない。** 合成した履歴をメモリ上に持ち、`since` / `until` の
 * 絞り込みとページングの打ち切りを本物と同じ意味で再現する。ここが本物と同じ意味で
 * 動かないと、窓の分割（#12）や重ね取り（`follow.ts`）を検証したことにならない。
 *
 * 置き場所が `github/` ではなく `collector/` なのは、これが GitHub API の汎用フェイクではなく
 * **収集ジョブが使う 4 つの経路だけ**を再現したものだからである。
 */

import type {
  GitHubClient,
  ListCommitsParams,
  ListPullRequestsParams,
  ListWorkflowRunsParams,
  Repo,
} from "../github/client.ts";
import type { ProjectedCommit, ProjectedCompare, ProjectedPullRequest } from "../github/project.ts";

export type FakeCommit = {
  sha: string;
  committedAt: string;
  parentShas?: string[];
};

export type FakeWorkflowRun = {
  id: number;
  headSha: string;
  path: string;
  conclusion: string;
  completedAt: string;
};

export type FakeHistory = {
  commits?: FakeCommit[];
  pullRequests?: { number: number; createdAt: string; mergedAt?: string | null }[];
  workflowRuns?: FakeWorkflowRun[];
};

export type FakeGitHubClient = GitHubClient & {
  /** 呼び出しの記録。窓がそのまま渡っているかの検証に使う。 */
  readonly calls: {
    commits: ListCommitsParams[];
    pullRequests: ListPullRequestsParams[];
    workflowRuns: ListWorkflowRunsParams[];
    compare: { base: string; head: string }[];
  };
  /** 次の呼び出しで投げる例外を仕込む（レート制限による中断の再現）。 */
  failNext(error: Error): void;
};

export function fakeGitHubClient(history: FakeHistory = {}): FakeGitHubClient {
  const commits = [...(history.commits ?? [])].sort(byDescending((c) => c.committedAt));
  const pullRequests = [...(history.pullRequests ?? [])].sort(byDescending((p) => p.createdAt));
  const workflowRuns = [...(history.workflowRuns ?? [])].sort(byDescending((r) => r.completedAt));

  const calls: FakeGitHubClient["calls"] = {
    commits: [],
    pullRequests: [],
    workflowRuns: [],
    compare: [],
  };
  let pending: Error | undefined;

  function checkFailure(): void {
    if (pending !== undefined) {
      const error = pending;
      pending = undefined;
      throw error;
    }
  }

  return {
    calls,
    failNext(error: Error) {
      pending = error;
    },

    async *listCommits(_repo: Repo, params: ListCommitsParams = {}) {
      calls.commits.push(params);
      checkFailure();
      for (const commit of commits) {
        if (!withinWindow(commit.committedAt, params.since, params.until)) {
          continue;
        }
        yield projected(commit);
      }
    },

    async *listPullRequests(_repo: Repo, params: ListPullRequestsParams = {}) {
      calls.pullRequests.push(params);
      checkFailure();
      // 本物は `created` 降順を指定されたときだけこの順で返す（`events.ts` の打ち切りの前提）。
      for (const pr of pullRequests) {
        yield projectedPullRequest(pr);
      }
    },

    async *listWorkflowRuns(_repo: Repo, params: ListWorkflowRunsParams = {}) {
      calls.workflowRuns.push(params);
      checkFailure();
      const [since, until] = parseCreatedQuery(params.created);
      for (const run of workflowRuns) {
        if (!withinWindow(run.completedAt, since, until)) {
          continue;
        }
        yield {
          id: run.id,
          name: "deploy",
          path: `.github/workflows/${run.path}`,
          head_sha: run.headSha,
          status: "completed",
          conclusion: run.conclusion,
          run_attempt: 1,
          run_started_at: run.completedAt,
          created_at: run.completedAt,
          updated_at: run.completedAt,
          html_url: `https://github.com/o/r/actions/runs/${run.id}`,
        };
      }
    },

    async compare(_repo: Repo, base: string, head: string): Promise<ProjectedCompare> {
      calls.compare.push({ base, head });
      checkFailure();
      // base（排他）から head（包含）までのコミット。本物の compare と同じ範囲。
      const ascending = [...commits].reverse();
      const baseIndex = ascending.findIndex((commit) => commit.sha === base);
      const headIndex = ascending.findIndex((commit) => commit.sha === head);
      const shas =
        baseIndex < 0 || headIndex < 0
          ? []
          : ascending.slice(baseIndex + 1, headIndex + 1).map((commit) => commit.sha);
      return { commitShas: shas, totalCommits: shas.length, truncated: false };
    },
  };
}

function byDescending<T>(key: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => Date.parse(key(b)) - Date.parse(key(a));
}

function withinWindow(at: string, since?: string, until?: string): boolean {
  const ms = Date.parse(at);
  if (since !== undefined && ms < Date.parse(since)) {
    return false;
  }
  if (until !== undefined && ms > Date.parse(until)) {
    return false;
  }
  return true;
}

/** `collectWorkflowRunDeployments` が組み立てる `created` 検索構文を読み戻す。 */
function parseCreatedQuery(created?: string): [string | undefined, string | undefined] {
  if (created === undefined) {
    return [undefined, undefined];
  }
  if (created.includes("..")) {
    const [since, until] = created.split("..");
    return [since, until];
  }
  if (created.startsWith(">=")) {
    return [created.slice(2), undefined];
  }
  return [undefined, created.slice(2)];
}

function projected(commit: FakeCommit): ProjectedCommit {
  const parents = (commit.parentShas ?? []).map((sha) => ({ sha }));
  const raw = {
    sha: commit.sha,
    html_url: `https://github.com/o/r/commit/${commit.sha}`,
    commit: {
      message: `commit ${commit.sha}`,
      author: { date: commit.committedAt },
      committer: { date: commit.committedAt },
    },
    parents,
  };
  return {
    sha: raw.sha,
    committedAt: commit.committedAt,
    authoredAt: commit.committedAt,
    message: raw.commit.message,
    parentShas: parents.map((parent) => parent.sha),
    htmlUrl: raw.html_url,
    raw,
  };
}

function projectedPullRequest(pr: {
  number: number;
  createdAt: string;
  mergedAt?: string | null;
}): ProjectedPullRequest {
  const raw = {
    number: pr.number,
    title: `PR #${pr.number}`,
    html_url: `https://github.com/o/r/pull/${pr.number}`,
    created_at: pr.createdAt,
    merged_at: pr.mergedAt ?? null,
    merge_commit_sha: pr.mergedAt == null ? null : `merge-${pr.number}`,
    head: { sha: `head-${pr.number}`, ref: `feature/${pr.number}` },
    base: { sha: `base-${pr.number}`, ref: "main" },
  };
  return {
    number: raw.number,
    title: raw.title,
    createdAt: raw.created_at,
    mergedAt: raw.merged_at,
    mergeCommitSha: raw.merge_commit_sha,
    headSha: raw.head.sha,
    baseSha: raw.base.sha,
    baseRef: raw.base.ref,
    htmlUrl: raw.html_url,
    raw,
  };
}
