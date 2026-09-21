/**
 * 変更のリードタイム（#18）のテスト。
 *
 * **DB も外部 API も使わない**（`better-sqlite3` も `fetch` も出てこない）。
 * ADR-0004 が決めた「指標計算を純粋関数に切り出し、fixture でユニットテストする」の実践。
 *
 * ## 2 種類の入力を使い分ける
 *
 * - **境界条件**は `__fixtures__/scenarios.ts` の名前付きシナリオを使う（#16）。
 *   期待値をこのファイルで作り直すと、#17 と #18 が別々の「週の境目」を持ててしまう。
 * - **代表値の計算そのもの**（中央値・p75・p90・3 区間内訳）と `truncated` の除外は、
 *   このファイル内で組み立てた入力で確かめる。共有シナリオは 8 本とも標本が 2 件以下で、
 *   `MIN_SAMPLES`（= 3）のゲートに掛かって代表値が出ないため。
 *   共有シナリオ側を増やさないのは、#17 が同じファイルを並行で触っているから。
 */

import { describe, expect, it } from "vitest";
import {
  directPushCommit,
  longLeadTimeCommit,
  simultaneousDeployments,
  singleDataPointWeek,
  uncoveredWeek,
  utcSundayIsJstMonday,
  weekBoundary,
  zeroDeploymentWeek,
} from "./__fixtures__/scenarios.ts";
import {
  calculateLeadTime,
  LEAD_TIME_UNIT,
  LEAD_TIME_UNIT_LABEL,
  type LeadTimeMetrics,
  type LeadTimeWeek,
  toLeadTimeBreakdownChart,
  toLeadTimeChart,
} from "./lead-time.ts";
import type {
  CommitSample,
  DeployCommitAssignment,
  DeploymentSample,
  MetricsInput,
  PullRequestSample,
} from "./types.ts";

const SCOPE_ID = "sample-app";
const DETECTION_RULE = "default_branch:merge_only";

/** 2026-09-14 週（JST 月曜 00:00 = 2026-09-13T15:00:00Z）だけを含む期間。 */
const ONE_WEEK = { from: "2026-09-14T00:00:00Z", to: "2026-09-20T00:00:00Z" };

function input(parts: {
  deployments: DeploymentSample[];
  commits: CommitSample[];
  deployCommits: DeployCommitAssignment[];
  pullRequests?: PullRequestSample[];
  period?: { from: string; to: string };
}): MetricsInput {
  return {
    scopeId: SCOPE_ID,
    detectionRule: DETECTION_RULE,
    period: parts.period ?? ONE_WEEK,
    deployments: parts.deployments,
    commits: parts.commits,
    pullRequests: parts.pullRequests ?? [],
    deployCommits: parts.deployCommits,
    coverage: {
      backfilledUntil: "2026-09-13T15:00:00.000Z",
      backfillComplete: true,
      lastSuccessAt: "2026-09-20T15:00:00.000Z",
    },
  };
}

function deployment(commitSha: string, deployedAt: string): DeploymentSample {
  return { commitSha, deployedAt, detectionRule: DETECTION_RULE };
}

function weekOfKey(metrics: LeadTimeMetrics, key: string): LeadTimeWeek {
  const week = metrics.weeks.find((candidate) => candidate.week === key);
  if (week === undefined) {
    throw new Error(`週が返り値にありません: ${key}`);
  }
  return week;
}

function sampleCountsByWeek(metrics: LeadTimeMetrics): Map<string, number> {
  return new Map(metrics.weeks.map((week) => [week.week, week.samples.length]));
}

function leadTimeOf(metrics: LeadTimeMetrics, commitSha: string): number {
  const sample = metrics.weeks
    .flatMap((week) => week.samples)
    .find((candidate) => candidate.commitSha === commitSha);
  if (sample === undefined) {
    throw new Error(`標本が集計から消えています: ${commitSha}`);
  }
  return sample.leadTimeHours;
}

/* --- 値の単位 ------------------------------------------------------------ */

describe("値の単位", () => {
  it("時間（hours）で返す", () => {
    const metrics = calculateLeadTime(directPushCommit.input);

    expect(metrics.unit).toBe("hours");
    expect(LEAD_TIME_UNIT).toBe("hours");
    expect(LEAD_TIME_UNIT_LABEL).toBe("時間");
    // commit-direct-push は 2026-09-15T03:00 にコミットされ 05:00 にデプロイされた。
    expect(leadTimeOf(metrics, "commit-direct-push")).toBe(2);
  });
});

