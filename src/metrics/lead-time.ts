/**
 * 変更のリードタイム（#18 / ADR-0004）。
 *
 * `MetricsInput` を受け取り、週次の代表値（中央値・p75・p90）と 3 区間内訳を返す**純粋関数**。
 * DB も GitHub も触らない（`better-sqlite3` も `fetch` も import しない）。
 * ADR-0004 が「指標計算を純粋関数に切り出し、記録した GitHub API レスポンス（fixture）で
 * ユニットテストする」と決めた切り出し線がここ。
 *
 * ## 定義（CONTEXT.md / ADR-0004）
 *
 * - **起点** = そのコミットの **committer date**。author date は rebase / cherry-pick で
 *   数ヶ月ずれ、リードタイムが実態の何倍にも跳ねるため使わない。
 * - **終点** = そのコミットが含まれた**デプロイ**の**デプロイ時刻**（ADR-0001）。
 * - **1 サンプル = 1 コミット**。PR 単位にはしない（PR を経由しない直接 push を取りこぼす。
 *   調査した実リポジトリでは直接 push の比率が高く、PR 単位だとデータの大半が消える）。
 *
 * ## 時刻順近似は実装しない（ADR-0004 が却下済み）
 *
 * 「コミットを committer date で『前回デプロイ時刻 〜 今回デプロイ時刻』の窓に割り当てる」
 * 方法は**ここに存在しない**。対象コミットは `MetricsInput.deployCommits`（#15 の compare
 * 結果）が与える SHA 集合だけから取り、コミットを時刻で絞る処理を一切通さない。
 * 近似を採ると、3 週間放置された branch のコミットは committer date が窓に入らず
 * 集計から丸ごと消える。つまり**リードタイムが最も長かった＝最も会話の価値があるデータ**を
 * システマティックに削り落とす。精度の問題ではなく、指標が逆向きに嘘をつく
 * （放置された PR ほど数値に現れない）問題である。
 *
 * ## 値の単位は「時間」
 *
 * 返す数値はすべて**時間（hours）** で、小数を持つ（`LEAD_TIME_UNIT` /
 * `LEAD_TIME_UNIT_LABEL`）。秒は「12 時間」を 43200 と表示することになり桁が読めない。
 * 日は「3 時間でデプロイした」が 0.125 に潰れ、速いチームほど改善が見えなくなる。
 * ADR-0004 が測りたい幅（数時間 〜 数週間）を 1 つの軸に載せて両端とも読めるのは時間だけ。
 * **丸めはここでしない。** 表示の桁は画面（#20 / #21）とグラフの目盛りが決める。
 */

import { classifyWeekCoverage, type WeekCoverage } from "./coverage.ts";
import { MIN_SAMPLES, type SampleSummary, summarizeSamples } from "./statistics.ts";
import type {
  CommitSample,
  DeployCommitAssignment,
  DeploymentSample,
  MetricsInput,
  PullRequestSample,
} from "./types.ts";
import { parseInstant, type Week, weekOf, weeksBetween } from "./week.ts";

const MS_PER_HOUR = 60 * 60 * 1000;

/** 返り値の数値の単位。**時間**（上のコメントの理由）。 */
export const LEAD_TIME_UNIT = "hours" as const;

/** 画面の軸ラベルにそのまま使える単位表記（#20 / #21）。 */
export const LEAD_TIME_UNIT_LABEL = "時間";

/**
 * 3 区間内訳（ADR-0004 / #18）。単位は時間。
 *
 * 「遅いのはコーディングか、レビュー待ちか、デプロイ待ちか」という改善の会話に直結する分解。
 * 合計値だけでは会話が生まれない、というのがこの分解を持つ理由（柱 4: 算出ロジックの開示）。
 */
export type LeadTimeBreakdown = {
  /** コミット → PR open。 */
  commitToPrOpen: number;
  /** PR open → merge（レビュー待ち）。 */
  prOpenToMerge: number;
  /** merge → デプロイ（デプロイ待ち）。 */
  mergeToDeploy: number;
  /** どの PR から区切り時刻を取ったか。ドリルダウン（柱 4）で辿れるようにする。 */
  pullRequestNumber: number;
};

