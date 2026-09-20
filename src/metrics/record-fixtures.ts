/**
 * 実際の GitHub API レスポンスを fixture として記録する（#16）。
 *
 *     npm run record:fixtures -- --owner ymiyamoto63 --repo four-keys-metrics-viewer \
 *       --since 2026-08-01T00:00:00Z --until 2026-09-20T00:00:00Z
 *
 * `.env` の `GITHUB_TOKEN`（read-only の fine-grained PAT）を使い、
 * `src/metrics/__fixtures__/recorded-responses.json` を上書きする。
 *
 * ## 置き場所の理由
 *
 * リポジトリ直下の `scripts/` ではなく `src/metrics/` に置いている。
 * `tsconfig.json` の `include` も `biome.json` の `files.includes` も `src` 配下だけを指しており、
 * 直下に `scripts/` を作ると **typecheck も lint も掛からない場所**ができる。
 * 記録するのは指標のための fixture なので、使う側（`fixtures.ts`）と同じ場所に置く。
 *
 * ## なぜ `github/client.ts` を使わないか
 *
 * クライアントは**射影済み**の値を返す（`ProjectedCommit` など）。fixture に要るのは
 * 射影前の生レスポンスである。射影後を記録したら、射影のテストが自分自身を検証することになる。
 * 認証は `github/auth.ts` を共有し、ここにはページングと書き出しだけを置く。
 *
 * ## 個人情報を記録しない
 *
 * 取得したレスポンスは必ず `fixtures.ts` のサニタイズを通してから書き出す
 * （`docs/raw-columns.md`: `user` / `author` / `committer` / `merged_by` を保存しない）。
 * 判定ロジックを `fixtures.ts` 側に置いてあるので、ネットワークに出なくても
 * `fixtures.test.ts` で検証できる。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { patAuth } from "../github/auth.ts";
import { GITHUB_API_BASE_URL } from "../github/client.ts";
import {
  FIXTURES_DIR,
  RECORDED_RESPONSES_NAME,
  type RecordedCompare,
  type RecordedResponses,
  sanitizeCommitResponse,
  sanitizeCompareResponse,
  sanitizePullRequestResponse,
} from "./fixtures.ts";

type Options = {
  owner: string;
  repo: string;
  since: string | undefined;
  until: string | undefined;
  /** 記録する compare の件数。連続するデプロイ候補の間で叩く。 */
  compares: number;
  out: string;
};

export function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    values.set(arg.slice(2), next !== undefined && !next.startsWith("--") ? next : "true");
  }

  const owner = values.get("owner");
  const repo = values.get("repo");
  if (owner === undefined || repo === undefined) {
    throw new Error("--owner と --repo は必須です");
  }
  const compares = Number(values.get("compares") ?? "1");
  if (!Number.isInteger(compares) || compares < 0) {
    throw new Error(`--compares は 0 以上の整数である必要があります: ${values.get("compares")}`);
  }
  return {
    owner,
    repo,
    since: values.get("since"),
    until: values.get("until"),
    compares,
    out: values.get("out") ?? RECORDED_RESPONSES_NAME,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  try {
    // Node 22 の組み込み。dotenv を足さないために使う。
    process.loadEnvFile(".env");
  } catch {
    // .env が無くてもよい（CI や、環境変数を直接渡す場合）。
  }
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token.trim() === "") {
    throw new Error("GITHUB_TOKEN が未設定です（.env に read-only の fine-grained PAT を書く）");
  }
  const auth = patAuth(token);

  async function get(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<unknown> {
    const url = new URL(`${GITHUB_API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    const response = await fetch(url, {
      headers: {
        Authorization: await auth.authorization(),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "four-keys-metrics-viewer",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API が ${response.status} を返した: ${url.toString()}`);
    }
    return await response.json();
  }

  const base = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  const commits = (await get(`${base}/commits`, {
    since: options.since,
    until: options.until,
    per_page: "100",
  })) as { sha: string }[];
  const pullRequests = (await get(`${base}/pulls`, {
    state: "closed",
    base: "main",
    per_page: "100",
  })) as unknown[];

  // 連続するコミットの間で compare を叩く。どの 2 デプロイ間かは fixture を使う側
  // （`MetricsInputSpec.deployShas`）が決めるので、ここでは新しい順に数本だけ記録する。
  const compares: RecordedCompare[] = [];
  for (let index = 0; index < options.compares && index + 1 < commits.length; index += 1) {
    const head = commits[index];
    const baseCommit = commits[index + 1];
    if (head === undefined || baseCommit === undefined) {
      break;
    }
    compares.push({
      baseSha: baseCommit.sha,
      headSha: head.sha,
      response: sanitizeCompareResponse(
        await get(`${base}/compare/${baseCommit.sha}...${head.sha}`),
      ),
    });
  }

  const recorded: RecordedResponses = {
    recordedAt: new Date().toISOString(),
    repo: { owner: options.owner, repo: options.repo },
    commits: commits.map(sanitizeCommitResponse),
    pullRequests: pullRequests.map(sanitizePullRequestResponse),
    compares,
  };

  const out = join(FIXTURES_DIR, `${options.out}.json`);
  writeFileSync(out, `${JSON.stringify(recorded, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${out} に記録しました（commits ${recorded.commits.length} / pulls ${recorded.pullRequests.length} / compares ${compares.length}）\n`,
  );
}

// import しただけでは走らせない（テストからサニタイズだけ使えるようにするため）。
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