/* --- 完了条件: 長期間放置された branch ------------------------------------ */

describe("極端に長いリードタイム（3 週間放置された branch）", () => {
  const metrics = calculateLeadTime(longLeadTimeCommit.input);

  it("集計から消えず、長いリードタイムとして現れる", () => {
    // 時刻順近似（ADR-0004 が却下）ならこのコミットは時間窓に入らず丸ごと消える。
    // 22 日 2 時間 = 530 時間。
    expect(leadTimeOf(metrics, "commit-stale")).toBe(530);
  });

  it("起点のコミット週ではなく、デプロイされた週に載る", () => {
    // commit-stale の committer date は 2026-08-24 週だが、週バケットは終点（デプロイ時刻）で
    // 決めるので 2026-09-14 週に入る。
    expect(sampleCountsByWeek(metrics)).toEqual(
      new Map([
        ["2026-08-24", 0],
        ["2026-08-31", 0],
        ["2026-09-07", 0],
        ["2026-09-14", 2],
      ]),
    );
  });

  it("3 区間内訳が合計リードタイムに分解される", () => {
    const [stale] = weekOfKey(metrics, "2026-09-14").samples.filter(
      (sample) => sample.commitSha === "commit-stale",
    );

    expect(stale?.breakdown).toEqual({
      pullRequestNumber: 101,
      commitToPrOpen: 24, // 2026-08-24T01:00 → 2026-08-25T01:00
      prOpenToMerge: 506, // 2026-08-25T01:00 → 2026-09-15T03:00（21 日 2 時間）
      mergeToDeploy: 0, // デプロイ時刻 = マージコミットの committer date（ADR-0001）
    });
    expect(24 + 506 + 0).toBe(stale?.leadTimeHours);
  });

  it("マージコミット自身は内訳なし（区切り時刻が順番に並ばないため）", () => {
    const [merge] = weekOfKey(metrics, "2026-09-14").samples.filter(
      (sample) => sample.commitSha === "merge-stale-branch",
    );

    // マージコミットの committer date は PR の作成時刻より後。内訳を作ると
    // 「コミット → PR open」が負になる。合計（0 時間）だけ残して内訳は無しにする。
    expect(merge?.leadTimeHours).toBe(0);
    expect(merge?.breakdown).toBeNull();
  });

  it("標本が 2 件しかないので代表値は出さない（値なしであって 0 ではない）", () => {
    const week = weekOfKey(metrics, "2026-09-14");

    expect(week.samples).toHaveLength(2);
    expect(week.summary).toBeNull();
    expect(week.breakdown).toBeNull();
  });
});

/* --- 完了条件: PR を経由しない直接 push ----------------------------------- */

describe("PR を経由しない直接 push", () => {
  it("内訳は無しで、合計は出る", () => {
    // minSamples = 1 でゲートを外し、代表値まで出ることを確かめる
    // （このシナリオは標本 2 件で、既定の MIN_SAMPLES = 3 には届かない）。
    const metrics = calculateLeadTime(directPushCommit.input, { minSamples: 1 });
    const week = weekOfKey(metrics, "2026-09-14");

    expect(week.samples.map((sample) => sample.commitSha)).toEqual([
      "commit-direct-push",
      "deploy-direct-push",
    ]);
    // 内訳を 0 で埋めない（0 秒でレビューされたように見えるため）。
    expect(week.samples.every((sample) => sample.breakdown === null)).toBe(true);

    // 合計は出る: [2, 0] の中央値は 1。
    expect(week.summary).toEqual({ count: 2, median: 1, p75: 1.5, p90: 1.8 });
    // 内訳を持つ標本が 1 件も無いので、内訳の代表値は出ない。
    expect(week.breakdown).toBeNull();
  });
});

/* --- 境界条件（#16 のシナリオ） ------------------------------------------ */

