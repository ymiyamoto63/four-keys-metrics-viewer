import { describe, expect, it } from "vitest";
import {
  buildMetricsInput,
  readRecordedResponses,
  recordedMetricsInput,
  sanitizeCommitResponse,
  sanitizeCompareResponse,
  sanitizePullRequestResponse,
} from "./fixtures.ts";
import type { CollectionCoverage } from "./types.ts";
import { weekOf } from "./week.ts";

const COVERAGE: CollectionCoverage = {
  backfilledUntil: "2026-09-13T15:00:00.000Z",
  backfillComplete: false,
  lastSuccessAt: "2026-09-20T06:00:00.000Z",
};

describe("記録した API レスポンスから指標計算の入力を組み立てる", () => {
  it("コミットの標本は射影（github/project.ts）を通して作る", () => {
    const input = recordedMetricsInput();

    expect(input.commits.map((commit) => [commit.sha.slice(0, 7), commit.committedAt])).toEqual([
      ["dc68ad0", "2026-09-20T03:49:00Z"],
      ["c7aeb16", "2026-09-20T04:21:38Z"],
      ["559c757", "2026-09-20T04:30:00Z"],
    ]);
  });

  it("デプロイ時刻は対象コミットの committer date になる（ADR-0001）", () => {
    const input = recordedMetricsInput();
    const commits = new Map(input.commits.map((commit) => [commit.sha, commit.committedAt]));

    for (const deployment of input.deployments) {
      expect(deployment.deployedAt).toBe(commits.get(deployment.commitSha));
      expect(deployment.detectionRule).toBe(input.detectionRule);
    }
  });

  it("デプロイは時刻の昇順に並ぶ", () => {
    const deployedAt = recordedMetricsInput().deployments.map((item) => item.deployedAt);

    expect(deployedAt).toEqual([...deployedAt].sort());
  });

  it("PR の標本は 3 区間内訳に要る時刻だけを持つ", () => {
    const [pullRequest] = recordedMetricsInput().pullRequests;

    expect(pullRequest).toEqual({
      number: 28,
      createdAt: "2026-09-20T05:19:49Z",
      mergedAt: "2026-09-20T05:20:21Z",
      mergeCommitSha: "1df6bbace9735571ec8b8b4e6ab44f44789c543f",
      headSha: "c10da661b1c2a481c8f122b526ff27bcba15ea13",
    });
  });

  it("compare の結果がデプロイへのコミット割り当てになる（#15 の実装には依存しない）", () => {
    const [assignment] = recordedMetricsInput().deployCommits;

    expect(assignment).toEqual({
      deploymentCommitSha: "c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07",
      baseSha: "dc68ad05a7330b6e7610f0ac359b929050810dc3",
      commitShas: ["c7aeb16a2dc0107e8b8016cdd2b9cea85f93df07"],
      truncated: false,
    });
  });

  it("記録した瞬間は週の途中なので、その週は数え終わっていない扱いになる", () => {
    const input = recordedMetricsInput();

    expect(weekOf(input.period.to).key).toBe("2026-09-14");
    expect(input.coverage.lastSuccessAt).toBe(readRecordedResponses().recordedAt);
  });

  it("期間を省略すると、記録した標本の全体を覆う期間になる", () => {
    const input = recordedMetricsInput();

    expect(input.period).toEqual({
      from: "2026-09-20T03:49:00.000Z",
      to: "2026-09-20T04:30:00.000Z",
    });
  });

  it("記録に無いコミットをデプロイとして指定したら、時刻を捏造せずに落ちる", () => {
    expect(() =>
      buildMetricsInput({
        responses: readRecordedResponses(),
        scopeId: "sample-app",
        detectionRule: "default_branch:merge_only",
        deployShas: ["存在しない-sha"],
        coverage: COVERAGE,
      }),
    ).toThrow(/含まれていません/);
  });
});

/** オブジェクトの中に、指定したキーがどこかに残っていないかを調べる。 */
function findKey(value: unknown, keys: Set<string>, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findKey(item, keys, `${path}[${index}]`));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    keys.has(key) ? [`${path}.${key}`] : findKey(child, keys, `${path}.${key}`),
  );
}

