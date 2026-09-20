import { describe, expect, it } from "vitest";
import {
  discardDerivedData,
  findCollectionCursor,
  findCompareCache,
  listCommits,
  listDeployments,
  listPullRequests,
  recordCollectionFailure,
  recordCollectionSuccess,
  saveCollectionCursor,
  saveCommit,
  saveCompareCache,
  saveDeployment,
  savePullRequest,
} from "./store.ts";
import { openTestDatabase } from "./testing.ts";

describe("コミットの保存と読み出し", () => {
  it("保存したコミットを、スコープを指定して読み戻せる", () => {
    const db = openTestDatabase();

    saveCommit(db, {
      scopeId: "four-keys-metrics-viewer",
      sha: "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07",
      committedAt: "2026-09-20T04:19:33Z",
      authoredAt: "2026-09-20T04:19:33Z",
      message: "docs: grilling の合意内容を ADR 6 枚と CONTEXT.md に記録",
      raw: { sha: "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07" },
    });

    const commits = listCommits(db, "four-keys-metrics-viewer");

    expect(commits).toHaveLength(1);
    expect(commits[0]?.sha).toBe("c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07");
    expect(commits[0]?.committedAt).toBe("2026-09-20T04:19:33Z");
    expect(commits[0]?.message).toBe("docs: grilling の合意内容を ADR 6 枚と CONTEXT.md に記録");
  });

  it("同じコミットを 2 回保存しても重複せず、後の内容で上書きされる", () => {
    const db = openTestDatabase();
    const base = {
      scopeId: "four-keys-metrics-viewer",
      sha: "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07",
      committedAt: "2026-09-20T04:19:33Z",
      authoredAt: "2026-09-20T04:19:33Z",
      raw: {},
    };

    saveCommit(db, { ...base, message: "1 回目に取得した内容" });
    saveCommit(db, { ...base, message: "2 回目に取得した内容" });

    const commits = listCommits(db, "four-keys-metrics-viewer");

    expect(commits).toHaveLength(1);
    expect(commits[0]?.message).toBe("2 回目に取得した内容");
  });

  it("同じ SHA でもスコープが違えば別のコミットとして扱う", () => {
    const db = openTestDatabase();
    const base = {
      sha: "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07",
      committedAt: "2026-09-20T04:19:33Z",
      authoredAt: "2026-09-20T04:19:33Z",
      message: "同一 SHA",
      raw: {},
    };

    saveCommit(db, { ...base, scopeId: "scope-a" });
    saveCommit(db, { ...base, scopeId: "scope-b" });

    expect(listCommits(db, "scope-a")).toHaveLength(1);
    expect(listCommits(db, "scope-b")).toHaveLength(1);
  });
});

describe("プルリクエストの保存と読み出し", () => {
  const pr = {
    scopeId: "four-keys-metrics-viewer",
    number: 28,
    title: "feat: Node + SQLite + Docker への構成変更",
    createdAt: "2026-09-20T05:19:49Z",
    mergedAt: "2026-09-20T05:20:21Z",
    mergeCommitSha: "1df6bbace9735571ec8b8b4e6ab44f44789c543f",
    headSha: "c10da661b1c2a481c8f122b526ff27bcba15ea13",
    baseSha: "559c75729cb2115f8bb54f52d41b23357912940c",
    baseRef: "main",
    htmlUrl: "https://github.com/ymiyamoto63/four-keys-metrics-viewer/pull/28",
    raw: {},
  };

  it("保存したプルリクエストを読み戻せる", () => {
    const db = openTestDatabase();

    savePullRequest(db, pr);

    const stored = listPullRequests(db, "four-keys-metrics-viewer");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.number).toBe(28);
    expect(stored[0]?.mergedAt).toBe("2026-09-20T05:20:21Z");
  });

  it("同じ番号を 2 回保存しても重複しない", () => {
    const db = openTestDatabase();

    savePullRequest(db, { ...pr, mergedAt: null, mergeCommitSha: null });
    savePullRequest(db, pr);

    const stored = listPullRequests(db, "four-keys-metrics-viewer");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.mergedAt).toBe("2026-09-20T05:20:21Z");
  });

  it("未マージのプルリクエストを保存できる", () => {
    const db = openTestDatabase();

    savePullRequest(db, { ...pr, mergedAt: null, mergeCommitSha: null });

    expect(listPullRequests(db, "four-keys-metrics-viewer")[0]?.mergedAt).toBeNull();
  });
});

