/**
 * 指標計算: デプロイ頻度（#17 / ADR-0004）。
 *
 * - **主指標 = 週あたりのデプロイ回数**
 * - **副指標 = デプロイ間隔の中央値**（DORA の定義「デプロイ回数、またはデプロイ間隔」に対応）
 *
 * 週次バケット・JST 月曜始まりの扱いは `week.ts` に閉じている。ここは純粋関数だけで、
 * DB も GitHub も触らない（受け取るのは `MetricsInput` 1 つだけ。`types.ts` の切り出し線）。
 * **集計値は保存しない**（ADR-0002。クエリのたびにここを通して計算し直す）。
 *
 * ## このファイルの核心: 「0 件」と「データなし」を潰さないこと
 *
 * デプロイ頻度において **0 件は欠損ではなく本物の値 0** である（その週はデプロイしなかった、
 * という実データ）。欠損になるのは**収集がその週をまだカバーしていない場合だけ**（#17）。
 * 生イベントだけを見ると両者はどちらも「行が無い」として現れるため、判定は必ず
 * 収集カバレッジ（`coverage.ts` の `classifyWeekCoverage`）と突き合わせて行う。
 *
 * 返り値は週ごとに `coverage`（`covered` / `partial` / `uncovered`）を持つ。
 * チャート用の `number | null` へ落とすのは最後（`toDeployCountPoints`）であり、
 * **そこまでは「収集済みで 0 件」と「データなし」を別の状態として持ち回る**。
 * これにより画面（#20 / #21）は「0 回」と「まだ収集していません」を書き分けられる。
 *
 * ## 少数サンプルのゲートを回数に適用しない理由
 *
 * ADR-0004 の「データ点が少ない週は値を出さず、線も繋がない」は、**少数サンプルの中央値が
 * 嘘をつく**ことへの対処である。週あたり回数は代表値ではなく数え上げなので、
 * 1 件の週の「1 回」は嘘ではない。ゲートを掛けるのは副指標のデプロイ間隔中央値だけ（#17）。
 */

import { classifyWeekCoverage, collectedRange, type WeekCoverage } from "./coverage.ts";
import { MIN_SAMPLES, type SampleSummary, summarizeSamples } from "./statistics.ts";
import type { DeploymentSample, MetricsInput } from "./types.ts";
import { bucketByWeek, parseInstant, type Week, weeksBetween } from "./week.ts";

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * 週 1 つ分のデプロイ頻度。
 *
 * `deployCount` が `null` の週と `0` の週は**意味が違う**。前者は「まだ数えていない」、
 * 後者は「数えた結果デプロイが無かった」。どちらなのかは `coverage` が語る。
 */
export type DeployFrequencyWeek = {
  /** 週バケット（JST 月曜始まりの半開区間）。`key` が画面のラベルになる。 */
  week: Week;
  /** この週を収集がどこまでカバーしているか。値を出した／出さない根拠（柱 4）。 */
  coverage: WeekCoverage;
  /**
   * **主指標。週あたりのデプロイ回数。**
   *
   * `covered` の週だけ数値（**0 を含む**）。`partial` / `uncovered` の週は `null` ＝ データなし。
   */
  deployCount: number | null;
  /**
   * 実際に数え上がったデプロイ件数。`partial` の週で「少なくともここまでは見えている」を
   * 示すために残す（`deployCount` が `null` でも画面は「収集中（現在 3 件）」と書ける）。
   * **主指標として読んではいけない。**
   */
  observedDeployCount: number;
  /**
   * **副指標。デプロイ間隔の代表値（単位: 時間）。**
   *
   * 標本が `MIN_SAMPLES` 未満の週は `undefined`（ADR-0004）。中央値のほかに p75 / p90 も
   * 入っているが、ADR-0004 の主線は中央値。
   */
  deployIntervalHours: SampleSummary | undefined;
  /**
   * 代表値の材料にした間隔の本数。ゲートで落ちた週でも本数は分かるようにしておく
   * （画面が「標本 2 件のため非表示」と言えるように。柱 4）。
   */
  deployIntervalSampleCount: number;
};

/** デプロイ頻度の計算結果。 */
export type DeployFrequencyResult = {
  /** どのスコープの数値か。**複数スコープを合算しない**ための印（CONTEXT.md）。 */
  scopeId: string;
  /** どの検出ルールで検出したデプロイを数えたか。数値と対で画面に出す（柱 4）。 */
  detectionRule: string;
  /** 期間に重なる週を古い順に。**デプロイ 0 件の週もここに必ず現れる**（#17）。 */
  weeks: readonly DeployFrequencyWeek[];
};

