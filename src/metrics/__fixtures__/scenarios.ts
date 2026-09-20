/**
 * 境界条件の名前付きシナリオ（#16）。
 *
 * ADR-0004 は「実際に壊れるのは**週バケットの境界・タイムゾーン・デプロイ 0 件の週・
 * 同一時刻の複数デプロイ**といった境界条件で、これらをサンプルリポジトリ上で意図的に
 * 発生させるのは不可能か極めて手間」と書いている。**その「意図的に発生させた入力」がここ。**
 *
 * デプロイ頻度（#17）と変更のリードタイム（#18）は、それぞれの期待値を自分で書く代わりに
 * **このシナリオを import して使う**。両指標が同じ入力を見ることで、片方だけが
 * 週境界の扱いを変えた場合に気付ける。
 *
 * 記録した API レスポンスから組み立てる入力（`fixtures.ts`）とは役割が違う。
 * あちらは「本物のレスポンスから本当に組み立てられるか」、こちらは「境界で何が起きるか」。
 *
 * ## 時刻の読み方
 *
 * 本アプリは時刻を UTC で保存し JST で集計する（ADR-0004）。
 * **JST 月曜 00:00 は UTC 日曜 15:00** である。以下の `...T15:00:00.000Z` はすべて週の境目。
 *
 * ## SHA について
 *
 * 実際の 40 桁 16 進ではなく読める識別子にしてある。本物のレスポンス形を確かめるのは
 * `recorded-responses.json` 側の仕事で、ここで見たいのは時刻の関係だけである。
 */

import type {
  CollectionCoverage,
  CommitSample,
  DeployCommitAssignment,
  DeploymentSample,
  MetricsInput,
  PullRequestSample,
} from "../types.ts";
import type { Period } from "../week.ts";

export type MetricsScenario = {
  /** シナリオ名。テスト名にそのまま使えるようにしてある。 */
  name: string;
  /** 何を固定するシナリオで、指標側は何を確かめるべきか。 */
  description: string;
  input: MetricsInput;
};

const SCOPE_ID = "sample-app";
/** 既定の検出ルール。ADR-0001 が既定にした粒度。 */
const DETECTION_RULE = "default_branch:merge_only";

function deployment(commitSha: string, deployedAt: string): DeploymentSample {
  return { commitSha, deployedAt, detectionRule: DETECTION_RULE };
}

/** デプロイと、そのデプロイ 1 件だけを含む差分（PR を経由しない直接 push の形）。 */
function selfContainedDeploy(
  sha: string,
  at: string,
  baseSha: string,
): { deployment: DeploymentSample; commit: CommitSample; assignment: DeployCommitAssignment } {
  return {
    deployment: deployment(sha, at),
    commit: { sha, committedAt: at },
    assignment: {
      deploymentCommitSha: sha,
      baseSha,
      commitShas: [sha],
      truncated: false,
    },
  };
}

/** 期間全体が収集済みのカバレッジ。 */
function collected(from: string, to: string): CollectionCoverage {
  return { backfilledUntil: from, backfillComplete: true, lastSuccessAt: to };
}

function scenario(
  name: string,
  description: string,
  parts: {
    period: Period;
    coverage: CollectionCoverage;
    deployments: DeploymentSample[];
    commits: CommitSample[];
    deployCommits: DeployCommitAssignment[];
    pullRequests?: PullRequestSample[];
  },
): MetricsScenario {
  return {
    name,
    description,
    input: {
      scopeId: SCOPE_ID,
      detectionRule: DETECTION_RULE,
      period: parts.period,
      deployments: parts.deployments,
      commits: parts.commits,
      pullRequests: parts.pullRequests ?? [],
      deployCommits: parts.deployCommits,
      coverage: parts.coverage,
    },
  };
}

/* --- 週バケットの境界 ---------------------------------------------------- */