describe("fixture に個人情報を残さない", () => {
  /**
   * `docs/raw-columns.md`: `user` / `author` / `committer` / `merged_by` のユーザー情報を
   * 保存しない。**保存しないものは記録もしない。** fixture は git 履歴に恒久的に残るため、
   * ここを通さないと DB には入らない個人情報がリポジトリに焼き付く。
   *
   * 対象は構造化されたユーザー項目に限る。コミットメッセージや PR 本文は本アプリが
   * ドリルダウン表示のために保存する項目（`docs/raw-columns.md`）なので、本文は触らない。
   */
  const PERSONAL_KEYS = new Set([
    "login",
    "email",
    "avatar_url",
    "gravatar_id",
    "user",
    "merged_by",
    "assignee",
    "assignees",
    "requested_reviewers",
    "auto_merge",
    // verification は payload / signature に氏名とメールがそのまま入る。
    "verification",
  ]);

  it("記録済みの fixture に個人情報が残っていない", () => {
    expect(findKey(readRecordedResponses(), PERSONAL_KEYS)).toEqual([]);
  });

  it("コミットのサニタイズはユーザー情報を落とし、日付だけ残す", () => {
    const sanitized = sanitizeCommitResponse({
      sha: "abc",
      html_url: "https://example.invalid/abc",
      author: { login: "someone", email: "someone@example.invalid" },
      committer: { login: "someone" },
      commit: {
        message: "feat: something",
        author: { name: "Someone", email: "someone@example.invalid", date: "2026-09-15T00:00:00Z" },
        committer: {
          name: "Someone",
          email: "someone@example.invalid",
          date: "2026-09-15T01:00:00Z",
        },
        verification: { payload: "author Someone <someone@example.invalid>" },
      },
      parents: [{ sha: "def" }],
    }) as { commit: { author: unknown; committer: unknown } };

    expect(findKey(sanitized, PERSONAL_KEYS)).toEqual([]);
    // 射影が使う日付は残す（リードタイムの起点とデプロイ時刻）。
    expect(sanitized.commit.author).toEqual({ date: "2026-09-15T00:00:00Z" });
    expect(sanitized.commit.committer).toEqual({ date: "2026-09-15T01:00:00Z" });
  });

  it("PR のサニタイズは head / base に紛れたユーザー情報も落とす", () => {
    const sanitized = sanitizePullRequestResponse({
      number: 1,
      created_at: "2026-09-15T00:00:00Z",
      merged_at: null,
      merge_commit_sha: null,
      user: { login: "someone" },
      merged_by: { login: "someone" },
      head: { label: "owner:topic", ref: "topic", sha: "abc", user: { login: "someone" } },
      base: { label: "owner:main", ref: "main", sha: "def", repo: { owner: { login: "someone" } } },
    }) as { head: unknown };

    expect(findKey(sanitized, PERSONAL_KEYS)).toEqual([]);
    expect(sanitized.head).toEqual({ label: "owner:topic", ref: "topic", sha: "abc" });
  });

  it("compare のサニタイズは中のコミットにも及び、使わない差分は記録しない", () => {
    const sanitized = sanitizeCompareResponse({
      total_commits: 1,
      base_commit: commitWithUser("base"),
      merge_base_commit: commitWithUser("base"),
      commits: [commitWithUser("head")],
      files: [{ patch: "@@ -1 +1 @@" }],
    }) as Record<string, unknown>;

    expect(findKey(sanitized, PERSONAL_KEYS)).toEqual([]);
    // files はペイロードの約 8 割で、本アプリは一切使わない（docs/raw-columns.md）。
    expect(sanitized.files).toBeUndefined();
  });
});

function commitWithUser(sha: string): unknown {
  return {
    sha,
    author: { login: "someone" },
    committer: { login: "someone" },
    commit: {
      message: "chore",
      author: { name: "Someone", email: "someone@example.invalid", date: "2026-09-15T00:00:00Z" },
      committer: {
        name: "Someone",
        email: "someone@example.invalid",
        date: "2026-09-15T00:00:00Z",
      },
    },
    parents: [],
  };
}
