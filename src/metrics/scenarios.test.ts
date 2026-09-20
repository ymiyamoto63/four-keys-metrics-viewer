/**
 * 名前付きシナリオ（`__fixtures__/scenarios.ts`）が、名前どおりの境界に本当に載っているかを固定する。
 *
 * 指標そのものはここでは計算しない（#17 / #18 の担当）。ここで確かめるのは
 * 「このシナリオは確かに JST 月曜 00:00 をまたいでいる」「確かに 0 件の週がある」
 * といった**入力側の性質**である。シナリオが静かにずれると、#17 / #18 のテストは
 * 通ったまま何も検証しなくなる。
 */

import { describe, expect, it } from "vitest";
import {
  allScenarios,
  directPushCommit,
  longLeadTimeCommit,
  simultaneousDeployments,
  singleDataPointWeek,
  uncoveredWeek,
  utcSundayIsJstMonday,
  weekBoundary,
  zeroDeploymentWeek,
} from "./__fixtures__/scenarios.ts";
import { classifyWeekCoverage } from "./coverage.ts";
import type { MetricsInput } from "./types.ts";
import { bucketByWeek, weeksBetween } from "./week.ts";

function deployCountsByWeek(input: MetricsInput): Map<string, number> {
  const buckets = bucketByWeek(input.deployments, (deployment) => deployment.deployedAt);
  const counts = new Map<string, number>();
  for (const week of weeksBetween(input.period)) {
    counts.set(week.key, buckets.get(week.key)?.length ?? 0);
  }
  return counts;
}

describe("シナリオ全体の整合", () => {
  it("どのシナリオでも、デプロイは必ず対応するコミットを持つ", () => {
    for (const { name, input } of allScenarios) {
      const shas = new Set(input.commits.map((commit) => commit.sha));
      for (const deployment of input.deployments) {
        expect(shas.has(deployment.commitSha), `${name}: ${deployment.commitSha}`).toBe(true);
      }
    }
  });

  it("どのシナリオでも、デプロイ時刻は対象コミットの committer date と一致する", () => {
    // ADR-0001。ここがずれた fixture は、指標側のバグを隠す。
    for (const { name, input } of allScenarios) {
      const committedAt = new Map(input.commits.map((commit) => [commit.sha, commit.committedAt]));
      for (const deployment of input.deployments) {
        expect(deployment.deployedAt, `${name}: ${deployment.commitSha}`).toBe(
          committedAt.get(deployment.commitSha),
        );
      }
    }
  });

  it("どのシナリオでも、デプロイは集計期間の中に収まる", () => {
    for (const { name, input } of allScenarios) {
      const weeks = new Set(weeksBetween(input.period).map((week) => week.key));
      for (const [key, count] of deployCountsByWeek(input)) {
        expect(weeks.has(key), `${name}: ${key}`).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
      }
      expect(input.deployments.length).toBe(
        [...deployCountsByWeek(input).values()].reduce((sum, count) => sum + count, 0),
      );
    }
  });

  it("どのシナリオでも、検出ルールは標本と入力で一致する", () => {
    // ルール変更時の破棄漏れ（ADR-0002）が混ざっていない状態を出発点にする。
    for (const { name, input } of allScenarios) {
      for (const deployment of input.deployments) {
        expect(deployment.detectionRule, name).toBe(input.detectionRule);
      }
    }
  });
});

describe("週バケットの境界", () => {
  it("JST 月曜 00:00 ちょうどは新しい週に入り、1 ミリ秒前は前の週に残る", () => {
    expect(deployCountsByWeek(weekBoundary.input)).toEqual(
      new Map([
        ["2026-09-07", 1],
        ["2026-09-14", 2],
      ]),
    );
  });
});

describe("タイムゾーン", () => {
  it("UTC の同じ日曜のデプロイが、JST では別の週に落ちる", () => {
    expect(deployCountsByWeek(utcSundayIsJstMonday.input)).toEqual(
      new Map([
        ["2026-09-07", 1],
        ["2026-09-14", 1],
      ]),
    );
  });
});

