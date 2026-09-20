import { describe, expect, it } from "vitest";
import type { Db } from "../db/index.ts";
import { discardDerivedData, listDeployments, saveCommit } from "../db/store.ts";
import { openTestDatabase } from "../db/testing.ts";
import {
  type DeployCandidateCommit,
  defaultBranchRuleKey,
  detectDefaultBranchDeployments,
  recordDefaultBranchDeployments,
} from "./default-branch.ts";

const SCOPE_ID = "four-keys-metrics-viewer";

/** 8 ヶ月前。合成履歴でしか作れない過去日付（ADR-0001 / #22）を模す。 */
const EIGHT_MONTHS_AGO = "2026-01-20T02:15:00Z";

function commit(sha: string, committedAt: string, parentCount: number): DeployCandidateCommit {
  return {
    sha,
    committedAt,
    parentShas: Array.from({ length: parentCount }, (_, i) => `${sha}-parent-${i}`),
  };
}

/** feature コミット 3 件と、それを取り込む merge commit 1 件。 */
const HISTORY: DeployCandidateCommit[] = [
  commit("aaa1", "2026-09-01T10:00:00Z", 1),
  commit("aaa2", "2026-09-02T10:00:00Z", 1),
  commit("aaa3", "2026-09-03T10:00:00Z", 1),
  commit("merge1", "2026-09-04T10:00:00Z", 2),
];

describe("デプロイ検出ルール `default_branch` の検出", () => {
  it("`merge_only` は親が 2 つ以上のコミットだけをデプロイとみなす", () => {
    const deployments = detectDefaultBranchDeployments(HISTORY, "merge_only");

    expect(deployments.map((d) => d.commitSha)).toEqual(["merge1"]);
  });

  it("`all_pushes` はデフォルトブランチの全コミットをデプロイとみなす", () => {
    const deployments = detectDefaultBranchDeployments(HISTORY, "all_pushes");

    expect(deployments.map((d) => d.commitSha)).toEqual(["aaa1", "aaa2", "aaa3", "merge1"]);
  });

  it("同じコミット列でも、粒度を切り替えるとデプロイ件数が変わる（#13 完了条件）", () => {
    const mergeOnly = detectDefaultBranchDeployments(HISTORY, "merge_only");
    const allPushes = detectDefaultBranchDeployments(HISTORY, "all_pushes");

    expect(mergeOnly).toHaveLength(1);
    expect(allPushes).toHaveLength(4);
  });

  it("親を持たない初回コミットは `merge_only` ではデプロイにならない", () => {
    const initial = commit("root", "2026-01-01T00:00:00Z", 0);

    expect(detectDefaultBranchDeployments([initial], "merge_only")).toEqual([]);
    expect(detectDefaultBranchDeployments([initial], "all_pushes")).toHaveLength(1);
  });

  it("デプロイ時刻は対象コミットの committer date で、過去日付がそのまま残る", () => {
    const past = commit("merge-past", EIGHT_MONTHS_AGO, 2);

    const deployments = detectDefaultBranchDeployments([past], "merge_only");

    // PR の merged_at を使うとサーバー時刻に潰れ、ここが「今」になる（ADR-0001 / #13）。
    expect(deployments[0]?.deployedAt).toBe(EIGHT_MONTHS_AGO);
  });

  it("検出は DB も GitHub API も触らない純粋関数である（入力を書き換えない）", () => {
    const input = structuredClone(HISTORY);

    detectDefaultBranchDeployments(input, "all_pushes");

    expect(input).toEqual(HISTORY);
  });
});

describe("デプロイ検出ルールの識別子", () => {
  it("粒度を識別子に含める", () => {
    expect(defaultBranchRuleKey("merge_only")).toBe("default_branch:merge_only");
    expect(defaultBranchRuleKey("all_pushes")).toBe("default_branch:all_pushes");
  });

  it("検出したデプロイには粒度込みの識別子が入る", () => {
    const [deployment] = detectDefaultBranchDeployments(HISTORY, "merge_only");

    expect(deployment?.detectionRule).toBe("default_branch:merge_only");
  });
});

function saveHistory(db: Db, commits: readonly DeployCandidateCommit[]): void {
  for (const c of commits) {
    saveCommit(db, {
      scopeId: SCOPE_ID,
      sha: c.sha,
      committedAt: c.committedAt,
      authoredAt: c.committedAt,
      message: `commit ${c.sha}`,
      raw: { sha: c.sha, parents: c.parentShas.map((sha) => ({ sha })) },
    });
  }
}

describe("保存済みコミットからのデプロイ記録", () => {
  it("過去日付の merge commit が、その過去日付のデプロイとして記録される（#13 完了条件）", () => {
    const db = openTestDatabase();
    saveHistory(db, [commit("aaa1", "2026-01-19T09:00:00Z", 1), commit("m", EIGHT_MONTHS_AGO, 2)]);

    recordDefaultBranchDeployments(db, SCOPE_ID, "merge_only");

    const deployments = listDeployments(db, SCOPE_ID, defaultBranchRuleKey("merge_only"));
    expect(deployments).toHaveLength(1);
    expect(deployments[0]?.commitSha).toBe("m");
    expect(deployments[0]?.deployedAt).toBe(EIGHT_MONTHS_AGO);
  });

  it("同じ入力で 2 回実行しても `deploy_events` の行は増えない", () => {
    const db = openTestDatabase();
    saveHistory(db, HISTORY);

    recordDefaultBranchDeployments(db, SCOPE_ID, "all_pushes");
    recordDefaultBranchDeployments(db, SCOPE_ID, "all_pushes");

    expect(countDeployEvents(db)).toBe(4);
  });

  it("親 SHA は `raw.parents` から組み立てる（commits に parents 列は無い）", () => {
    const db = openTestDatabase();
    saveHistory(db, HISTORY);

    const deployments = recordDefaultBranchDeployments(db, SCOPE_ID, "merge_only");

    expect(deployments.map((d) => d.commitSha)).toEqual(["merge1"]);
  });

  it("`raw` に parents が無いコミットは、黙って非デプロイに倒さず落とす", () => {
    const db = openTestDatabase();
    saveCommit(db, {
      scopeId: SCOPE_ID,
      sha: "no-parents",
      committedAt: "2026-09-01T10:00:00Z",
      authoredAt: "2026-09-01T10:00:00Z",
      message: "parents を持たない raw",
      raw: { sha: "no-parents" },
    });

    expect(() => recordDefaultBranchDeployments(db, SCOPE_ID, "merge_only")).toThrow(/parents/);
  });

  it("粒度を変えると識別子も変わるため、古い粒度のデプロイを破棄できる", () => {
    const db = openTestDatabase();
    saveHistory(db, HISTORY);

    // `all_pushes` で 4 件検出したあと、粒度を `merge_only` に変えて再検出する。
    recordDefaultBranchDeployments(db, SCOPE_ID, "all_pushes");
    recordDefaultBranchDeployments(db, SCOPE_ID, "merge_only");
    discardDerivedData(db, SCOPE_ID, defaultBranchRuleKey("merge_only"));

    // 識別子に粒度を含めていないと、ここで前の粒度の 3 件が生き残って二重計上になる。
    expect(countDeployEvents(db)).toBe(1);
    expect(listDeployments(db, SCOPE_ID, defaultBranchRuleKey("all_pushes"))).toEqual([]);
  });
});

function countDeployEvents(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM deploy_events WHERE scope_id = ?")
    .get(SCOPE_ID) as { n: number };
  return row.n;
}