describe("週バケットの境界", () => {
  it("JST 月曜 00:00 ちょうどは新しい週に入り、1 ミリ秒前は前の週に残る", () => {
    const metrics = calculateLeadTime(weekBoundary.input);

    expect(sampleCountsByWeek(metrics)).toEqual(
      new Map([
        ["2026-09-07", 1],
        ["2026-09-14", 2],
      ]),
    );
  });
});

describe("タイムゾーン", () => {
  it("UTC の同じ日曜のデプロイが、JST では別の週に落ちる", () => {
    const metrics = calculateLeadTime(utcSundayIsJstMonday.input);

    expect(sampleCountsByWeek(metrics)).toEqual(
      new Map([
        ["2026-09-07", 1],
        ["2026-09-14", 1],
      ]),
    );
  });
});

describe("標本 0 件の週", () => {
  it("間に挟まった 0 件の週も、週の並びに現れる", () => {
    const metrics = calculateLeadTime(zeroDeploymentWeek.input);

    expect(sampleCountsByWeek(metrics)).toEqual(
      new Map([
        ["2026-08-31", 1],
        ["2026-09-07", 0],
        ["2026-09-14", 1],
      ]),
    );
    // 標本 0 件の週の代表値は「値なし」。0 時間ではない。
    expect(weekOfKey(metrics, "2026-09-07").summary).toBeNull();
  });
});

describe("収集未到達の週", () => {
  it("標本 0 件は同じでも、カバレッジで 3 通りに分かれる", () => {
    const metrics = calculateLeadTime(uncoveredWeek.input);

    expect(new Map(metrics.weeks.map((week) => [week.week, week.coverage]))).toEqual(
      new Map([
        ["2026-08-31", "uncovered"],
        ["2026-09-07", "covered"],
        ["2026-09-14", "partial"],
      ]),
    );
    expect(metrics.weeks.every((week) => week.samples.length === 0)).toBe(true);
  });
});

describe("同一時刻に複数デプロイ", () => {
  it("同時刻の 2 デプロイのコミットが、どちらも標本になる", () => {
    const metrics = calculateLeadTime(simultaneousDeployments.input, { minSamples: 1 });
    const week = weekOfKey(metrics, "2026-09-14");

    expect(week.samples.map((sample) => sample.commitSha).sort()).toEqual([
      "deploy-same-a",
      "deploy-same-b",
    ]);
    // 時刻で重複排除してはいけない（別のコミットの別のデプロイである）。
    expect(week.summary?.count).toBe(2);
  });
});

describe("データ点が 1 件しかない週", () => {
  it("標本は残すが、代表値は出さない（ADR-0004）", () => {
    const metrics = calculateLeadTime(singleDataPointWeek.input);
    const week = weekOfKey(metrics, "2026-09-14");

    expect(week.samples).toHaveLength(1);
    expect(week.summary).toBeNull();
  });
});

/* --- 代表値の計算 -------------------------------------------------------- */

describe("代表値", () => {
  /** 2026-09-14 週に 5 件。リードタイムは 0 / 1 / 2 / 3 / 100 時間（右に長い裾）。 */
  const skewed = input({
    deployments: [deployment("merge-agg", "2026-09-15T12:00:00.000Z")],
    commits: [
      { sha: "merge-agg", committedAt: "2026-09-15T12:00:00.000Z" }, // 0h
      { sha: "c1", committedAt: "2026-09-15T11:00:00.000Z" }, // 1h
      { sha: "c2", committedAt: "2026-09-15T10:00:00.000Z" }, // 2h
      { sha: "c3", committedAt: "2026-09-15T09:00:00.000Z" }, // 3h
      { sha: "c4", committedAt: "2026-09-11T08:00:00.000Z" }, // 100h
    ],
    deployCommits: [
      {
        deploymentCommitSha: "merge-agg",
        baseSha: "deploy-base",
        commitShas: ["c1", "c2", "c3", "c4", "merge-agg"],
        truncated: false,
      },
    ],
  });

  it("中央値を主線に、p75 / p90 も返す（平均は返さない）", () => {
    const week = weekOfKey(calculateLeadTime(skewed), "2026-09-14");

    // [0, 1, 2, 3, 100] の線形補間（statistics.ts）。
    // p90 は二進小数で割り切れないので誤差を許す（丸めは表示側の仕事。lead-time.ts 参照）。
    expect(week.summary?.count).toBe(5);
    expect(week.summary?.median).toBe(2);
    expect(week.summary?.p75).toBe(3);
    expect(week.summary?.p90).toBeCloseTo(61.2, 10);
    // 平均（21.2 時間）は持たない。外れ値 1 件で跳ねるため（ADR-0004）。
    expect(week.summary).not.toHaveProperty("mean");
    expect(week.summary).not.toHaveProperty("average");
  });

  it("外れ値 1 件が中央値を動かさず、p90 に現れる", () => {
    const week = weekOfKey(calculateLeadTime(skewed), "2026-09-14");

    expect(week.summary?.median).toBeLessThan(5);
    expect(week.summary?.p90).toBeGreaterThan(50);
  });
});