/**
 * `MetricsInput` から週次のデプロイ頻度を計算する。
 *
 * 週の並びは生イベントではなく `period` から作る（`weeksBetween`）。デプロイ 0 件の週は
 * 生イベント側に決して現れないため、期間から作らないと「本物の 0」を表現できない。
 */
export function calculateDeployFrequency(input: MetricsInput): DeployFrequencyResult {
  assertSameDetectionRule(input);

  const weeks = weeksBetween(input.period);
  const intervalsByWeek = bucketByWeek(deployIntervals(input), (interval) => interval.deployedAt);
  const deploysByWeek = bucketByWeek(input.deployments, (deployment) => deployment.deployedAt);

  const weekResults = weeks.map((week): DeployFrequencyWeek => {
    const coverage = classifyWeekCoverage(input.coverage, week);
    const observedDeployCount = deploysByWeek.get(week.key)?.length ?? 0;
    // 間隔は「数え終わった週」でしか信用できない。partial の週では観測できていない
    // デプロイが 2 件の間に挟まっている可能性があり、その間隔は収集の穴を測った値になる。
    const intervalHours =
      coverage === "covered"
        ? (intervalsByWeek.get(week.key)?.map((interval) => interval.hours) ?? [])
        : [];

    return {
      week,
      coverage,
      // **ここが #17 の核心。** covered の週だけ数値にする。
      //
      // partial をどちらへ倒すか: **データなし側へ倒す。** partial の週の回数は定義上
      // 必ず過少である（週の一部しか数えていない）。そして partial になるのは
      // 「進行中の今週」と「バックフィルの端の週」、つまり毎回必ず現れる週である。
      // ここを数値にすると、グラフの右端が毎回下がり「デプロイ頻度が落ちた」と読まれる。
      // 収集の穴を実データとして見せないという #17 の主題は、0 の捏造だけでなく
      // 過少な回数にもそのまま当てはまる。件数自体は `observedDeployCount` に残してあるので、
      // 「収集中（現在 n 件）」と書きたい画面は情報を失わない。
      deployCount: coverage === "covered" ? observedDeployCount : null,
      observedDeployCount,
      // **少数サンプルのゲートを掛けるのは副指標だけ**（#17）。回数には掛けない。
      deployIntervalHours: summarizeSamples(intervalHours, { minSamples: MIN_SAMPLES }),
      deployIntervalSampleCount: intervalHours.length,
    };
  });

  return {
    scopeId: input.scopeId,
    detectionRule: input.detectionRule,
    weeks: weekResults,
  };
}

/** 間隔 1 本。どの週に数えるかは「後ろ側のデプロイ」が属する週（下のコメント参照）。 */
type DeployInterval = {
  /** 後ろ側のデプロイの時刻。週バケットへの割り当てに使う。 */
  deployedAt: string;
  /** 直前のデプロイからの経過時間（時間）。同一時刻の 2 件なら 0。 */
  hours: number;
};

/**
 * デプロイ間隔の標本を作る。
 *
 * ## 間隔の定義: **週をまたいで、直前のデプロイとの差を取る**
 *
 * 1 本の間隔は「直前のデプロイ → このデプロイ」であり、**直前のデプロイが前の週にあっても
 * 打ち切らない**。間隔は後ろ側のデプロイが属する週に数える。
 *
 * 週内だけで間隔を取る（週の 1 本目のデプロイには間隔を与えない）方法を採らなかったのは、
 * **その方法が指標を一方向に嘘つきにする**ためである。週をまたぐ間隔はその週で最も長い
 * 間隔であることがほとんどで、それだけを捨てれば中央値は必ず実態より短く出る。
 * 「金曜に 1 回出して、次は翌週の木曜」という一番問題にしたい状態ほど数値から消える。
 * ADR-0004 が時刻順近似を却下したのと同じ理由（精度の問題ではなく**向きのある嘘**）。
 *
 * もう 1 つの理由は標本数。週内だけで取ると週 n 件のデプロイから n-1 本しか間隔が作れず、
 * `MIN_SAMPLES` = 3 を満たすのに週 4 件が要る。ADR-0001 が `merge_only` を既定にした
 * 前提（週あたりのデプロイは少数）では、副指標がほぼ全週で空白になる。
 *
 * ## 収集の穴をまたぐ間隔は捨てる
 *
 * 直前のデプロイが収集済み範囲より前にある場合、本当の直前のデプロイが収集できていない
 * 可能性がある。その間隔は「デプロイしなかった時間」ではなく「収集していない時間」を
 * 測ってしまうので標本にしない。#17 の主題どおり、収集の穴を実データとして見せない。
 */