/**
 * リードタイムの標本 1 件 = **コミット 1 件**。
 *
 * 代表値だけでなく標本そのものを返すのは、#21 の指標詳細画面が
 * 「この週の値はどのコミットから出たか」を出せるようにするため（柱 4）。
 * あわせて、**標本数が `minSamples` 未満で代表値を出さない週**（ADR-0004）でも
 * 標本自体は消えていないことを、返り値の上で示せるようにする。
 */
export type LeadTimeSample = {
  commitSha: string;
  /** 起点。committer date（ADR-0004）。 */
  committedAt: string;
  /** 終点を与えたデプロイ。 */
  deploymentCommitSha: string;
  /** 終点。デプロイ時刻（ADR-0001）。 */
  deployedAt: string;
  /** 合計リードタイム（時間）。 */
  leadTimeHours: number;
  /**
   * 3 区間内訳。**PR を経由しないコミットでは `null`**（#18）。
   *
   * **0 で埋めない。** 0 で埋めると「0 秒でレビューされた PR」が実在したように見え、
   * レビュー待ちの代表値を下へ引っ張る。存在しない区間は「無い」として返す。
   */
  breakdown: LeadTimeBreakdown | null;
};

/**
 * 3 区間内訳の週次代表値。
 *
 * 合計リードタイムとは**別に標本数ゲートを通す**。内訳を持つ標本（= PR に結び付いたコミット）は
 * 合計の標本より少ないので、合計が出る週でも内訳は出ないことがある。
 * 合計側の標本数で内訳のゲートを判定すると、直接 push だらけの週で内訳が
 * 1〜2 件の PR から作られてしまう。
 */
export type LeadTimeBreakdownSummary = {
  /** 内訳を持つ標本の数。合計側の `summary.count` とは一致しない。 */
  count: number;
  commitToPrOpen: SampleSummary;
  prOpenToMerge: SampleSummary;
  mergeToDeploy: SampleSummary;
};

/**
 * 標本にしなかったものの内訳。**黙って減らさないために返す**（#18 / `docs/raw-columns.md`）。
 *
 * ここが空でない週は「標本が欠けたまま出した値」なので、画面はその旨を添えられる必要がある。
 */
export type LeadTimeExclusions = {
  /**
   * compare API が打ち切られた割り当て（`truncated`）のデプロイ commit SHA。
   *
   * `truncated` が `true` の行は**その差分が欠けている**印で、集計はその行を標本にしては
   * ならない（`docs/raw-columns.md`）。取りこぼしを含んだまま数えると標本が黙って欠け、
   * ADR-0004 が退けた時刻順近似と同じ壊れ方をする。**そのデプロイのコミットは 1 件も採らない。**
   */
  truncatedDeployments: readonly string[];
  /**
   * 割り当てには現れたが `commits` に無い SHA。起点（committer date）が取れないので採れない。
   * バックフィルが届いていない範囲や、収集の取りこぼしがここに出る。
   */
  unknownCommitShas: readonly string[];
};

/** 週 1 つ分の結果。 */
export type LeadTimeWeek = {
  /** `Week.key`（JST 月曜始まりの `YYYY-MM-DD`）。 */
  week: string;
  /** 週の開始・終了（UTC の ISO8601）。半開区間 `[startedAt, endedAt)`。 */
  startedAt: string;
  endedAt: string;
  /**
   * 収集カバレッジ。**「標本 0 件」と「収集がまだ届いていない」は別物**（#17 と同じ区別）。
   * リードタイムは標本 0 件でも値なしになるため、画面はこれを見ないと
   * 「デプロイに変更が入らなかった週」と「まだ集めていない週」を言い分けられない。
   */
  coverage: WeekCoverage;
  /** この週の標本（＝コミット）。 */
  samples: readonly LeadTimeSample[];
  /**
   * 合計リードタイムの代表値。**標本が `minSamples` 未満なら `null`**
   * （ADR-0004「データ点が少ない週は値を出さず、線も繋がない」）。
   * `null` は 0 ではない。折れ線は繋がず欠損として描く。
   */
  summary: SampleSummary | null;
  /** 3 区間内訳の代表値。内訳を持つ標本が `minSamples` 未満なら `null`。 */
  breakdown: LeadTimeBreakdownSummary | null;
  /** 標本にしなかったもの。 */
  excluded: LeadTimeExclusions;
};