/* --- merged_at とデプロイ時刻のズレ（#51） -------------------------------- */

describe("merged_at がデプロイ時刻より後でも内訳を落とさない（#51）", () => {
  /**
   * `default_branch` ルールのデプロイ時刻はマージコミットの committer date（ADR-0001 決定 4）。
   * GitHub は「マージコミットを作る → merged として記録する」順に書くので、
   * **`merged_at` は構造的に常にデプロイ時刻以上**になる。
   *
   * 実測（#23 の E2E、ymiyamoto63/four-keys-sample-service）:
   *
   * | PR | merged_at | デプロイ時刻 | 差 |
   * | -- | --------- | ------------ | -- |
   * | #1 | 04:27:45Z | 04:27:44Z    | +1 秒 |
   * | #2 | 06:55:28Z | 06:55:28Z    | 0 秒 |
   * | #3 | 06:55:41Z | 06:55:41Z    | 0 秒 |
   *
   * 以前は `merged_at <= デプロイ時刻` を要求していたので、#1 だけ内訳が落ちた。
   */
  function withSkew(skewSeconds: number) {
    const deployedAt = "2026-09-15T12:00:00.000Z";
    const mergedAt = new Date(Date.parse(deployedAt) + skewSeconds * 1000).toISOString();
    return input({
      deployments: [deployment("merge-skew", deployedAt)],
      commits: [
        { sha: "head-1", committedAt: "2026-09-15T06:00:00.000Z" },
        { sha: "head-2", committedAt: "2026-09-15T05:00:00.000Z" },
        { sha: "head-3", committedAt: "2026-09-15T04:00:00.000Z" },
      ],
      pullRequests: [1, 2, 3].map((number) => ({
        number,
        headSha: `head-${number}`,
        createdAt: "2026-09-15T08:00:00.000Z",
        mergedAt,
        mergeCommitSha: null,
      })),
      deployCommits: [
        {
          deploymentCommitSha: "merge-skew",
          baseSha: "deploy-base",
          commitShas: ["head-1", "head-2", "head-3"],
          truncated: false,
        },
      ],
    });
  }

  it("1 秒のズレでも内訳が出て、merge → デプロイ は 0 になる", () => {
    const week = weekOfKey(calculateLeadTime(withSkew(1)), "2026-09-14");

    expect(week.breakdown?.count).toBe(3);
    // 0 に倒す。merge_only では merge がデプロイそのものなので、これは近似ではない。
    expect(week.breakdown?.mergeToDeploy.median).toBe(0);
    expect(week.samples.every((sample) => sample.breakdown !== null)).toBe(true);
  });

  it.each([0, 1, 30, 60])("ズレ %s 秒までは内訳を出す", (skew) => {
    const week = weekOfKey(calculateLeadTime(withSkew(skew)), "2026-09-14");
    expect(week.breakdown?.count).toBe(3);
    expect(week.breakdown?.mergeToDeploy.median).toBe(0);
  });

  it("許容幅を超えるズレは内訳を作らない（別のデプロイが先に運んだケース）", () => {
    // 数分〜数日ずれるのは cherry-pick などで別のデプロイが先にそのコミットを運んだ場合。
    // そこを 0 に潰すと「デプロイ待ち 0 時間」が実在したように見える。
    const week = weekOfKey(calculateLeadTime(withSkew(61)), "2026-09-14");

    expect(week.breakdown).toBeNull();
    expect(week.samples.every((sample) => sample.breakdown === null)).toBe(true);
    // 合計リードタイムは残る（内訳だけ無しに倒す）。
    expect(week.summary).not.toBeNull();
  });

  it("デプロイ時刻が merged_at より後なら、その差がそのまま merge → デプロイ になる", () => {
    // workflow_run ルールではデプロイ時刻が merged_at の数分後になる。ここは素直に測る。
    const week = weekOfKey(calculateLeadTime(withSkew(-3600)), "2026-09-14");
    expect(week.breakdown?.mergeToDeploy.median).toBe(1);
  });

  it("コミット → PR open が負のときは、これまでどおり内訳なし", () => {
    // 許容幅は「merge → デプロイ」だけに効く。マージコミット自身を救ってはいけない。
    const deployedAt = "2026-09-15T12:00:00.000Z";
    const metrics = calculateLeadTime(
      input({
        deployments: [deployment("merge-self", deployedAt)],
        commits: [{ sha: "merge-self", committedAt: deployedAt }],
        pullRequests: [
          {
            number: 9,
            headSha: "merge-self",
            // PR の作成時刻がコミットより前 = マージコミット自身の形。
            createdAt: "2026-09-15T08:00:00.000Z",
            mergedAt: deployedAt,
            mergeCommitSha: null,
          },
        ],
        deployCommits: [
          {
            deploymentCommitSha: "merge-self",
            baseSha: "deploy-base",
            commitShas: ["merge-self"],
            truncated: false,
          },
        ],
      }),
      { minSamples: 1 },
    );
    const week = weekOfKey(metrics, "2026-09-14");

    expect(week.samples[0]?.breakdown).toBeNull();
    expect(week.summary).not.toBeNull();
  });
});

