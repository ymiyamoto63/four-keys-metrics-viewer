import { describe, expect, it } from "vitest";
import type { Db } from "../db/index.ts";
import { findCompareCache, saveCommit, saveDeployment } from "../db/store.ts";
import { openTestDatabase } from "../db/testing.ts";
import type { Repo } from "../github/client.ts";
import type { ProjectedCompare } from "../github/project.ts";
import { assignCommitsToDeployments, listDeploymentCommits } from "./assignment.ts";

const REPO: Repo = { owner: "ymiyamoto63", repo: "four-keys-metrics-viewer" };
const SCOPE = "viewer";
const MERGE_ONLY = "default_branch:merge_only";
const ALL_PUSHES = "default_branch:all_pushes";

/**
 * compare だけを持つフェイク。**ネットワークには一切出ない**（ADR-0004 の検証方針）。
 * 差分は `base...head` をキーに与える。
 */
function fakeClient(diffs: Record<string, string[]>, truncated: string[] = []) {
  const calls: { base: string; head: string }[] = [];
  return {
    calls,
    client: {
      compare: (_repo: Repo, base: string, head: string): Promise<ProjectedCompare> => {
        calls.push({ base, head });
        const range = `${base}...${head}`;
        const commitShas = diffs[range] ?? [];
        const isTruncated = truncated.includes(range);
        return Promise.resolve({
          commitShas,
          totalCommits: isTruncated ? commitShas.length + 1 : commitShas.length,
          truncated: isTruncated,
        });
      },
    },
  };
}

function deploy(db: Db, detectionRule: string, commitSha: string, deployedAt: string): void {
  saveDeployment(db, { scopeId: SCOPE, detectionRule, commitSha, deployedAt, raw: {} });
}