/** 変更のリードタイムの計算結果。 */
export type LeadTimeMetrics = {
  /** どのスコープの数値か。**複数スコープを合算しない**（CONTEXT.md）ための印。 */
  scopeId: string;
  /** どのデプロイ検出ルールで検出したデプロイを見たか（柱 4 の表示に使う）。 */
  detectionRule: string;
  /** 値の単位。 */
  unit: typeof LEAD_TIME_UNIT;
  /** 代表値を出すのに使った最小標本数。画面が「なぜ空白か」を説明できるように返す。 */
  minSamples: number;
  /** 期間に重なる週、古い順。**標本が 0 件の週もここには必ず現れる。** */
  weeks: readonly LeadTimeWeek[];
  /**
   * `deployCommits` にあるのに、対応するデプロイが `deployments` に無かった割り当て。
   *
   * デプロイ時刻が無いのでどの週にも載せようがなく、週ごとの `excluded` には入れられない。
   * 黙って捨てないためにここへ集める。通常は空で、空でなければ収集側の取りこぼしの印。
   */
  orphanAssignments: readonly string[];
};

export type LeadTimeOptions = {
  /** 代表値を出すのに必要な最小標本数。既定は `MIN_SAMPLES`（= 3）。 */
  minSamples?: number;
};

/**
 * 変更のリードタイムを週次で計算する。
 *
 * ## 週バケットは**終点（デプロイ時刻）**で決める
 *
 * 起点（committer date）で割る案もあり得るが、終点を採った。理由は 2 つ。
 *
 * 1. **その週の値が後から変わらない。** 起点で割ると、未デプロイのコミットが後でデプロイされた
 *    瞬間に過去の週の中央値が書き換わる。先週見た数字と今日見た数字が違うグラフでは、
 *    「比較の軸を過去の自分たちに置く」（`README.md`）という使い方が成立しない。
 * 2. **「その週にデプロイされた変更のリードタイム」という読み方が素直。**
 *    デプロイ頻度（#17）も終点で割るので、2 つの指標が同じ週境界の上に乗る。
 *
 * さらに、起点で割ると**未デプロイのコミットを持つ週だけ標本が欠ける**という歪みが入る
 * （リードタイムが長いコミットほど「まだデプロイされていない」側に居るので、
 * 直近の週ほど短いリードタイムばかりが残る）。これは ADR-0004 が時刻順近似を却下した理由と
 * 同じ形の嘘なので、その意味でも終点を採る。
 */
export function calculateLeadTime(
  input: MetricsInput,
  options: LeadTimeOptions = {},
): LeadTimeMetrics {
  const minSamples = options.minSamples ?? MIN_SAMPLES;
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    throw new Error(`最小標本数は 1 以上の整数である必要があります: ${minSamples}`);
  }

  const weeks = weeksBetween(input.period);
  const commitsBySha = new Map(input.commits.map((commit) => [commit.sha, commit]));
  const deploymentsBySha = indexDeployments(input.deployments);
  const findPullRequest = indexPullRequests(input.pullRequests);

  const accumulators = new Map<string, WeekAccumulator>();
  for (const week of weeks) {
    accumulators.set(week.key, newAccumulator());
  }

  const orphanAssignments: string[] = [];
  /**
   * 既に標本にしたコミット。同じコミットが複数の割り当てに現れることがある
   * （base の取り方、revert / re-merge で差分範囲が重なる）。**最初にそれを運んだデプロイ**に
   * 寄せるため、割り当てはデプロイ時刻の昇順で処理し、以降の出現は捨てる。
   * 重複を許すと同じコミットが複数の週の中央値に効き、標本数も水増しされる。
   */
  const claimedCommits = new Set<string>();

  for (const assignment of sortAssignmentsByDeployedAt(input.deployCommits, deploymentsBySha)) {
    const deployment = deploymentsBySha.get(assignment.deploymentCommitSha);
    if (deployment === undefined) {
      orphanAssignments.push(assignment.deploymentCommitSha);
      continue;
    }

    // 週は終点（デプロイ時刻）で決める。理由はこの関数の doc コメント。
    const accumulator = accumulators.get(weekOf(deployment.deployedAt).key);
    if (accumulator === undefined) {
      // 集計期間の外のデプロイ。期間は呼び出し側が選ぶものなので、除外としては数えない。
      continue;
    }

    if (assignment.truncated) {
      // compare が打ち切られている＝差分が欠けている。標本にせず、欠けたことを返り値に残す。
      accumulator.truncatedDeployments.push(assignment.deploymentCommitSha);
      continue;
    }

    for (const sha of assignment.commitShas) {
      if (claimedCommits.has(sha)) {
        continue;
      }
      const commit = commitsBySha.get(sha);
      if (commit === undefined) {
        accumulator.unknownCommitShas.push(sha);
        continue;
      }
      claimedCommits.add(sha);
      accumulator.samples.push(buildSample(commit, deployment, findPullRequest(sha)));
    }
  }

  return {
    scopeId: input.scopeId,
    detectionRule: input.detectionRule,
    unit: LEAD_TIME_UNIT,
    minSamples,
    weeks: weeks.map((week) =>
      finishWeek(week, accumulators.get(week.key) ?? newAccumulator(), input, minSamples),
    ),
    orphanAssignments,
  };
}

