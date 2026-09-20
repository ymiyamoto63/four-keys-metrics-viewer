import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectCommit, projectCompare, projectPullRequest } from "./project.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

describe("コミットの射影", () => {
  it("正規化した項目を実レスポンスから取り出す", () => {
    const projected = projectCommit(fixture("commit"));

    expect(projected.sha).toBe("c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07");
    expect(projected.committedAt).toBe("2026-09-20T04:21:38Z");
    expect(projected.authoredAt).toBe("2026-09-20T04:21:38Z");
    expect(projected.message).toContain("docs: grilling の合意内容を ADR 6 枚と CONTEXT.md に記録");
  });

  it("マージコミットは親を 2 つ持つ", () => {
    expect(projectCommit(fixture("merge_commit")).parentShas).toEqual([
      "dc68ad05a7330b6e7610f0ac359b929050810dc3",
      "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07",
    ]);
  });

  it("通常のコミットは親を 1 つ持つ", () => {
    expect(projectCommit(fixture("commit")).parentShas).toEqual([
      "dc68ad05a7330b6e7610f0ac359b929050810dc3",
    ]);
  });

  it("raw には列挙した項目だけを残す", () => {
    const { raw } = projectCommit(fixture("commit"));

    expect(Object.keys(raw).sort()).toEqual(["commit", "html_url", "parents", "sha"]);
    expect(Object.keys(raw.commit).sort()).toEqual(["author", "committer", "message"]);
  });

  it("本アプリが使わない項目を raw に持ち込まない", () => {
    const { raw } = projectCommit(fixture("commit")) as { raw: Record<string, unknown> };

    // 個人の評価に使わせないため、author / committer のユーザー情報は保存しない
    // （README のアンチパターン）。
    expect(raw.author).toBeUndefined();
    expect(raw.committer).toBeUndefined();
    expect(raw.node_id).toBeUndefined();
    expect(raw.comments_url).toBeUndefined();
    expect(raw.url).toBeUndefined();
  });

  it("raw が生レスポンスより十分に小さい", () => {
    const original = JSON.stringify(fixture("commit")).length;
    const projected = JSON.stringify(projectCommit(fixture("commit")).raw).length;

    // 実測（このコミットは本文の長い日本語メッセージを持つ）: 5,310 B → 1,095 B。
    expect(original).toBeGreaterThan(5000);
    expect(projected).toBeLessThan(1200);
  });
});

describe("プルリクエストの射影", () => {
  it("正規化した項目を実レスポンスから取り出す", () => {
    const projected = projectPullRequest(fixture("pull_request"));

    expect(projected.number).toBe(28);
    expect(projected.createdAt).toBe("2026-09-20T05:19:49Z");
    expect(projected.mergedAt).toBe("2026-09-20T05:20:21Z");
    expect(projected.mergeCommitSha).toBe("1df6bbace9735571ec8b8b4e6ab44f44789c543f");
    expect(projected.headSha).toBe("c10da661b1c2a481c8f122b526ff27bcba15ea13");
    expect(projected.baseSha).toBe("559c75729cb2115f8bb54f52d41b23357912940c");
  });

  it("raw には列挙した項目だけを残す", () => {
    const { raw } = projectPullRequest(fixture("pull_request"));

    expect(Object.keys(raw).sort()).toEqual([
      "base",
      "created_at",
      "head",
      "html_url",
      "merge_commit_sha",
      "merged_at",
      "number",
      "title",
    ]);
  });

  it("本アプリが使わない項目を raw に持ち込まない", () => {
    const { raw } = projectPullRequest(fixture("pull_request")) as {
      raw: Record<string, unknown>;
    };

    expect(raw.user).toBeUndefined();
    expect(raw.merged_by).toBeUndefined();
    expect(raw._links).toBeUndefined();
    expect(raw.labels).toBeUndefined();
    expect(raw.body).toBeUndefined();
    expect(raw.additions).toBeUndefined();
  });

  it("PR の生レスポンスは大半が不要で、射影で 20 分の 1 以下になる", () => {
    const original = JSON.stringify(fixture("pull_request")).length;
    const projected = JSON.stringify(projectPullRequest(fixture("pull_request")).raw).length;

    // 実測: 26,435 B → 500 B 前後。
    expect(original).toBeGreaterThan(20000);
    expect(projected * 20).toBeLessThan(original);
  });

  it("未マージの PR は mergedAt を持たない", () => {
    const open = {
      ...(fixture("pull_request") as object),
      merged_at: null,
      merge_commit_sha: null,
    };

    const projected = projectPullRequest(open);

    expect(projected.mergedAt).toBeNull();
    expect(projected.mergeCommitSha).toBeNull();
  });
});

describe("compare の射影", () => {
  it("コミットの SHA 列だけを取り出す", () => {
    const projected = projectCompare(fixture("compare"));

    expect(projected.commitShas).toEqual(["c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07"]);
    expect(projected.totalCommits).toBe(1);
  });

  it("ファイル差分を持ち込まない", () => {
    const projected = projectCompare(fixture("compare")) as unknown as Record<string, unknown>;

    expect(projected.files).toBeUndefined();
    // ペイロードの 8 割はファイル差分で、本アプリは一切使わない（#25 実測）。
    expect(JSON.stringify(projected).length * 100).toBeLessThan(
      JSON.stringify(fixture("compare")).length,
    );
  });

  it("返却されたコミット数が total_commits に満たない場合は打ち切りとして印を付ける", () => {
    // compare API は最大 250 件しか返さない。取りこぼすとリードタイムの標本が
    // 黙って欠ける（ADR-0004 が退けた時刻順近似と同じ壊れ方になる）。
    const truncated = { ...(fixture("compare") as object), total_commits: 300 };

    expect(projectCompare(truncated).truncated).toBe(true);
  });

  it("すべて返却されている場合は打ち切りではない", () => {
    expect(projectCompare(fixture("compare")).truncated).toBe(false);
  });
});