describe("デプロイ 0 件の週", () => {
  it("間に挟まった 0 件の週が、週の並びに現れる", () => {
    expect(deployCountsByWeek(zeroDeploymentWeek.input)).toEqual(
      new Map([
        ["2026-08-31", 1],
        ["2026-09-07", 0],
        ["2026-09-14", 1],
      ]),
    );
  });

  it("0 件の週はすべて収集済みで、本物の 0 として扱える", () => {
    for (const week of weeksBetween(zeroDeploymentWeek.input.period)) {
      expect(classifyWeekCoverage(zeroDeploymentWeek.input.coverage, week), week.key).toBe(
        "covered",
      );
    }
  });
});

describe("収集未到達の週", () => {
  it("デプロイ 0 件は同じでも、カバレッジで 3 通りに分かれる", () => {
    const coverages = weeksBetween(uncoveredWeek.input.period).map(
      (week) => [week.key, classifyWeekCoverage(uncoveredWeek.input.coverage, week)] as const,
    );

    expect(new Map(coverages)).toEqual(
      new Map([
        // バックフィル未到達。デプロイ 0 件ではなく「データなし」。
        ["2026-08-31", "uncovered"],
        ["2026-09-07", "covered"],
        // 週の途中までしか収集していない（進行中の今週）。
        ["2026-09-14", "partial"],
      ]),
    );
    expect(deployCountsByWeek(uncoveredWeek.input)).toEqual(
      new Map([
        ["2026-08-31", 0],
        ["2026-09-07", 0],
        ["2026-09-14", 0],
      ]),
    );
  });
});

describe("同一時刻に複数デプロイ", () => {
  it("同じ時刻の 2 件が 2 回として数えられる", () => {
    const { deployments } = simultaneousDeployments.input;

    expect(new Set(deployments.map((item) => item.deployedAt)).size).toBe(1);
    expect(new Set(deployments.map((item) => item.commitSha)).size).toBe(2);
    expect(deployCountsByWeek(simultaneousDeployments.input)).toEqual(new Map([["2026-09-14", 2]]));
  });
});

describe("データ点が 1 件しかない週", () => {
  it("週に 1 件だけ、かつ間隔が 1 本も作れない", () => {
    expect(deployCountsByWeek(singleDataPointWeek.input)).toEqual(new Map([["2026-09-14", 1]]));
    // 間隔は連続する 2 デプロイの差なので、1 件では 0 本。中央値は出せない（ADR-0004）。
    expect(singleDataPointWeek.input.deployments.length - 1).toBe(0);
  });
});

describe("極端に長いリードタイム", () => {
  it("3 週間前のコミットが、merge されたデプロイの週に割り当たっている", () => {
    const [assignment] = longLeadTimeCommit.input.deployCommits;
    const stale = longLeadTimeCommit.input.commits.find((commit) => commit.sha === "commit-stale");
    const [deployment] = longLeadTimeCommit.input.deployments;

    if (assignment === undefined || stale === undefined || deployment === undefined) {
      throw new Error("シナリオが壊れている");
    }
    expect(assignment.commitShas).toContain(stale.sha);

    // 時刻順近似なら消えるコミット: committer date はデプロイ週より 3 週間前にある
    // （ADR-0004 / #15 が却下した方法では集計から丸ごと落ちる）。
    const leadTimeDays =
      (Date.parse(deployment.deployedAt) - Date.parse(stale.committedAt)) / 86_400_000;
    expect(leadTimeDays).toBeGreaterThan(21);
    expect(bucketByWeek([stale], (commit) => commit.committedAt).has("2026-08-24")).toBe(true);
    expect(deployCountsByWeek(longLeadTimeCommit.input).get("2026-09-14")).toBe(1);
  });

  it("3 区間内訳に要る PR の時刻が揃っている", () => {
    const [pullRequest] = longLeadTimeCommit.input.pullRequests;

    expect(pullRequest?.mergeCommitSha).toBe("merge-stale-branch");
    expect(pullRequest?.mergedAt).toBe(longLeadTimeCommit.input.deployments[0]?.deployedAt);
  });
});

describe("PR を経由しない直接 push", () => {
  it("PR が 1 件も無いまま、コミットがデプロイに割り当たっている", () => {
    const [assignment] = directPushCommit.input.deployCommits;

    expect(directPushCommit.input.pullRequests).toEqual([]);
    expect(assignment?.commitShas).toContain("commit-direct-push");
  });
});