/* --- 画面（#20 / #21）へ渡す形 -------------------------------------------- */

/**
 * 週次の 1 点。`value` が `null` の週は**値なし**（欠損）であって 0 ではない。
 *
 * `server/views/chart.tsx`（#19）の `WeeklyPoint` と構造的に同じ形にしてある。
 * **あちらを import はしない。** 指標計算はサーバ層に依存しない純粋関数に保つ（ADR-0004）。
 * 依存の向きを逆にすると、指標のテストが JSX のビルド設定に縛られる。
 */
export type WeeklyMetricPoint = {
  week: string;
  value: number | null;
};

/** 重ね描きする系列。`chart.tsx` の `WeeklySeries` と構造的に同じ形。 */
export type WeeklyMetricSeries = {
  name: string;
  points: WeeklyMetricPoint[];
  /** 中央値が主線、p75 / p90 が補助線（ADR-0004「p75 / p90 を薄く重ねる」）。 */
  role: "primary" | "secondary";
};

/** `WeeklyLineChart`（#19）へ `title` と一緒に渡せる形。 */
export type WeeklyMetricChart = {
  weeks: string[];
  series: WeeklyMetricSeries[];
  unitLabel: string;
};

/**
 * 合計リードタイムを折れ線 3 本（中央値・p75・p90）にする。
 *
 * **値なしの週は `null` のまま渡す。** ここで 0 や前週の値に置き換えると、
 * ADR-0004 が求めた「欠損週で線を繋がない」が成立しなくなる。
 */
export function toLeadTimeChart(metrics: LeadTimeMetrics): WeeklyMetricChart {
  return {
    weeks: metrics.weeks.map((week) => week.week),
    series: [
      { name: "中央値", role: "primary", points: pointsOf(metrics, (s) => s.median) },
      { name: "p75", role: "secondary", points: pointsOf(metrics, (s) => s.p75) },
      { name: "p90", role: "secondary", points: pointsOf(metrics, (s) => s.p90) },
    ],
    unitLabel: LEAD_TIME_UNIT_LABEL,
  };
}

/**
 * 3 区間内訳を折れ線 3 本（各区間の中央値）にする。
 *
 * 内訳は**合計の分解**なので、区間ごとに p75 / p90 まで重ねない（9 本になり
 * 「遅いのはどこか」という読み方ができなくなる）。裾を見たいときは合計側の
 * `toLeadTimeChart` を見る、という役割分担にしてある。
 */
export function toLeadTimeBreakdownChart(metrics: LeadTimeMetrics): WeeklyMetricChart {
  return {
    weeks: metrics.weeks.map((week) => week.week),
    series: [
      {
        name: "コミット → PR open",
        role: "primary",
        points: breakdownPointsOf(metrics, (b) => b.commitToPrOpen.median),
      },
      {
        name: "PR open → merge",
        role: "primary",
        points: breakdownPointsOf(metrics, (b) => b.prOpenToMerge.median),
      },
      {
        name: "merge → デプロイ",
        role: "primary",
        points: breakdownPointsOf(metrics, (b) => b.mergeToDeploy.median),
      },
    ],
    unitLabel: LEAD_TIME_UNIT_LABEL,
  };
}

/* --- 内部 ---------------------------------------------------------------- */

