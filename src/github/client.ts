/**
 * GitHub REST API のクライアント。
 *
 * 責務は 3 つに限る。**認証**（`auth.ts` に委譲）、**ページング**、**失敗の分類**。
 * レスポンスから何を残すかは `project.ts`（`docs/raw-columns.md`）、
 * どこまで遡るかは収集ジョブ（#12）の担当で、ここでは決めない。
 *
 * ## レート制限では待機しない（#10 / ADR-0007）
 *
 * 認証済みの上限は 5,000 req/hour で、到達後の待機は最大 1 時間になりうる。
 * ADR-0007 の構成ではアプリがいつ停止されるか分からないため、長い `sleep` を抱えたまま
 * 落ちるより、その場で中断して次の収集サイクルに委ねるほうが安全である。
 * したがってここには一切の待機・リトライを置かない。
 */

import type { GitHubAuth } from "./auth.ts";
import {
  mergeComparePages,
  type ProjectedCommit,
  type ProjectedCompare,
  type ProjectedPullRequest,
  projectCommit,
  projectCompare,
  projectPullRequest,
} from "./project.ts";

export const GITHUB_API_BASE_URL = "https://api.github.com";

/** 1 ページあたりの件数。GitHub の上限が 100。 */
const PER_PAGE = 100;

const API_VERSION = "2022-11-28";
const USER_AGENT = "four-keys-metrics-viewer";

export type Repo = { owner: string; repo: string };

export class GitHubError extends Error {}

/**
 * レート制限に達した。**待機せずに中断する**ための合図であり、
 * 収集サイクル全体を止める（1 スコープの問題ではなく credential 全体の問題のため）。
 */
export class GitHubRateLimitError extends GitHubError {
  readonly url: string;
  /** 制限が回復する時刻。分かる場合のみ。 */
  readonly resetAt: string | null;
  /** 二次レート制限で GitHub が指定してくる待機秒数。分かる場合のみ。 */
  readonly retryAfterSeconds: number | null;

  constructor(url: string, resetAt: string | null, retryAfterSeconds: number | null) {
    super(
      `GitHub のレート制限に達したため中断する（待機せず次の収集サイクルに委ねる）: ${url}` +
        (resetAt === null ? "" : ` / 回復時刻 ${resetAt}`),
    );
    this.name = "GitHubRateLimitError";
    this.url = url;
    this.resetAt = resetAt;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * レート制限以外の失敗。**スコープ単位で分離する**対象であり、
 * これが出ても他スコープの収集は続行する（ADR-0006「PAT の権限設定ミスは収集失敗として現れる」）。
 */
export class GitHubRequestError extends GitHubError {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(
      `GitHub API が ${status} を返した（${describeStatus(status)}）: ${url}${body === "" ? "" : ` / ${body}`}`,
    );
    this.name = "GitHubRequestError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return "認証に失敗した。PAT が無効か期限切れの可能性がある";
    case 403:
      return "アクセスが拒否された。PAT の権限と対象リポジトリの選択を確認する";
    case 404:
      return "対象が見つからない。PAT から見えていない private リポジトリの可能性がある";
    default:
      return "リクエストが失敗した";
  }
}

export type GitHubClientOptions = {
  auth: GitHubAuth;
  baseUrl?: string;
  /** テストから差し替えるための継ぎ目。既定はグローバルの `fetch`。 */
  fetch?: typeof globalThis.fetch;
};

export type ListCommitsParams = {
  /** 対象ブランチ（GitHub 側の `sha` パラメータ）。省略時はデフォルトブランチ。 */
  branch?: string;
  /** ISO8601。この時刻以降のコミットに限る。 */
  since?: string;
  /** ISO8601。この時刻以前のコミットに限る。 */
  until?: string;
};

export type ListPullRequestsParams = {
  state?: "open" | "closed" | "all";
  /** マージ先ブランチ。 */
  base?: string;
  sort?: "created" | "updated" | "popularity" | "long-running";
  direction?: "asc" | "desc";
};

export type ListWorkflowRunsParams = {
  /** ワークフローのファイル名（例 `deploy.yml`）または ID。省略時はリポジトリの全実行。 */
  workflow?: string;
  branch?: string;
  status?: "success" | "failure" | "completed";
  /** GitHub の検索構文（例 `>=2025-09-20`）。 */
  created?: string;
};

export type GitHubClient = {
  listCommits(repo: Repo, params?: ListCommitsParams): AsyncGenerator<ProjectedCommit>;
  listPullRequests(
    repo: Repo,
    params?: ListPullRequestsParams,
  ): AsyncGenerator<ProjectedPullRequest>;
  /**
   * ワークフロー実行。射影は `workflow_run` ルール（#14）が決めるため、ここでは生のまま返す。
   */
  listWorkflowRuns(repo: Repo, params?: ListWorkflowRunsParams): AsyncGenerator<unknown>;
  /**
   * 2 つのデプロイの間の差分コミット集合（ADR-0004）。**全ページを辿って返す**（#15）。
   */
  compare(repo: Repo, base: string, head: string): Promise<ProjectedCompare>;
};

type Query = Record<string, string | number | undefined>;

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const baseUrl = options.baseUrl ?? GITHUB_API_BASE_URL;
  const origin = new URL(baseUrl).origin;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  function buildUrl(path: string, query: Query = {}): string {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async function request(url: string): Promise<Response> {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: await options.auth.authorization(),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": USER_AGENT,
      },
    });
    if (!response.ok) {
      throw await toError(response, url);
    }
    return response;
  }

  async function* paginate(
    startUrl: string,
    extract: (payload: unknown) => unknown[],
  ): AsyncGenerator<unknown> {
    let url: string | undefined = startUrl;
    while (url !== undefined) {
      const response = await request(url);
      const payload: unknown = await response.json();
      for (const item of extract(payload)) {
        yield item;
      }
      url = nextPageUrl(response, origin);
    }
  }

  return {
    async *listCommits(repo, params = {}) {
      const url = buildUrl(`/repos/${segment(repo.owner)}/${segment(repo.repo)}/commits`, {
        sha: params.branch,
        since: params.since,
        until: params.until,
        per_page: PER_PAGE,
      });
      for await (const item of paginate(url, asArray)) {
        yield projectCommit(item);
      }
    },

    async *listPullRequests(repo, params = {}) {
      const url = buildUrl(`/repos/${segment(repo.owner)}/${segment(repo.repo)}/pulls`, {
        state: params.state ?? "closed",
        base: params.base,
        sort: params.sort ?? "updated",
        direction: params.direction ?? "desc",
        per_page: PER_PAGE,
      });
      for await (const item of paginate(url, asArray)) {
        yield projectPullRequest(item);
      }
    },

    async *listWorkflowRuns(repo, params = {}) {
      const path =
        params.workflow === undefined
          ? `/repos/${segment(repo.owner)}/${segment(repo.repo)}/actions/runs`
          : `/repos/${segment(repo.owner)}/${segment(repo.repo)}/actions/workflows/${segment(params.workflow)}/runs`;
      const url = buildUrl(path, {
        branch: params.branch,
        status: params.status,
        created: params.created,
        per_page: PER_PAGE,
      });
      for await (const item of paginate(url, extractWorkflowRuns)) {
        yield item;
      }
    },

    async compare(repo, base, head) {
      const path = `/repos/${segment(repo.owner)}/${segment(repo.repo)}/compare/${segment(base)}...${segment(head)}`;

      // compare は 1 レスポンスあたり最大 250 コミットで打ち切られる。1 ページで済ませると、
      // 差分が大きいデプロイほど後ろのコミットが落ち、リードタイムの標本が黙って欠ける。
      // それは ADR-0004 が退けた「時刻順近似」と同じ壊れ方（長くかかったコミットほど
      // 集計から消える）なので、**`total_commits` に届くまで必ず続きを取る**（#15）。
      const pages: ProjectedCompare[] = [];
      let pageNumber = 1;
      let url: string | undefined = buildUrl(path, { per_page: PER_PAGE, page: pageNumber });

      while (url !== undefined) {
        const response = await request(url);
        const page = projectCompare(await response.json());
        pages.push(page);

        if (!mergeComparePages(pages).truncated) {
          break;
        }
        // 進まないページを受け取ったら止める。`total_commits` との食い違いが残っても
        // `truncated` が立ったまま返るので、欠けは呼び出し側から見える（黙って欠けない）。
        if (page.commitShas.length === 0) {
          break;
        }

        pageNumber += 1;
        // Link ヘッダがあればそれを辿る（他のエンドポイントと同じ扱い）。
        // 無い場合も `page` を自分で進める。ここで諦めると打ち切りがそのまま残るため。
        url =
          nextPageUrl(response, origin) ?? buildUrl(path, { per_page: PER_PAGE, page: pageNumber });
      }

      return mergeComparePages(pages);
    },
  };
}