function deployIntervals(input: MetricsInput): DeployInterval[] {
  // 期間外のデプロイも捨てずに並べる。期間の最初の週の 1 本目の間隔は、期間より前の
  // デプロイを相方に持つため（捨てると最初の週だけ理由なく標本が減る）。
  const sorted = [...input.deployments].sort((left, right) => instantOf(left) - instantOf(right));
  const range = collectedRange(input.coverage);
  const collectedFromMs = range === null ? null : parseInstant(range.from, "backfilled_until");

  const intervals: DeployInterval[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    // 配列の範囲内であることは index の条件から自明だが、noUncheckedIndexedAccess のため確かめる。
    if (previous === undefined || current === undefined) {
      continue;
    }
    const previousMs = instantOf(previous);
    if (collectedFromMs === null || previousMs < collectedFromMs) {
      continue;
    }
    intervals.push({
      deployedAt: current.deployedAt,
      // 同一時刻の 2 件は間隔 0。除外しない（別のコミットの別のデプロイであり、
      // 「続けて出した」という実データである）。
      hours: (instantOf(current) - previousMs) / MS_PER_HOUR,
    });
  }
  return intervals;
}

function instantOf(deployment: DeploymentSample): number {
  return parseInstant(deployment.deployedAt, "デプロイ時刻");
}

/**
 * 標本の検出ルールが集計対象のルールと揃っていることを確かめる。
 *
 * **デプロイは検出ルールに対して相対的**（CONTEXT.md）なので、ルール変更時に古いデプロイを
 * 破棄し損ねた（ADR-0002）状態で数えると、週あたり回数が黙って水増しされる。
 * 数え上げは「何件あったか」しか語らず、混入は画面からは決して見えない。黙って混ぜるより落とす。
 */
function assertSameDetectionRule(input: MetricsInput): void {
  for (const deployment of input.deployments) {
    if (deployment.detectionRule !== input.detectionRule) {
      throw new Error(
        `検出ルールの違うデプロイが混ざっています: ${deployment.commitSha} は ` +
          `${deployment.detectionRule}、集計対象は ${input.detectionRule}`,
      );
    }
  }
}

/* --- チャート（#20 / #21）への受け渡し ----------------------------------- */

/**
 * 週次チャートの 1 点。**`src/server/views/chart.tsx` の `WeeklyPoint`（#19）と
 * 構造的に一致させてある。** `null` は「値を出さない週」＝折れ線を繋がない週。
 *
 * 指標側から `chart.tsx` を import はしない。ここは JSX もサーバーも知らない純粋な層であり、
 * 表示都合の型に依存させると「DB も外部 API も触らない」という線が曖昧になる。
 */
export type WeeklyPoint = {
  /** 週の開始日（JST 月曜始まりの `YYYY-MM-DD`）。 */
  week: string;
  value: number | null;
};

/** チャートの x 軸に並べる週（`WeeklyLineChartProps.weeks`）。 */
export function toChartWeeks(result: DeployFrequencyResult): string[] {
  return result.weeks.map((weekResult) => weekResult.week.key);
}

/**
 * 主指標（週あたり回数）の系列。
 *
 * **ここで初めて「データなし」が `null` に潰れる。** 収集済みで 0 件の週は `0` として
 * 点が打たれ、収集が届いていない週は `null` になって線が途切れる。
 * 「なぜ `null` なのか」（未到達か、収集中か）を出したい画面は、潰す前の
 * `DeployFrequencyWeek.coverage` を読むこと。
 */
export function toDeployCountPoints(result: DeployFrequencyResult): WeeklyPoint[] {
  return result.weeks.map((weekResult) => ({
    week: weekResult.week.key,
    value: weekResult.deployCount,
  }));
}

/** 副指標（デプロイ間隔の中央値、単位: 時間）の系列。標本が少ない週は `null`。 */
export function toDeployIntervalMedianPoints(result: DeployFrequencyResult): WeeklyPoint[] {
  return result.weeks.map((weekResult) => ({
    week: weekResult.week.key,
    value: weekResult.deployIntervalHours?.median ?? null,
  }));
}
