import { describe, expect, it } from "vitest";
import { listCommits, listPullRequests } from "../db/store.ts";
import { openTestDatabase } from "../db/testing.ts";
import { collectWindowEvents } from "./events.ts";
import { fakeGitHubClient } from "./testing.ts";

const SCOPE = { id: "sample-app", owner: "acme", repo: "sample-app" };
const WINDOW = { since: "2026-09-10T00:00:00Z", until: "2026-09-20T00:00:00Z" };

describe("窓 1 つ分の生イベント収集", () => {
  it("窓の中のコミットと PR だけを保存し、raw も残す", async () => {
    const db = openTestDatabase();
    const client = fakeGitHubClient({
      commits: [
        { sha: "in-1", committedAt: "2026-09-15T00:00:00Z", parentShas: ["in-2"] },
        { sha: "in-2", committedAt: "2026-09-11T00:00:00Z", parentShas: ["old-1"] },
        { sha: "old-1", committedAt: "2026-09-01T00:00:00Z", parentShas: [] },
      ],
      pullRequests: [
        { number: 3, createdAt: "2026-09-19T00:00:00Z", mergedAt: "2026-09-19T12:00:00Z" },
        { number: 2, createdAt: "2026-09-12T00:00:00Z", mergedAt: null },
        { number: 1, createdAt: "2026-09-02T00:00:00Z", mergedAt: "2026-09-03T00:00:00Z" },
      ],
    });

    const result = await collectWindowEvents(db, client, SCOPE, WINDOW);

    expect(result).toEqual({ commits: 2, pullRequests: 2 });
    expect(listCommits(db, SCOPE.id).map((commit) => commit.sha)).toEqual(["in-2", "in-1"]);
    expect(listPullRequests(db, SCOPE.id).map((pr) => pr.number)).toEqual([2, 3]);

    // ADR-0002 の「生レスポンスの必要部分を raw として残す」。
    expect(listCommits(db, SCOPE.id)[0]?.raw).toMatchObject({ sha: "in-2" });
    expect(listPullRequests(db, SCOPE.id)[0]?.raw).toMatchObject({ number: 2 });
  });

  it("PR は作成時刻の降順で取り、窓より古い PR に当たった時点でページングを打ち切る", async () => {
    const db = openTestDatabase();
    const client = fakeGitHubClient({
      pullRequests: [
        { number: 2, createdAt: "2026-09-12T00:00:00Z", mergedAt: null },
        { number: 1, createdAt: "2026-09-02T00:00:00Z", mergedAt: null },
      ],
    });

    await collectWindowEvents(db, client, SCOPE, WINDOW);

    expect(client.calls.pullRequests[0]).toMatchObject({
      state: "all",
      sort: "created",
      direction: "desc",
    });
  });

  it("同じ窓を 2 回取っても行は増えない（upsert）", async () => {
    const db = openTestDatabase();
    const client = fakeGitHubClient({
      commits: [{ sha: "in-1", committedAt: "2026-09-15T00:00:00Z", parentShas: [] }],
      pullRequests: [{ number: 1, createdAt: "2026-09-15T00:00:00Z", mergedAt: null }],
    });

    await collectWindowEvents(db, client, SCOPE, WINDOW);
    await collectWindowEvents(db, client, SCOPE, WINDOW);

    expect(listCommits(db, SCOPE.id)).toHaveLength(1);
    expect(listPullRequests(db, SCOPE.id)).toHaveLength(1);
  });

  it("コミットはブランチを指定せずに取る（デフォルトブランチ）", async () => {
    const db = openTestDatabase();
    const client = fakeGitHubClient({ commits: [] });

    await collectWindowEvents(db, client, SCOPE, WINDOW);

    expect(client.calls.commits[0]).toEqual({ since: WINDOW.since, until: WINDOW.until });
  });
});