const before = selfContainedDeploy("deploy-1ms-before", "2026-09-13T14:59:59.999Z", "deploy-base");
const exact = selfContainedDeploy(
  "deploy-monday-0000",
  "2026-09-13T15:00:00.000Z",
  before.commit.sha,
);
const after = selfContainedDeploy("deploy-1ms-after", "2026-09-13T15:00:00.001Z", exact.commit.sha);

/**
 * 週の境目そのもの。JST 月曜 00:00 ちょうどのデプロイと、その 1 ミリ秒前後。
 *
 * 週は `[startedAt, endedAt)` の半開区間なので、**ちょうどの 1 件は新しい週に入る**。
 * 閉区間で実装すると両方の週に数えられ、週あたり回数が二重計上される。
 */
export const weekBoundary: MetricsScenario = scenario(
  "週バケットの境界（JST 月曜 00:00 の前後 1 ミリ秒）",
  "1 ミリ秒前は 2026-09-07 週、ちょうどと 1 ミリ秒後は 2026-09-14 週。合計 3 件が 1+2 に割れる",
  {
    period: { from: "2026-09-07T00:00:00Z", to: "2026-09-20T00:00:00Z" },
    coverage: collected("2026-08-30T15:00:00.000Z", "2026-09-20T15:00:00.000Z"),
    deployments: [before.deployment, exact.deployment, after.deployment],
    commits: [before.commit, exact.commit, after.commit],
    deployCommits: [before.assignment, exact.assignment, after.assignment],
  },
);

/* --- タイムゾーン -------------------------------------------------------- */

const utcSundayEvening = selfContainedDeploy(
  "deploy-utc-sun-1500",
  "2026-09-13T15:00:00.000Z",
  "deploy-base",
);
const utcSundayAfternoon = selfContainedDeploy(
  "deploy-utc-sun-1400",
  "2026-09-13T14:00:00.000Z",
  "deploy-base",
);

/**
 * UTC 保存 → JST 集計の経路。
 *
 * 同じ **UTC の日曜**に起きた 2 件が、JST では別の週に落ちる。
 * UTC のまま週に割ると 2 件とも同じ週になり、この差が消える。
 */
export const utcSundayIsJstMonday: MetricsScenario = scenario(
  "タイムゾーン（UTC 日曜 15:00 = JST 月曜 00:00）",
  "UTC 日曜 14:00 は 2026-09-07 週、UTC 日曜 15:00 は 2026-09-14 週。UTC で割ると両方が同じ週になる",
  {
    period: { from: "2026-09-07T00:00:00Z", to: "2026-09-20T00:00:00Z" },
    coverage: collected("2026-08-30T15:00:00.000Z", "2026-09-20T15:00:00.000Z"),
    deployments: [utcSundayAfternoon.deployment, utcSundayEvening.deployment],
    commits: [utcSundayAfternoon.commit, utcSundayEvening.commit],
    deployCommits: [utcSundayAfternoon.assignment, utcSundayEvening.assignment],
  },
);

/* --- デプロイ 0 件の週 --------------------------------------------------- */

const firstWeekDeploy = selfContainedDeploy("deploy-w1", "2026-09-01T02:00:00.000Z", "deploy-base");
const thirdWeekDeploy = selfContainedDeploy(
  "deploy-w3",
  "2026-09-15T02:00:00.000Z",
  firstWeekDeploy.commit.sha,
);

/**
 * 真ん中の週にデプロイが 1 件も無い。**これは欠損ではなく本物の値 0**（#17）。
 *
 * 生イベント側には何も現れないので、週の並びは期間（`period`）から作るしかない。
 */
export const zeroDeploymentWeek: MetricsScenario = scenario(
  "デプロイ 0 件の週（収集済み）",
  "2026-08-31 / 2026-09-14 週に 1 件ずつ、2026-09-07 週は 0 件。0 件の週も返り値に現れること",
  {
    period: { from: "2026-08-31T00:00:00Z", to: "2026-09-20T00:00:00Z" },
    coverage: collected("2026-08-23T15:00:00.000Z", "2026-09-20T15:00:00.000Z"),
    deployments: [firstWeekDeploy.deployment, thirdWeekDeploy.deployment],
    commits: [firstWeekDeploy.commit, thirdWeekDeploy.commit],
    deployCommits: [firstWeekDeploy.assignment, thirdWeekDeploy.assignment],
  },
);