describe("デプロイの保存と読み出し", () => {
  const deployment = {
    scopeId: "four-keys-metrics-viewer",
    detectionRule: "default_branch:merge_only",
    commitSha: "559c75729cb2115f8bb54f52d41b23357912940c",
    // デプロイ時刻はマージコミットの committer date（PR の merged_at ではない。ADR-0001）。
    deployedAt: "2026-09-20T04:30:00Z",
    raw: {},
  };

  it("保存したデプロイを読み戻せる", () => {
    const db = openTestDatabase();

    saveDeployment(db, deployment);

    const stored = listDeployments(db, "four-keys-metrics-viewer", "default_branch:merge_only");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.deployedAt).toBe("2026-09-20T04:30:00Z");
    expect(stored[0]?.commitSha).toBe("559c75729cb2115f8bb54f52d41b23357912940c");
  });

  it("デプロイ時刻の昇順で返す", () => {
    const db = openTestDatabase();

    saveDeployment(db, { ...deployment, commitSha: "bbb", deployedAt: "2026-09-20T12:00:00Z" });
    saveDeployment(db, { ...deployment, commitSha: "aaa", deployedAt: "2026-09-18T12:00:00Z" });

    const stored = listDeployments(db, "four-keys-metrics-viewer", "default_branch:merge_only");
    expect(stored.map((d) => d.commitSha)).toEqual(["aaa", "bbb"]);
  });

  it("別の検出ルールで検出したデプロイは混ざらない", () => {
    // 同じコミットでも、どのルールで検出したかによって「デプロイか否か」が変わる。
    // ルールを跨いで混ぜると、指標がどう計算されたか辿れなくなる（ADR-0001 / 柱 4）。
    const db = openTestDatabase();

    saveDeployment(db, deployment);
    saveDeployment(db, { ...deployment, detectionRule: "workflow_run:deploy.yml" });

    expect(
      listDeployments(db, "four-keys-metrics-viewer", "default_branch:merge_only"),
    ).toHaveLength(1);
    expect(listDeployments(db, "four-keys-metrics-viewer", "workflow_run:deploy.yml")).toHaveLength(
      1,
    );
  });

  it("検出ルールが変わったら、古いルールで検出したデプロイを破棄できる", () => {
    const db = openTestDatabase();
    saveDeployment(db, deployment);
    saveDeployment(db, { ...deployment, detectionRule: "workflow_run:deploy.yml" });

    discardDerivedData(db, "four-keys-metrics-viewer", "workflow_run:deploy.yml");

    expect(listDeployments(db, "four-keys-metrics-viewer", "default_branch:merge_only")).toEqual(
      [],
    );
    expect(listDeployments(db, "four-keys-metrics-viewer", "workflow_run:deploy.yml")).toHaveLength(
      1,
    );
  });

  it("別スコープのデプロイは破棄しない", () => {
    const db = openTestDatabase();
    saveDeployment(db, deployment);
    saveDeployment(db, { ...deployment, scopeId: "other-scope" });

    discardDerivedData(db, "four-keys-metrics-viewer", "workflow_run:deploy.yml");

    expect(listDeployments(db, "other-scope", "default_branch:merge_only")).toHaveLength(1);
  });
});

describe("compare キャッシュ", () => {
  const key = {
    scopeId: "four-keys-metrics-viewer",
    detectionRule: "default_branch:merge_only",
    baseSha: "dc68ad05a7330b6e7610f0ac359b929050810dc3",
    headSha: "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07",
  };

  it("保存したコミット範囲を読み戻せる", () => {
    const db = openTestDatabase();

    saveCompareCache(db, { ...key, commitShas: ["c7aeb16a"], truncated: false });

    expect(findCompareCache(db, key)?.commitShas).toEqual(["c7aeb16a"]);
  });

  it("キャッシュが無ければ undefined を返す", () => {
    expect(findCompareCache(openTestDatabase(), key)).toBeUndefined();
  });

  it("検出ルールが違えばキャッシュにヒットしない", () => {
    // 同じ base...head でも、ルールが変われば「どのコミットがどのデプロイに属するか」が
    // 変わりうる。ルールをキーに含めないと古い導出が生き残る（#8 の注意点）。
    const db = openTestDatabase();

    saveCompareCache(db, { ...key, commitShas: ["c7aeb16a"], truncated: false });

    expect(
      findCompareCache(db, { ...key, detectionRule: "workflow_run:deploy.yml" }),
    ).toBeUndefined();
  });

  it("検出ルールが変わったら古いキャッシュを破棄する", () => {
    const db = openTestDatabase();
    saveCompareCache(db, { ...key, commitShas: ["c7aeb16a"], truncated: false });

    discardDerivedData(db, key.scopeId, "workflow_run:deploy.yml");

    expect(findCompareCache(db, key)).toBeUndefined();
  });

  it("打ち切りの印を保持する", () => {
    const db = openTestDatabase();

    saveCompareCache(db, { ...key, commitShas: ["c7aeb16a"], truncated: true });

    expect(findCompareCache(db, key)?.truncated).toBe(true);
  });
});