type WeekAccumulator = {
  samples: LeadTimeSample[];
  truncatedDeployments: string[];
  unknownCommitShas: string[];
};

function newAccumulator(): WeekAccumulator {
  return { samples: [], truncatedDeployments: [], unknownCommitShas: [] };
}

function finishWeek(
  week: Week,
  accumulator: WeekAccumulator,
  input: MetricsInput,
  minSamples: number,
): LeadTimeWeek {
  const breakdowns = accumulator.samples
    .map((sample) => sample.breakdown)
    .filter((breakdown): breakdown is LeadTimeBreakdown => breakdown !== null);

  return {
    week: week.key,
    startedAt: week.startedAt,
    endedAt: week.endedAt,
    coverage: classifyWeekCoverage(input.coverage, week),
    samples: accumulator.samples,
    summary:
      summarizeSamples(
        accumulator.samples.map((sample) => sample.leadTimeHours),
        { minSamples },
      ) ?? null,
    breakdown: summarizeBreakdown(breakdowns, minSamples),
    excluded: {
      truncatedDeployments: accumulator.truncatedDeployments,
      unknownCommitShas: accumulator.unknownCommitShas,
    },
  };
}

function summarizeBreakdown(
  breakdowns: readonly LeadTimeBreakdown[],
  minSamples: number,
): LeadTimeBreakdownSummary | null {
  const commitToPrOpen = summarizeSamples(
    breakdowns.map((b) => b.commitToPrOpen),
    { minSamples },
  );
  const prOpenToMerge = summarizeSamples(
    breakdowns.map((b) => b.prOpenToMerge),
    { minSamples },
  );
  const mergeToDeploy = summarizeSamples(
    breakdowns.map((b) => b.mergeToDeploy),
    { minSamples },
  );
  // 3 区間は同じ標本集合から出るので、1 つでも出ないならゲートに掛かっている。
  // 一部だけ返すと「内訳の合計が合計リードタイムと噛み合わない」表示になる。
  if (commitToPrOpen === undefined || prOpenToMerge === undefined || mergeToDeploy === undefined) {
    return null;
  }
  return { count: breakdowns.length, commitToPrOpen, prOpenToMerge, mergeToDeploy };
}

function buildSample(
  commit: CommitSample,
  deployment: DeploymentSample,
  pullRequest: PullRequestSample | undefined,
): LeadTimeSample {
  const committedMs = parseInstant(commit.committedAt, "committer date");
  const deployedMs = parseInstant(deployment.deployedAt, "デプロイ時刻");
  return {
    commitSha: commit.sha,
    committedAt: commit.committedAt,
    deploymentCommitSha: deployment.commitSha,
    deployedAt: deployment.deployedAt,
    // 負になりうる（committer date は別の端末の時計なので、デプロイ時刻より後になりうる）。
    // 捨てない: 捨てると標本が黙って欠け、しかも原因が返り値から見えなくなる。
    leadTimeHours: (deployedMs - committedMs) / MS_PER_HOUR,
    breakdown: buildBreakdown(committedMs, deployedMs, pullRequest),
  };
}

/**
 * 3 区間内訳を作る。作れなければ `null`（**0 で埋めない**）。
 *
 * 作らない条件は 2 つ。
 *
 * 1. **対応する PR が無い / 未マージ。** PR を経由しない直接 push がここに来る（#18）。
 *    「PR open」「merge」という時刻がそもそも存在しないので、内訳なしとして返す。
 *    issue #18 が「内訳なし、として返すのが素直」と示したとおり。
 * 2. **区切り時刻が順番どおりに並んでいない。** マージコミット自身がこれに当たる:
 *    マージコミットの committer date は PR の作成時刻より後なので「コミット → PR open」が
 *    負になる。負の区間を返すと「レビューが始まる前に書かれた」という意味不明な内訳が
 *    代表値に混ざる。合計リードタイム（マージコミットでは 0 時間）は残したまま、
 *    内訳だけ無しに倒す。
 */
