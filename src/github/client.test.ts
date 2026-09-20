import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { patAuth } from "./auth.ts";
import {
  createGitHubClient,
  type GitHubClient,
  GitHubError,
  GitHubRateLimitError,
  GitHubRequestError,
} from "./client.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

const REPO = { owner: "ymiyamoto63", repo: "four-keys-metrics-viewer" };
const TOKEN = "github_pat_0123456789";

type FakeResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** JSON ではない本文（エラーページなど）を返したいとき。 */
  text?: string;
};

type Call = { url: string; headers: Record<string, string> };

function fakeGitHub(responses: FakeResponse[]): { client: GitHubClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const response = responses[calls.length - 1];
    if (response === undefined) {
      throw new Error(`テストが用意していないリクエストが飛んだ: ${String(input)}`);
    }
    return new Response(response.text ?? JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: response.headers,
    });
  };

  return {
    client: createGitHubClient({ auth: patAuth(TOKEN), fetch: fetchImpl }),
    calls,
  };
}

async function collect<T>(items: AsyncGenerator<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of items) {
    collected.push(item);
  }
  return collected;
}

describe("認証", () => {
  it("PAT を Authorization ヘッダに載せ、API バージョンを明示する", async () => {
    const { client, calls } = fakeGitHub([{ body: [] }]);

    await collect(client.listCommits(REPO));

    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(calls[0]?.headers.Accept).toBe("application/vnd.github+json");
  });

  it("空の PAT は client を作る前に弾く", () => {
    expect(() => patAuth("")).toThrow(/GITHUB_TOKEN/);
  });
});

describe("ページング", () => {
  const page = (url: string): Record<string, string> => ({ link: `<${url}>; rel="next"` });

  it('Link ヘッダの rel="next" を辿り、全ページを 1 本の列として返す', async () => {
    const { client, calls } = fakeGitHub([
      {
        body: [fixture("commit")],
        headers: page("https://api.github.com/repos/o/r/commits?page=2"),
      },
      { body: [fixture("merge_commit")] },
    ]);

    const commits = await collect(client.listCommits(REPO));

    expect(commits).toHaveLength(2);
    expect(commits[1]?.parentShas).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://api.github.com/repos/o/r/commits?page=2");
  });

  it("呼び出し側が途中で打ち切ったら、次のページを取りに行かない", async () => {
    const { client, calls } = fakeGitHub([
      {
        body: [fixture("commit")],
        headers: page("https://api.github.com/repos/o/r/commits?page=2"),
      },
    ]);

    for await (const _commit of client.listCommits(REPO)) {
      break;
    }

    expect(calls).toHaveLength(1);
  });

  it("Link ヘッダが別オリジンを指していたら、PAT を載せて辿らない", async () => {
    const { client, calls } = fakeGitHub([
      { body: [fixture("commit")], headers: page("https://evil.example.com/repos/o/r/commits") },
    ]);

    await expect(collect(client.listCommits(REPO))).rejects.toBeInstanceOf(GitHubError);
    expect(calls).toHaveLength(1);
  });
});

describe("レート制限", () => {
  it("残数 0 の 403 では、待機せずその場で中断する", async () => {
    const { client, calls } = fakeGitHub([
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1789000000" },
        body: { message: "API rate limit exceeded" },
      },
    ]);

    const startedAt = Date.now();
    const error = await collect(client.listCommits(REPO)).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt).toBe("2026-09-10T00:26:40.000Z");
    // 待機もリトライもしない。次の収集サイクルに委ねる（ADR-0007）。
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(calls).toHaveLength(1);
  });

  it("二次レート制限（429 + retry-after）も同じ扱いにする", async () => {
    const { client } = fakeGitHub([{ status: 429, headers: { "retry-after": "60" } }]);

    const error = await collect(client.listCommits(REPO)).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).retryAfterSeconds).toBe(60);
  });

  it("ヘッダが壊れていても、レート制限の判定自体は成立する", async () => {
    const { client } = fakeGitHub([
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "not-a-number" },
      },
    ]);

    const error = await collect(client.listCommits(REPO)).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt).toBeNull();
  });

  it("残数が残っている 403 は権限の問題として扱い、レート制限と混同しない", async () => {
    const { client } = fakeGitHub([
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "4321" },
        body: { message: "Resource not accessible by personal access token" },
      },
    ]);

    const error = await collect(client.listCommits(REPO)).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GitHubRequestError);
    expect(error).not.toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRequestError).status).toBe(403);
  });
});