describe("コミットのデプロイへの割り当て", () => {
  it("連続する 2 デプロイの差分を割り当て、compare_cache に保存する", async () => {
    const db = openTestDatabase();
    deploy(db, MERGE_ONLY, "d1", "2026-09-01T00:00:00Z");
    deploy(db, MERGE_ONLY, "d2", "2026-09-02T00:00:00Z");
    const { client, calls } = fakeClient({ "d1...d2": ["c1", "c2"] });

    const assigned = await assignCommitsToDeployments({
      db,
      client,
      repo: REPO,
      scopeId: SCOPE,
      detectionRule: MERGE_ONLY,
    });

    expect(calls).toEqual([{ base: "d1", head: "d2" }]);
    expect(assigned[1]).toMatchObject({
      headSha: "d2",
      baseSha: "d1",
      status: "assigned",
      commitShas: ["c1", "c2"],
    });
    expect(
      findCompareCache(db, {
        scopeId: SCOPE,
        detectionRule: MERGE_ONLY,
        baseSha: "d1",
        headSha: "d2",
      })?.commitShas,
    ).toEqual(["c1", "c2"]);
  });

  it("キャッシュがあれば API を叩かない", async () => {
    const db = openTestDatabase();
    deploy(db, MERGE_ONLY, "d1", "2026-09-01T00:00:00Z");
    deploy(db, MERGE_ONLY, "d2", "2026-09-02T00:00:00Z");
    const first = fakeClient({ "d1...d2": ["c1"] });
    const options = { db, repo: REPO, scopeId: SCOPE, detectionRule: MERGE_ONLY };

    await assignCommitsToDeployments({ ...options, client: first.client });
    const second = fakeClient({ "d1...d2": ["別の結果になってはいけない"] });
    const assigned = await assignCommitsToDeployments({ ...options, client: second.client });

    expect(second.calls).toEqual([]);
    expect(assigned[1]?.commitShas).toEqual(["c1"]);
  });

  it("増えたデプロイの分だけ追加で API を叩く", async () => {
    const db = openTestDatabase();
    deploy(db, MERGE_ONLY, "d1", "2026-09-01T00:00:00Z");
    deploy(db, MERGE_ONLY, "d2", "2026-09-02T00:00:00Z");
    const options = { db, repo: REPO, scopeId: SCOPE, detectionRule: MERGE_ONLY };
    await assignCommitsToDeployments({
      ...options,
      client: fakeClient({ "d1...d2": ["c1"] }).client,
    });

    deploy(db, MERGE_ONLY, "d3", "2026-09-03T00:00:00Z");
    const { client, calls } = fakeClient({ "d2...d3": ["c2"] });
    const assigned = await assignCommitsToDeployments({ ...options, client });

    expect(calls).toEqual([{ base: "d2", head: "d3" }]);
    expect(assigned.map((item) => item.commitShas)).toEqual([[], ["c1"], ["c2"]]);
  });

  it("3 週間放置された branch のコミットも、merge された今日のデプロイに割り当たる", async () => {
    // 時刻順近似（前回デプロイ時刻 〜 今回デプロイ時刻の窓に割り当てる方法）なら、この
    // コミットは committer date が窓の外なので集計から丸ごと消える。compare の返す
    // SHA 集合をそのまま使うことで、そのデータ欠けを構造的に起こせなくする（ADR-0004 / #15）。
    const db = openTestDatabase();
    saveCommit(db, {
      scopeId: SCOPE,
      sha: "stale",
      committedAt: "2026-08-30T00:00:00Z",
      authoredAt: "2026-08-30T00:00:00Z",
      message: "3 週間前に書かれ、今日 merge された",
      raw: {},
    });
    deploy(db, MERGE_ONLY, "d1", "2026-09-19T00:00:00Z");
    deploy(db, MERGE_ONLY, "merge", "2026-09-20T00:00:00Z");
    const { client } = fakeClient({ "d1...merge": ["stale", "merge"] });

    const assigned = await assignCommitsToDeployments({
      db,
      client,
      repo: REPO,
      scopeId: SCOPE,
      detectionRule: MERGE_ONLY,
    });

    expect(assigned[1]?.commitShas).toContain("stale");
    // 参照 API 側（#18 が使う経路）でも同じこと。
    expect(listDeploymentCommits(db, SCOPE, MERGE_ONLY)[1]?.commitShas).toContain("stale");
  });

  it("最古のデプロイは base が無いので割り当てず、それを status で明示する", async () => {
    const db = openTestDatabase();
    deploy(db, MERGE_ONLY, "d1", "2026-09-01T00:00:00Z");
    deploy(db, MERGE_ONLY, "d2", "2026-09-02T00:00:00Z");
    const { client, calls } = fakeClient({ "d1...d2": ["c1"] });

    const assigned = await assignCommitsToDeployments({
      db,
      client,
      repo: REPO,
      scopeId: SCOPE,
      detectionRule: MERGE_ONLY,
    });

    expect(assigned[0]).toEqual({
      deployedAt: "2026-09-01T00:00:00Z",
      headSha: "d1",
      baseSha: null,
      status: "oldest",
      commitShas: [],
      truncated: false,
    });
    // 最古のデプロイのために compare を叩かない（base が決められないため）。
    expect(calls).toHaveLength(1);
  });

  it("compare が打ち切られたら、その印を結果とキャッシュの両方に残す", async () => {
    const db = openTestDatabase();
    deploy(db, MERGE_ONLY, "d1", "2026-09-01T00:00:00Z");
    deploy(db, MERGE_ONLY, "d2", "2026-09-02T00:00:00Z");
    const { client } = fakeClient({ "d1...d2": ["c1"] }, ["d1...d2"]);

    const assigned = await assignCommitsToDeployments({
      db,
      client,
      repo: REPO,
      scopeId: SCOPE,
      detectionRule: MERGE_ONLY,
    });

    expect(assigned[1]?.truncated).toBe(true);
    expect(
      findCompareCache(db, {
        scopeId: SCOPE,
        detectionRule: MERGE_ONLY,
        baseSha: "d1",
        headSha: "d2",
      })?.truncated,
    ).toBe(true);
  });
});