describe("収集カーソル", () => {
  it("一度も収集していないスコープにはカーソルが無い", () => {
    expect(findCollectionCursor(openTestDatabase(), "four-keys-metrics-viewer")).toBeUndefined();
  });

  it("保存したカーソルを読み戻せる", () => {
    const db = openTestDatabase();

    saveCollectionCursor(db, {
      scopeId: "four-keys-metrics-viewer",
      backfilledUntil: "2025-09-20T00:00:00Z",
      backfillComplete: false,
      lastSuccessAt: "2026-09-20T05:00:00Z",
      lastError: null,
    });

    const cursor = findCollectionCursor(db, "four-keys-metrics-viewer");
    expect(cursor?.backfilledUntil).toBe("2025-09-20T00:00:00Z");
    expect(cursor?.backfillComplete).toBe(false);
    expect(cursor?.lastSuccessAt).toBe("2026-09-20T05:00:00Z");
  });

  it("中断した続きから進められるよう、カーソルは上書きされる", () => {
    const db = openTestDatabase();
    const base = {
      scopeId: "four-keys-metrics-viewer",
      backfillComplete: false,
      lastSuccessAt: "2026-09-20T05:00:00Z",
      lastError: null,
    };

    saveCollectionCursor(db, { ...base, backfilledUntil: "2026-06-01T00:00:00Z" });
    saveCollectionCursor(db, { ...base, backfilledUntil: "2026-03-01T00:00:00Z" });

    expect(findCollectionCursor(db, "four-keys-metrics-viewer")?.backfilledUntil).toBe(
      "2026-03-01T00:00:00Z",
    );
  });

  it("失敗の記録が最終成功時刻を消さない", () => {
    // 常時稼働しない構成では、古いデータを現在の状態と誤読させないために
    // 最終収集成功時刻が要る（ADR-0007）。失敗で上書きしてはならない。
    const db = openTestDatabase();
    saveCollectionCursor(db, {
      scopeId: "four-keys-metrics-viewer",
      backfilledUntil: "2025-09-20T00:00:00Z",
      backfillComplete: true,
      lastSuccessAt: "2026-09-20T05:00:00Z",
      lastError: null,
    });

    recordCollectionFailure(db, "four-keys-metrics-viewer", "401 Bad credentials");

    const cursor = findCollectionCursor(db, "four-keys-metrics-viewer");
    expect(cursor?.lastSuccessAt).toBe("2026-09-20T05:00:00Z");
    expect(cursor?.lastError).toBe("401 Bad credentials");
  });

  it("スコープごとに独立している", () => {
    const db = openTestDatabase();
    const base = { backfilledUntil: null, backfillComplete: false, lastError: null };

    saveCollectionCursor(db, {
      ...base,
      scopeId: "scope-a",
      lastSuccessAt: "2026-09-20T05:00:00Z",
    });
    saveCollectionCursor(db, {
      ...base,
      scopeId: "scope-b",
      lastSuccessAt: "2026-09-01T05:00:00Z",
    });

    expect(findCollectionCursor(db, "scope-a")?.lastSuccessAt).toBe("2026-09-20T05:00:00Z");
    expect(findCollectionCursor(db, "scope-b")?.lastSuccessAt).toBe("2026-09-01T05:00:00Z");
  });
});

describe("収集成功の記録", () => {
  it("最終収集成功時刻を更新し、直前の失敗を消す", () => {
    const db = openTestDatabase();
    saveCollectionCursor(db, {
      scopeId: "four-keys-metrics-viewer",
      backfilledUntil: "2025-09-20T00:00:00Z",
      backfillComplete: true,
      lastSuccessAt: "2026-09-19T05:00:00Z",
      lastError: "403 Resource not accessible",
    });

    recordCollectionSuccess(db, "four-keys-metrics-viewer", "2026-09-20T05:00:00Z");

    const cursor = findCollectionCursor(db, "four-keys-metrics-viewer");
    expect(cursor?.lastSuccessAt).toBe("2026-09-20T05:00:00Z");
    expect(cursor?.lastError).toBeNull();
    // バックフィルの進捗には触らない（#12 が持つ）。
    expect(cursor?.backfilledUntil).toBe("2025-09-20T00:00:00Z");
    expect(cursor?.backfillComplete).toBe(true);
  });

  it("カーソルが無いスコープでも記録できる", () => {
    const db = openTestDatabase();

    recordCollectionSuccess(db, "four-keys-metrics-viewer", "2026-09-20T05:00:00Z");

    expect(findCollectionCursor(db, "four-keys-metrics-viewer")?.lastSuccessAt).toBe(
      "2026-09-20T05:00:00Z",
    );
  });
});
