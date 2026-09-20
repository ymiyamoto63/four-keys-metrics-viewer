/**
 * 時間窓 1 つ分の生イベント（コミット / PR）の取得と保存（#11 / ADR-0002）。
 *
 * 「最新を追う収集」（`follow.ts`）と「過去へ遡る収集」（`backfill.ts`）の**両方が同じここを通る**。
 * 窓の決め方だけが違い、窓を渡されてからやることは同一である（`WindowCollection` の形）。
 *
 * 保存はすべて upsert（`store.ts`）なので、同じ窓を何度取っても行は増えない。
 * 窓が重なる設計（`follow.ts` の重ね取り、中断した窓の取り直し）はこれに依存している。
 */

import type { Db } from "../db/index.ts";
import { saveCommit, savePullRequest } from "../db/store.ts";
import type { GitHubClient, Repo } from "../github/client.ts";
import type { ProjectedPullRequest } from "../github/project.ts";
import type { Scope } from "../scopes.ts";
import type { CollectionWindow } from "./window.ts";

export type RawEventScope = Pick<Scope, "id" | "owner" | "repo">;

export type EventCollectionResult = {
  commits: number;
  pullRequests: number;
};

/**
 * 窓の中のコミットと PR を取り、正規化して保存する。
 *
 * コミットはブランチを指定せずに取る。GitHub は `sha` 省略時にデフォルトブランチを返すため、
 * これが CONTEXT.md の言う「デフォルトブランチのコミット」になる。ブランチ名を設定に持たせて
 * いないのは、デフォルトブランチの変更（`master` → `main`）に設定の追随を要求しないためである。
 */
export async function collectWindowEvents(
  db: Db,
  client: GitHubClient,
  scope: RawEventScope,
  window: CollectionWindow,
): Promise<EventCollectionResult> {
  const repo: Repo = { owner: scope.owner, repo: scope.repo };
  const result: EventCollectionResult = { commits: 0, pullRequests: 0 };

  for await (const commit of client.listCommits(repo, {
    since: window.since,
    until: window.until,
  })) {
    saveCommit(db, {
      scopeId: scope.id,
      sha: commit.sha,
      // リードタイムの起点は committer date（ADR-0004）。射影の時点で選び分けてある。
      committedAt: commit.committedAt,
      authoredAt: commit.authoredAt,
      message: commit.message,
      raw: commit.raw,
    });
    result.commits += 1;
  }

  for await (const pr of listWindowPullRequests(client, repo, window)) {
    savePullRequest(db, {
      scopeId: scope.id,
      number: pr.number,
      title: pr.title,
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      mergeCommitSha: pr.mergeCommitSha,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      baseRef: pr.baseRef,
      htmlUrl: pr.htmlUrl,
      raw: pr.raw,
    });
    result.pullRequests += 1;
  }

  return result;
}

/**
 * 窓に入る PR だけを流す。
 *
 * ## なぜ作成時刻で窓を切るのか
 *
 * PR 一覧 API には `since` / `until` が無い（コミットと違う）。そのため窓に切るには
 * **並び順を決めて自分で打ち切る**しかない。`created` の降順で取れば、窓より古い PR に
 * 当たった時点で以降はすべて窓の外だと確定するので、そこでページングを止められる。
 * `updated` 降順だと、射影が `updated_at` を残していない（`docs/raw-columns.md`）ため
 * 同じ打ち切りができず、常に全件を辿ることになる。
 *
 * 窓より前に作られた PR が窓の中でマージされた場合は、この窓では拾えない。
 * それを拾うのが `follow.ts` の重ね取り（既定 7 日）で、最新を追う収集は毎回
 * 直近 7 日分の PR を取り直す。`state: "all"` にしてあるのは、まだ開いている PR も
 * 行として置いておき、マージされたときに同じ行を upsert で更新するためである。
 */
async function* listWindowPullRequests(
  client: GitHubClient,
  repo: Repo,
  window: CollectionWindow,
): AsyncGenerator<ProjectedPullRequest> {
  // 文字列比較にしない。GitHub の `2026-09-20T06:00:00Z` と `toISOString()` の
  // `2026-09-20T06:00:00.000Z` は同じ時刻だが辞書順では一致しない。
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);

  for await (const pr of client.listPullRequests(repo, {
    state: "all",
    sort: "created",
    direction: "desc",
  })) {
    const createdAt = Date.parse(pr.createdAt);
    if (createdAt > until) {
      continue;
    }
    if (createdAt < since) {
      // created の降順なので、ここから先はすべて窓より古い。
      return;
    }
    yield pr;
  }
}