describe("失敗の分類", () => {
  it("404 は PAT から見えていない可能性を示す", async () => {
    const { client } = fakeGitHub([{ status: 404, body: { message: "Not Found" } }]);

    const error = await collect(client.listCommits(REPO)).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GitHubRequestError);
    expect((error as GitHubRequestError).status).toBe(404);
    expect((error as Error).message).toContain("private");
  });

  it("401 は PAT の期限切れを疑えるメッセージにする", async () => {
    const { client } = fakeGitHub([{ status: 401, body: { message: "Bad credentials" } }]);

    const error = await collect(client.listCommits(REPO)).catch((thrown: unknown) => thrown);

    expect((error as Error).message).toContain("期限切れ");
  });

  it("エラーメッセージに PAT を含めない", async () => {
    const { client } = fakeGitHub([{ status: 500, text: "internal error" }]);

    const error = await collect(client.listCommits(REPO)).catch((thrown: unknown) => thrown);

    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe("エンドポイントのラッパ", () => {
  it("コミットはブランチと期間で絞り込める", async () => {
    const { client, calls } = fakeGitHub([{ body: [] }]);

    await collect(
      client.listCommits(REPO, {
        branch: "main",
        since: "2025-09-20T00:00:00Z",
        until: "2026-09-20T00:00:00Z",
      }),
    );

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/repos/ymiyamoto63/four-keys-metrics-viewer/commits");
    expect(url.searchParams.get("sha")).toBe("main");
    expect(url.searchParams.get("since")).toBe("2025-09-20T00:00:00Z");
    expect(url.searchParams.get("per_page")).toBe("100");
  });

  it("プルリクエストは既定で closed を新しい順に取りに行く", async () => {
    const { client, calls } = fakeGitHub([{ body: [fixture("pull_request")] }]);

    const pulls = await collect(client.listPullRequests(REPO, { base: "main" }));

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/repos/ymiyamoto63/four-keys-metrics-viewer/pulls");
    expect(url.searchParams.get("state")).toBe("closed");
    expect(url.searchParams.get("base")).toBe("main");
    expect(url.searchParams.get("direction")).toBe("desc");
    expect(pulls[0]?.mergeCommitSha).toBeDefined();
  });

  it("ワークフロー実行は workflow_runs を取り出して返す", async () => {
    const { client, calls } = fakeGitHub([
      { body: { total_count: 1, workflow_runs: [{ id: 42, conclusion: "success" }] } },
    ]);

    const runs = await collect(
      client.listWorkflowRuns(REPO, { workflow: "deploy.yml", status: "success", branch: "main" }),
    );

    expect(runs).toEqual([{ id: 42, conclusion: "success" }]);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe(
      "/repos/ymiyamoto63/four-keys-metrics-viewer/actions/workflows/deploy.yml/runs",
    );
  });

  it("設定ファイル由来の値をそのままパスに載せない", async () => {
    const { client, calls } = fakeGitHub([{ body: [] }]);

    await collect(client.listCommits({ owner: "../../evil", repo: "r" }));

    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/repos/..%2F..%2Fevil/r/commits");
  });

  it("compare はコミット SHA 列と打ち切りの有無だけを返す", async () => {
    const { client, calls } = fakeGitHub([{ body: fixture("compare") }]);

    const compare = await client.compare(REPO, "base-sha", "head-sha");

    expect(new URL(calls[0]?.url ?? "").pathname).toBe(
      "/repos/ymiyamoto63/four-keys-metrics-viewer/compare/base-sha...head-sha",
    );
    expect(compare.commitShas.length).toBe(compare.totalCommits);
    expect(compare.truncated).toBe(false);
    expect(compare).not.toHaveProperty("files");
  });
});