function buildBreakdown(
  committedMs: number,
  deployedMs: number,
  pullRequest: PullRequestSample | undefined,
): LeadTimeBreakdown | null {
  if (pullRequest === undefined || pullRequest.mergedAt === null) {
    return null;
  }
  const openedMs = parseInstant(pullRequest.createdAt, "PR の作成時刻");
  const mergedMs = parseInstant(pullRequest.mergedAt, "PR のマージ時刻");
  if (!(committedMs <= openedMs && openedMs <= mergedMs && mergedMs <= deployedMs)) {
    return null;
  }
  return {
    commitToPrOpen: (openedMs - committedMs) / MS_PER_HOUR,
    prOpenToMerge: (mergedMs - openedMs) / MS_PER_HOUR,
    mergeToDeploy: (deployedMs - mergedMs) / MS_PER_HOUR,
    pullRequestNumber: pullRequest.number,
  };
}

function indexDeployments(deployments: readonly DeploymentSample[]): Map<string, DeploymentSample> {
  const byCommitSha = new Map<string, DeploymentSample>();
  for (const deployment of deployments) {
    // 同じ commit が 2 度デプロイとして現れることは無い想定。先勝ちにして入力順を尊重する。
    if (!byCommitSha.has(deployment.commitSha)) {
      byCommitSha.set(deployment.commitSha, deployment);
    }
  }
  return byCommitSha;
}

/**
 * コミット SHA → PR を引く関数を作る。
 *
 * 使える手掛かりは `headSha`（PR の先頭コミット）と `mergeCommitSha`（マージコミット）だけ
 * （`PullRequestSample` は PR に含まれるコミット一覧を持たない。リードタイムの標本単位は
 * PR ではないので、対応表は内訳の区切り時刻を引くためだけに要る）。
 * したがって**枝の途中のコミットは PR に当たらず、内訳なしになる**。取りこぼしではあるが、
 * 当て推量で PR を結び付けて誤った内訳を出すよりよい（合計リードタイムは影響を受けない）。
 */
function indexPullRequests(
  pullRequests: readonly PullRequestSample[],
): (sha: string) => PullRequestSample | undefined {
  const byHeadSha = new Map<string, PullRequestSample>();
  const byMergeCommitSha = new Map<string, PullRequestSample>();
  for (const pullRequest of pullRequests) {
    if (!byHeadSha.has(pullRequest.headSha)) {
      byHeadSha.set(pullRequest.headSha, pullRequest);
    }
    if (pullRequest.mergeCommitSha !== null && !byMergeCommitSha.has(pullRequest.mergeCommitSha)) {
      byMergeCommitSha.set(pullRequest.mergeCommitSha, pullRequest);
    }
  }
  // headSha を先に見る: そちらは「変更そのものの先頭」で、マージコミットは merge の産物。
  // squash merge のように同じ SHA が両方に当たる場合は、変更側の解釈を優先する。
  return (sha) => byHeadSha.get(sha) ?? byMergeCommitSha.get(sha);
}

/**
 * 割り当てをデプロイ時刻の昇順に並べる。**コミットの重複を「最初に運んだデプロイ」に
 * 寄せるため**に要る（入力の並び順は保証されていない）。
 * デプロイが見つからない割り当ては末尾へ回す（どのみち orphan として弾かれる）。
 */
function sortAssignmentsByDeployedAt(
  assignments: readonly DeployCommitAssignment[],
  deploymentsBySha: ReadonlyMap<string, DeploymentSample>,
): DeployCommitAssignment[] {
  const deployedMsOf = (assignment: DeployCommitAssignment): number => {
    const deployment = deploymentsBySha.get(assignment.deploymentCommitSha);
    return deployment === undefined
      ? Number.POSITIVE_INFINITY
      : parseInstant(deployment.deployedAt, "デプロイ時刻");
  };
  return [...assignments].sort((left, right) => deployedMsOf(left) - deployedMsOf(right));
}

function pointsOf(
  metrics: LeadTimeMetrics,
  pick: (summary: SampleSummary) => number,
): WeeklyMetricPoint[] {
  return metrics.weeks.map((week) => ({
    week: week.week,
    value: week.summary === null ? null : pick(week.summary),
  }));
}

function breakdownPointsOf(
  metrics: LeadTimeMetrics,
  pick: (breakdown: LeadTimeBreakdownSummary) => number,
): WeeklyMetricPoint[] {
  return metrics.weeks.map((week) => ({
    week: week.week,
    value: week.breakdown === null ? null : pick(week.breakdown),
  }));
}