describe("デプロイ検出ルールの変更", () => {
  it("ルールが変わると compare_cache を破棄し、再取得・再計算する", async () => {
    const db = openTestDatabase();
    deploy(db, MERGE_ONLY, "d1", "2026-09-01T00:00:00Z");
    deploy(db, MERGE_ONLY, "d2", "2026-09-02T00:00:00Z");
    await assignCommitsToDeployments({
      db,
      client: fakeClient({ "d1...d2": ["c1"] }).client,
      repo: REPO,
      scopeId: SCOPE,
      detectionRule: MERGE_ONLY,
    });

    // 粒度を all_pushes に変えると、同じ範囲でも検出されるデプロイが変わる。
    deploy(db, ALL_PUSHES, "d1", "2026-09-01T00:00:00Z");
    deploy(db, ALL_PUSHES, "p1", "2026-09-01T12:00:00Z");
    deploy(db, ALL_PUSHES, "d2", "2026-09-02T00:00:00Z");
    const { client, calls } = fakeClient({ "d1...p1": ["c0"], "p1...d2": ["c1"] });
    const assigned = await assignCommitsToDeployments({
      db,
      client,
      repo: REPO,
      scopeId: SCOPE,
      detectionRule: ALL_PUSHES,
    });

    // 古いルールで作った差分は残っていない。残すと「この数値がどう計算されたか辿れる」
    // （README 柱 4）が嘘になる。
    expect(
      findCompareCache(db, {
        scopeId: SCOPE,
        detectionRule: MERGE_ONLY,
        baseSha: "d1",
        headSha: "d2",
      }),
    ).toBeUndefined();
    expect(calls).toEqual([
      { base: "d1", head: "p1" },
      { base: "p1", head: "d2" },
    ]);
    expect(assigned.map((item) => item.commitShas)).toEqual([[], ["c0"], ["c1"]]);
  });

  it("参照 API もルール変更の検知を通るので、古いキャッシュを読み出せない", async () => {
    const db = openTestDatabase();
    deploy(db, MERGE_ONLY, "d1", "2026-09-01T00:00:00Z");
    deploy(db, MERGE_ONLY, "d2", "2026-09-02T00:00:00Z");
    await assignCommitsToDeployments({
      db,
      client: fakeClient({ "d1...d2": ["c1"] }).client,
      repo: REPO,
      scopeId: SCOPE,
      detectionRule: MERGE_ONLY,
    });

    listDeploymentCommits(db, SCOPE, ALL_PUSHES);

    expect(
      findCompareCache(db, {
        scopeId: SCOPE,
        detectionRule: MERGE_ONLY,
        baseSha: "d1",
        headSha: "d2",
      }),
    ).toBeUndefined();
  });
});

describe("参照 API（#18 リードタイムが使う）", () => {
  it("まだ compare していない差分は pending として返し、外部 API を叩かない", () => {
    const db = openTestDatabase();
    deploy(db, MERGE_ONLY, "d1", "2026-09-01T00:00:00Z");
    deploy(db, MERGE_ONLY, "d2", "2026-09-02T00:00:00Z");

    const listed = listDeploymentCommits(db, SCOPE, MERGE_ONLY);

    expect(listed.map((item) => item.status)).toEqual(["oldest", "pending"]);
    expect(listed[1]?.commitShas).toEqual([]);
  });

  it("デプロイ → コミット SHA 集合をデプロイ時刻順に返す", async () => {
    const db = openTestDatabase();
    deploy(db, MERGE_ONLY, "d1", "2026-09-01T00:00:00Z");
    deploy(db, MERGE_ONLY, "d2", "2026-09-02T00:00:00Z");
    deploy(db, MERGE_ONLY, "d3", "2026-09-03T00:00:00Z");
    await assignCommitsToDeployments({
      db,
      client: fakeClient({ "d1...d2": ["c1", "c2"], "d2...d3": ["c3"] }).client,
      repo: REPO,
      scopeId: SCOPE,
      detectionRule: MERGE_ONLY,
    });

    expect(listDeploymentCommits(db, SCOPE, MERGE_ONLY)).toEqual([
      {
        deployedAt: "2026-09-01T00:00:00Z",
        headSha: "d1",
        baseSha: null,
        status: "oldest",
        commitShas: [],
        truncated: false,
      },
      {
        deployedAt: "2026-09-02T00:00:00Z",
        headSha: "d2",
        baseSha: "d1",
        status: "assigned",
        commitShas: ["c1", "c2"],
        truncated: false,
      },
      {
        deployedAt: "2026-09-03T00:00:00Z",
        headSha: "d3",
        baseSha: "d2",
        status: "assigned",
        commitShas: ["c3"],
        truncated: false,
      },
    ]);
  });

  it("デプロイが 1 件も無ければ空を返す", () => {
    expect(listDeploymentCommits(openTestDatabase(), SCOPE, MERGE_ONLY)).toEqual([]);
  });
});