/**
 * 「収集済みで 0 件」と「収集がまだ届いていない」が同じ期間に同居する。
 *
 * デプロイが 1 件も無いのは 3 週とも同じだが、意味は 3 通りに分かれる（#17 の完了条件）。
 * - 2026-08-31 週: バックフィルが到達していない → **データなし**
 * - 2026-09-07 週: 収集済みで 0 件 → **本物の 0**
 * - 2026-09-14 週: 週の途中までしか収集していない → 数え終わっていない
 */
export const uncoveredWeek: MetricsScenario = scenario(
  "収集未到達の週と、収集済みで 0 件の週",
  "デプロイ 0 件は 3 週とも同じ。カバレッジだけが uncovered / covered / partial を分ける",
  {
    period: { from: "2026-08-31T00:00:00Z", to: "2026-09-20T00:00:00Z" },
    coverage: collected("2026-09-06T15:00:00.000Z", "2026-09-17T00:00:00.000Z"),
    deployments: [],
    commits: [],
    deployCommits: [],
  },
);

/* --- 同一時刻に複数デプロイ ---------------------------------------------- */

const sameInstant = "2026-09-15T02:00:00.000Z";
const simultaneousA = selfContainedDeploy("deploy-same-a", sameInstant, "deploy-base");
const simultaneousB = selfContainedDeploy("deploy-same-b", sameInstant, "deploy-same-a");

/**
 * 同じ時刻に 2 件のデプロイ。
 *
 * 週あたり回数は 2（時刻で重複排除してはいけない。別のコミットの別のデプロイである）。
 * デプロイ間隔は 0 になるので、間隔の中央値（#17 の副指標）が 0 除算や
 * 負の値にならないことを確かめる場所でもある。
 */
export const simultaneousDeployments: MetricsScenario = scenario(
  "同一時刻に複数デプロイ",
  "同時刻の 2 件を 2 回として数えること。デプロイ間隔は 0 になる",
  {
    period: { from: "2026-09-14T00:00:00Z", to: "2026-09-20T00:00:00Z" },
    coverage: collected("2026-09-13T15:00:00.000Z", "2026-09-20T15:00:00.000Z"),
    deployments: [simultaneousA.deployment, simultaneousB.deployment],
    commits: [simultaneousA.commit, simultaneousB.commit],
    deployCommits: [simultaneousA.assignment, simultaneousB.assignment],
  },
);

/* --- データ点が 1 件しかない週 ------------------------------------------- */

const lonely = selfContainedDeploy("deploy-lonely", "2026-09-15T02:00:00.000Z", "deploy-base");

/**
 * 週の中にデプロイもコミットも 1 件しかない。
 *
 * **週あたり回数は 1 を返す**（#17。回数には少数サンプルの扱いを適用しない）。
 * 一方で**リードタイムの中央値とデプロイ間隔の中央値は値を出さない**
 * （ADR-0004「データ点が少ない週は値を出さず、線も繋がない」。
 * 間隔はそもそも 1 件では 1 本も作れない）。
 */
export const singleDataPointWeek: MetricsScenario = scenario(
  "データ点が 1 件しかない週",
  "回数は 1、中央値系は値なし。少数サンプルの中央値を線で繋がないこと（ADR-0004）",
  {
    period: { from: "2026-09-14T00:00:00Z", to: "2026-09-20T00:00:00Z" },
    coverage: collected("2026-09-13T15:00:00.000Z", "2026-09-20T15:00:00.000Z"),
    deployments: [lonely.deployment],
    commits: [lonely.commit],
    deployCommits: [lonely.assignment],
  },
);

/* --- 極端に長いリードタイム ---------------------------------------------- */