/* --- 3 区間内訳の代表値 --------------------------------------------------- */

describe("3 区間内訳の代表値", () => {
  /**
   * 1 デプロイに 3 本の PR（squash merge 相当で `mergeCommitSha` は無し）と
   * マージコミット自身が入る週。内訳を持つのは PR 由来の 3 件だけ。
   */
  const breakdownInput = input({
    deployments: [deployment("merge-bd", "2026-09-15T12:00:00.000Z")],
    commits: [
      { sha: "merge-bd", committedAt: "2026-09-15T12:00:00.000Z" }, // 0h（内訳なし）
      { sha: "b1", committedAt: "2026-09-14T12:00:00.000Z" }, // 24h
      { sha: "b2", committedAt: "2026-09-13T12:00:00.000Z" }, // 48h
      { sha: "b3", committedAt: "2026-09-12T12:00:00.000Z" }, // 72h
    ],
    pullRequests: [
      {
        number: 1,
        headSha: "b1",
        createdAt: "2026-09-14T18:00:00.000Z", // 6h
        mergedAt: "2026-09-15T06:00:00.000Z", // 12h → 残り 6h
        mergeCommitSha: null,
      },
      {
        number: 2,
        headSha: "b2",
        createdAt: "2026-09-13T14:00:00.000Z", // 2h
        mergedAt: "2026-09-15T02:00:00.000Z", // 36h → 残り 10h
        mergeCommitSha: null,
      },
      {
        number: 3,
        headSha: "b3",
        createdAt: "2026-09-12T16:00:00.000Z", // 4h
        mergedAt: "2026-09-14T12:00:00.000Z", // 44h → 残り 24h
        mergeCommitSha: null,
      },
    ],
    deployCommits: [
      {
        deploymentCommitSha: "merge-bd",
        baseSha: "deploy-base",
        commitShas: ["b1", "b2", "b3", "merge-bd"],
        truncated: false,
      },
    ],
  });

  it("コミット → PR open / PR open → merge / merge → デプロイ を返す", () => {
    const week = weekOfKey(calculateLeadTime(breakdownInput), "2026-09-14");

    expect(week.breakdown?.count).toBe(3);
    // p90 は二進小数で割り切れないので誤差を許す。
    expect(week.breakdown?.commitToPrOpen).toMatchObject({ count: 3, median: 4, p75: 5 }); // [2, 4, 6]
    expect(week.breakdown?.commitToPrOpen.p90).toBeCloseTo(5.6, 10);
    expect(week.breakdown?.prOpenToMerge).toMatchObject({ count: 3, median: 36, p75: 40 }); // [12, 36, 44]
    expect(week.breakdown?.prOpenToMerge.p90).toBeCloseTo(42.4, 10);
    expect(week.breakdown?.mergeToDeploy).toMatchObject({ count: 3, median: 10, p75: 17 }); // [6, 10, 24]
    expect(week.breakdown?.mergeToDeploy.p90).toBeCloseTo(21.2, 10);
  });

  it("内訳の標本数ゲートは合計とは別に掛かる", () => {
    const week = weekOfKey(calculateLeadTime(breakdownInput), "2026-09-14");

    // 合計の標本は 4 件（マージコミットを含む）、内訳を持つのは 3 件。
    expect(week.summary?.count).toBe(4);
    expect(week.breakdown?.count).toBe(3);

    // 内訳側が 4 件必要なゲートでは、合計は出ても内訳は出ない。
    const stricter = weekOfKey(calculateLeadTime(breakdownInput, { minSamples: 4 }), "2026-09-14");
    expect(stricter.summary?.count).toBe(4);
    expect(stricter.breakdown).toBeNull();
  });

  it("未マージの PR に当たったコミットは内訳なし", () => {
    const unmerged = input({
      deployments: [deployment("merge-um", "2026-09-15T12:00:00.000Z")],
      commits: [{ sha: "u1", committedAt: "2026-09-15T10:00:00.000Z" }],
      pullRequests: [
        {
          number: 9,
          headSha: "u1",
          createdAt: "2026-09-15T11:00:00.000Z",
          mergedAt: null,
          mergeCommitSha: null,
        },
      ],
      deployCommits: [
        {
          deploymentCommitSha: "merge-um",
          baseSha: "deploy-base",
          commitShas: ["u1"],
          truncated: false,
        },
      ],
    });

    const [sample] = weekOfKey(calculateLeadTime(unmerged), "2026-09-14").samples;
    expect(sample?.leadTimeHours).toBe(2);
    expect(sample?.breakdown).toBeNull();
  });
});