/** 設定ファイル由来の owner / repo / ref をそのままパスに載せない。 */
function segment(value: string): string {
  return encodeURIComponent(value);
}

function asArray(payload: unknown): unknown[] {
  return payload as unknown[];
}

function extractWorkflowRuns(payload: unknown): unknown[] {
  return (payload as { workflow_runs?: unknown[] }).workflow_runs ?? [];
}

async function toError(response: Response, url: string): Promise<GitHubError> {
  const rateLimit = rateLimitError(response, url);
  if (rateLimit !== undefined) {
    return rateLimit;
  }
  return new GitHubRequestError(response.status, url, await readBody(response));
}

/**
 * レート制限かどうかを判定する。
 *
 * GitHub は一次レート制限を 403、二次レート制限を 429 で返す。どちらも権限エラーと
 * 同じステータスになりうるため、**残数ヘッダか `retry-after` の有無**で切り分ける。
 * ここを取り違えると、権限設定ミスで収集サイクル全体を止めてしまう。
 */
function rateLimitError(response: Response, url: string): GitHubRateLimitError | undefined {
  if (response.status !== 403 && response.status !== 429) {
    return undefined;
  }
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  if (remaining !== "0" && retryAfter === null) {
    return undefined;
  }
  // ヘッダは外部由来なので、壊れていても例外にしない。
  // ここで落ちると「レート制限で中断」が「原因不明の失敗」に化ける。
  const resetAt = epochSecondsToIso(response.headers.get("x-ratelimit-reset"));
  const retryAfterSeconds = toFiniteNumber(retryAfter);
  return new GitHubRateLimitError(url, resetAt, retryAfterSeconds);
}

function toFiniteNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function epochSecondsToIso(value: string | null): string | null {
  const seconds = toFiniteNumber(value);
  if (seconds === null) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** エラーメッセージに載せる本文。長いエラーページを丸ごと抱えないよう切り詰める。 */
async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}

const NEXT_LINK = /<([^>]+)>;\s*rel="next"/;

function nextPageUrl(response: Response, origin: string): string | undefined {
  const link = response.headers.get("link");
  if (link === null) {
    return undefined;
  }
  const next = NEXT_LINK.exec(link)?.[1];
  if (next === undefined) {
    return undefined;
  }
  // Link ヘッダは外部から与えられる値である。ここを無条件に辿ると、
  // 別ホストへ PAT を載せたリクエストを送ってしまう。出自を必ず確認する。
  if (new URL(next).origin !== origin) {
    throw new GitHubError(`Link ヘッダが別オリジンを指しているため追跡しない: ${next}`);
  }
  return next;
}
