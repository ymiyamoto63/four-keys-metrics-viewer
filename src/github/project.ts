/**
 * GitHub API のレスポンスから、本アプリが使う項目だけを取り出す。
 *
 * ADR-0002 は「生レスポンスの**必要部分**を raw として残す」と決めたが、その線引きを
 * 定義していなかった。ここが線引きの唯一の場所であり、`docs/raw-columns.md` に対応表がある。
 *
 * 絞る理由は容量ではない（SQLite にディスク上限はない）。クエリ性能と、
 * 「この列は何のためにあるのか」が読んで分かる状態を保つためである。
 */

export type ProjectedCommit = {
  sha: string;
  committedAt: string;
  authoredAt: string;
  message: string;
  parentShas: string[];
  htmlUrl: string;
  raw: {
    sha: string;
    html_url: string;
    commit: { message: string; author: { date: string }; committer: { date: string } };
    parents: { sha: string }[];
  };
};

type CommitResponse = {
  sha: string;
  html_url: string;
  commit: { message: string; author: { date: string }; committer: { date: string } };
  parents: { sha: string }[];
};

export function projectCommit(response: unknown): ProjectedCommit {
  const commit = response as CommitResponse;

  // author / committer のユーザー情報（login, avatar, ...）は意図的に取り込まない。
  // 個人単位の集計を構造的に不可能にしておくため（README のアンチパターン）。
  const raw = {
    sha: commit.sha,
    html_url: commit.html_url,
    commit: {
      message: commit.commit.message,
      author: { date: commit.commit.author.date },
      committer: { date: commit.commit.committer.date },
    },
    parents: commit.parents.map((parent) => ({ sha: parent.sha })),
  };

  return {
    sha: raw.sha,
    // 変更のリードタイムの起点は committer date（author date は rebase でずれる。ADR-0004）。
    committedAt: raw.commit.committer.date,
    authoredAt: raw.commit.author.date,
    message: raw.commit.message,
    parentShas: raw.parents.map((parent) => parent.sha),
    htmlUrl: raw.html_url,
    raw,
  };
}

export type ProjectedPullRequest = {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headSha: string;
  baseSha: string;
  baseRef: string;
  htmlUrl: string;
  raw: {
    number: number;
    title: string;
    html_url: string;
    created_at: string;
    merged_at: string | null;
    merge_commit_sha: string | null;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
  };
};

type PullRequestResponse = {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
};

export function projectPullRequest(response: unknown): ProjectedPullRequest {
  const pr = response as PullRequestResponse;

  // user / merged_by は取り込まない（コミットと同じ理由）。
  // body・labels・統計（additions 等）・各種 *_url は本アプリが一切使わない。
  const raw = {
    number: pr.number,
    title: pr.title,
    html_url: pr.html_url,
    created_at: pr.created_at,
    // merged_at はデプロイ時刻には使わない（ADR-0001）。
    // 「PR open → merge」区間の内訳表示にのみ使う（ADR-0004）。
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    head: { sha: pr.head.sha, ref: pr.head.ref },
    base: { sha: pr.base.sha, ref: pr.base.ref },
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

export type ProjectedCompare = {
  commitShas: string[];
  totalCommits: number;
  /**
   * compare API は 1 レスポンスあたり最大 250 コミットしか返さない。
   * 取りこぼしたまま集計すると、リードタイムの標本が黙って欠ける。
   */
  truncated: boolean;
};

type CompareResponse = {
  total_commits: number;
  commits: { sha: string }[];
};

export function projectCompare(response: unknown): ProjectedCompare {
  const compare = response as CompareResponse;
  const commitShas = compare.commits.map((commit) => commit.sha);

  // files（レスポンスの約 8 割）は一切使わないので捨てる。
  return {
    commitShas,
    totalCommits: compare.total_commits,
    truncated: commitShas.length < compare.total_commits,
  };
}