/* --- truncated の除外 ----------------------------------------------------- */

describe("compare が打ち切られた割り当て（truncated）", () => {
  const withTruncated = input({
    deployments: [
      deployment("deploy-ok", "2026-09-15T06:00:00.000Z"),
      deployment("deploy-trunc", "2026-09-16T06:00:00.000Z"),
    ],
    commits: [
      { sha: "deploy-ok", committedAt: "2026-09-15T06:00:00.000Z" },
      { sha: "t1", committedAt: "2026-09-15T04:00:00.000Z" },
      { sha: "deploy-trunc", committedAt: "2026-09-16T06:00:00.000Z" },
      { sha: "t2", committedAt: "2026-09-15T20:00:00.000Z" },
    ],
    deployCommits: [
      {
        deploymentCommitSha: "deploy-ok",
        baseSha: "deploy-base",
        commitShas: ["t1", "deploy-ok"],
        truncated: false,
      },
      {
        deploymentCommitSha: "deploy-trunc",
        baseSha: "deploy-ok",
        commitShas: ["t2", "deploy-trunc"],
        truncated: true,
      },
    ],
  });

  it("標本にしない（取りこぼしを含んだまま集計しない）", () => {
    const week = weekOfKey(calculateLeadTime(withTruncated, { minSamples: 1 }), "2026-09-14");

    expect(week.samples.map((sample) => sample.commitSha)).toEqual(["t1", "deploy-ok"]);
    expect(week.summary?.count).toBe(2);
  });

  it("除外したことが分かる形で返す（黙って減らさない）", () => {
    const week = weekOfKey(calculateLeadTime(withTruncated), "2026-09-14");

    expect(week.excluded.truncatedDeployments).toEqual(["deploy-trunc"]);
  });
});

/* --- その他の除外・重複 --------------------------------------------------- */