/**
 * 3 週間放置された branch が merge される。
 *
 * 古いコミットの committer date は 2026-08-24（デプロイ週の 3 週間前）だが、
 * 含まれるデプロイは 2026-09-15。**時刻順近似ならこのコミットは集計から丸ごと消える**
 * （ADR-0004 / #15 が却下した方法）。compare 由来の割り当てを入力にしているので、
 * 長いリードタイム（約 22 日）として 2026-09-14 週に現れなければならない（#18 の完了条件）。
 *
 * 3 区間内訳もここで確かめられる。コミット → PR open が 1 日、PR open → merge が約 21 日、
 * merge → デプロイが 0（マージコミットの committer date をデプロイ時刻にするため。ADR-0001）。
 */
export const longLeadTimeCommit: MetricsScenario = scenario(
  "極端に長いリードタイム（3 週間放置された branch の merge）",
  "古いコミットが merge されたデプロイの週に、長いリードタイムとして現れること",
  {
    period: { from: "2026-08-24T00:00:00Z", to: "2026-09-20T00:00:00Z" },
    coverage: collected("2026-08-16T15:00:00.000Z", "2026-09-20T15:00:00.000Z"),
    deployments: [deployment("merge-stale-branch", "2026-09-15T03:00:00.000Z")],
    commits: [
      // 3 週間前に作られ、放置されていたコミット。
      { sha: "commit-stale", committedAt: "2026-08-24T01:00:00.000Z" },
      // マージコミット。デプロイ時刻 = この committer date（ADR-0001）。
      { sha: "merge-stale-branch", committedAt: "2026-09-15T03:00:00.000Z" },
    ],
    pullRequests: [
      {
        number: 101,
        createdAt: "2026-08-25T01:00:00.000Z",
        mergedAt: "2026-09-15T03:00:00.000Z",
        mergeCommitSha: "merge-stale-branch",
        headSha: "commit-stale",
      },
    ],
    deployCommits: [
      {
        deploymentCommitSha: "merge-stale-branch",
        baseSha: "deploy-base",
        commitShas: ["commit-stale", "merge-stale-branch"],
        truncated: false,
      },
    ],
  },
);

/* --- PR を経由しない直接 push -------------------------------------------- */

/**
 * デフォルトブランチへの直接 push。
 *
 * **リードタイムの標本単位を PR にしない理由がこれ**（ADR-0004。実リポジトリでは
 * 直接 push の比率が高く、PR 単位だとデータの大半が消える）。
 * 対応する PR が無いので、3 区間内訳は**内訳なし**として扱う（#18）。
 * リードタイムそのものは committer date とデプロイ時刻から計算できる（ここでは 2 時間）。
 */
export const directPushCommit: MetricsScenario = scenario(
  "PR を経由しない直接 push のコミット",
  "PR が 1 件も無くても標本として集計に含まれること。3 区間内訳は内訳なし",
  {
    period: { from: "2026-09-14T00:00:00Z", to: "2026-09-20T00:00:00Z" },
    coverage: collected("2026-09-13T15:00:00.000Z", "2026-09-20T15:00:00.000Z"),
    deployments: [deployment("deploy-direct-push", "2026-09-15T05:00:00.000Z")],
    commits: [
      { sha: "commit-direct-push", committedAt: "2026-09-15T03:00:00.000Z" },
      { sha: "deploy-direct-push", committedAt: "2026-09-15T05:00:00.000Z" },
    ],
    pullRequests: [],
    deployCommits: [
      {
        deploymentCommitSha: "deploy-direct-push",
        baseSha: "deploy-base",
        commitShas: ["commit-direct-push", "deploy-direct-push"],
        truncated: false,
      },
    ],
  },
);

/** 全シナリオ。テストから一括で回すために並べておく。 */
export const allScenarios: readonly MetricsScenario[] = [
  weekBoundary,
  utcSundayIsJstMonday,
  zeroDeploymentWeek,
  uncoveredWeek,
  simultaneousDeployments,
  singleDataPointWeek,
  longLeadTimeCommit,
  directPushCommit,
];