describe("標本にできなかったもの", () => {
  it("commits に無い SHA は起点が取れないので除外し、その事実を返す", () => {
    const metrics = calculateLeadTime(
      input({
        deployments: [deployment("deploy-x", "2026-09-15T06:00:00.000Z")],
        commits: [{ sha: "deploy-x", committedAt: "2026-09-15T06:00:00.000Z" }],
        deployCommits: [
          {
            deploymentCommitSha: "deploy-x",
            baseSha: "deploy-base",
            commitShas: ["not-collected", "deploy-x"],
            truncated: false,
          },
        ],
      }),
    );
    const week = weekOfKey(metrics, "2026-09-14");

    expect(week.samples.map((sample) => sample.commitSha)).toEqual(["deploy-x"]);
    expect(week.excluded.unknownCommitShas).toEqual(["not-collected"]);
  });

  it("対応するデプロイが無い割り当ては orphan として返す", () => {
    const metrics = calculateLeadTime(
      input({
        deployments: [],
        commits: [{ sha: "orphan-commit", committedAt: "2026-09-15T06:00:00.000Z" }],
        deployCommits: [
          {
            deploymentCommitSha: "deploy-missing",
            baseSha: "deploy-base",
            commitShas: ["orphan-commit"],
            truncated: false,
          },
        ],
      }),
    );

    expect(metrics.orphanAssignments).toEqual(["deploy-missing"]);
    expect(metrics.weeks.every((week) => week.samples.length === 0)).toBe(true);
  });

  it("同じコミットが複数のデプロイに現れても、最初に運んだデプロイにだけ載る", () => {
    // 入力の並び順は保証されないので、後のデプロイを先頭に置いて確かめる。
    const metrics = calculateLeadTime(
      input({
        deployments: [
          deployment("deploy-late", "2026-09-17T06:00:00.000Z"),
          deployment("deploy-early", "2026-09-15T06:00:00.000Z"),
        ],
        commits: [
          { sha: "dup", committedAt: "2026-09-15T04:00:00.000Z" },
          { sha: "deploy-early", committedAt: "2026-09-15T06:00:00.000Z" },
          { sha: "deploy-late", committedAt: "2026-09-17T06:00:00.000Z" },
        ],
        deployCommits: [
          {
            deploymentCommitSha: "deploy-late",
            baseSha: "deploy-base",
            commitShas: ["dup", "deploy-late"],
            truncated: false,
          },
          {
            deploymentCommitSha: "deploy-early",
            baseSha: "deploy-base",
            commitShas: ["dup", "deploy-early"],
            truncated: false,
          },
        ],
      }),
    );
    const week = weekOfKey(metrics, "2026-09-14");
    const dup = week.samples.filter((sample) => sample.commitSha === "dup");

    expect(dup).toHaveLength(1);
    expect(dup[0]?.deploymentCommitSha).toBe("deploy-early");
    expect(dup[0]?.leadTimeHours).toBe(2);
  });
});

/* --- 画面へ渡す形（#20 / #21） -------------------------------------------- */

describe("チャートへ渡す形", () => {
  const metrics = calculateLeadTime(longLeadTimeCommit.input, { minSamples: 1 });

  it("中央値が primary、p75 / p90 が secondary", () => {
    const chart = toLeadTimeChart(metrics);

    expect(chart.unitLabel).toBe("時間");
    expect(chart.weeks).toEqual(["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"]);
    expect(chart.series.map((series) => [series.name, series.role])).toEqual([
      ["中央値", "primary"],
      ["p75", "secondary"],
      ["p90", "secondary"],
    ]);
  });

  it("値なしの週は null のまま渡す（欠損週で線を繋がせない）", () => {
    const [medianSeries] = toLeadTimeChart(metrics).series;

    expect(medianSeries?.points).toEqual([
      { week: "2026-08-24", value: null },
      { week: "2026-08-31", value: null },
      { week: "2026-09-07", value: null },
      // [0, 530] の中央値。
      { week: "2026-09-14", value: 265 },
    ]);
  });

  it("内訳は 3 区間の中央値を並べる", () => {
    const chart = toLeadTimeBreakdownChart(metrics);

    expect(chart.series.map((series) => series.name)).toEqual([
      "コミット → PR open",
      "PR open → merge",
      "merge → デプロイ",
    ]);
    // 内訳を持つのは commit-stale の 1 件だけ（minSamples = 1 なので出る）。
    expect(chart.series.map((series) => series.points.at(-1)?.value)).toEqual([24, 506, 0]);
  });
});

/* --- 引数の検査 ---------------------------------------------------------- */

describe("引数の検査", () => {
  it("最小標本数が 1 未満なら落とす", () => {
    expect(() => calculateLeadTime(directPushCommit.input, { minSamples: 0 })).toThrow(
      /最小標本数/,
    );
  });
});
