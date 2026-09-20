/**
 * デプロイ頻度（#17）のテスト。
 *
 * 境界条件は自分で入力を書かず、**名前付きシナリオ（`__fixtures__/scenarios.ts`）を使う**。
 * 変更のリードタイム（#18）が同じ入力を見るので、片方だけが週境界の扱いを変えたときに気付ける。
 *
 * 副指標（デプロイ間隔）のように、シナリオが意図していない性質を確かめたいときだけ
 * この場で入力を組み立てる。DB も GitHub も触らない（#17 の完了条件）。
 */

import { describe, expect, it } from "vitest";
import {
  allScenarios,
  simultaneousDeployments,
  singleDataPointWeek,
  uncoveredWeek,
  utcSundayIsJstMonday,
  weekBoundary,
  zeroDeploymentWeek,
} from "./__fixtures__/scenarios.ts";
import {
  calculateDeployFrequency,
  type DeployFrequencyResult,
  type DeployFrequencyWeek,
  toChartWeeks,
  toDeployCountPoints,
  toDeployIntervalMedianPoints,
} from "./deploy-frequency.ts";
import type { CollectionCoverage, DeploymentSample, MetricsInput } from "./types.ts";

const DETECTION_RULE = "default_branch:merge_only";

/** 週キー → 週あたり回数。`null` はデータなし。 */
function countsByWeek(result: DeployFrequencyResult): Record<string, number | null> {
  return Object.fromEntries(result.weeks.map((week) => [week.week.key, week.deployCount]));
}

function weekAt(result: DeployFrequencyResult, key: string): DeployFrequencyWeek {
  const found = result.weeks.find((week) => week.week.key === key);
  if (found === undefined) {
    throw new Error(`週が結果に含まれていません: ${key}`);
  }
  return found;
}

/**
 * 副指標を確かめるための入力。シナリオ側はデプロイ間隔の標本数を意図して作っていないため、
 * ここだけは自前で組み立てる（コミット / PR はデプロイ頻度が読まないので空でよい）。
 */
function intervalInput(parts: {
  deployedAt: readonly string[];
  coverage: CollectionCoverage;
  period?: { from: string; to: string };
}): MetricsInput {
  const deployments: DeploymentSample[] = parts.deployedAt.map((deployedAt, index) => ({
    deployedAt,
    commitSha: `deploy-${index}`,
    detectionRule: DETECTION_RULE,
  }));
  return {
    scopeId: "sample-app",
    detectionRule: DETECTION_RULE,
    period: parts.period ?? { from: "2026-09-07T00:00:00Z", to: "2026-09-20T00:00:00Z" },
    deployments,
    commits: [],
    pullRequests: [],
    deployCommits: [],
    coverage: parts.coverage,
  };
}

/** 2026-09-07 週と 2026-09-14 週の全体を収集済みにするカバレッジ。 */
const COLLECTED_TWO_WEEKS: CollectionCoverage = {
  backfilledUntil: "2026-09-06T15:00:00.000Z",
  backfillComplete: true,
  lastSuccessAt: "2026-09-20T15:00:00.000Z",
};

describe("週あたりのデプロイ回数（主指標）", () => {
  it("JST 月曜 00:00 ちょうどのデプロイは新しい週に数える（二重計上しない）", () => {
    // 半開区間 [startedAt, endedAt) なので 3 件が 1 + 2 に割れる。合計は必ず 3。
    expect(countsByWeek(calculateDeployFrequency(weekBoundary.input))).toEqual({
      "2026-09-07": 1,
      "2026-09-14": 2,
    });
  });

  it("UTC 日曜 15:00 は JST では翌週に落ちる", () => {
    // UTC のまま週に割ると 2 件とも同じ週になり、この差が消える。
    expect(countsByWeek(calculateDeployFrequency(utcSundayIsJstMonday.input))).toEqual({
      "2026-09-07": 1,
      "2026-09-14": 1,
    });
  });

  it("同一時刻の 2 件を 2 回として数える（時刻で重複排除しない）", () => {
    expect(countsByWeek(calculateDeployFrequency(simultaneousDeployments.input))).toEqual({
      "2026-09-14": 2,
    });
  });

  it("データ点が 1 件しかない週でも回数 1 を返す（少数サンプルのゲートを掛けない）", () => {
    // ADR-0004 のゲートは中央値が嘘をつくことへの対処であり、数え上げには当てはまらない（#17）。
    expect(countsByWeek(calculateDeployFrequency(singleDataPointWeek.input))).toEqual({
      "2026-09-14": 1,
    });
  });

  it("デプロイが 1 件も無い週も結果に現れる（週の並びは期間から作る）", () => {
    expect(countsByWeek(calculateDeployFrequency(zeroDeploymentWeek.input))).toEqual({
      "2026-08-31": 1,
      "2026-09-07": 0,
      "2026-09-14": 1,
    });
  });

  it("スコープと検出ルールを結果に添える（この数値がどう計算されたか）", () => {
    const result = calculateDeployFrequency(zeroDeploymentWeek.input);
    expect(result.scopeId).toBe("sample-app");
    expect(result.detectionRule).toBe(DETECTION_RULE);
  });

  it("検出ルールの違うデプロイが混ざっていたら落とす（破棄漏れの黙った水増しを防ぐ）", () => {
    const input: MetricsInput = {
      ...singleDataPointWeek.input,
      deployments: [
        {
          deployedAt: "2026-09-15T02:00:00.000Z",
          commitSha: "stale",
          detectionRule: "workflow_run",
        },
      ],
    };
    expect(() => calculateDeployFrequency(input)).toThrow(/検出ルールの違うデプロイ/);
  });
});

describe("「0 件」と「データなし」の区別（#17 の核心）", () => {
  it("デプロイ 0 件は、収集済みなら本物の 0、収集未到達ならデータなし", () => {
    // 入力のデプロイは 0 件で 3 週とも同じ。カバレッジだけが意味を分ける。
    const result = calculateDeployFrequency(uncoveredWeek.input);

    expect(weekAt(result, "2026-08-31")).toMatchObject({
      coverage: "uncovered",
      deployCount: null,
    });
    expect(weekAt(result, "2026-09-07")).toMatchObject({
      coverage: "covered",
      deployCount: 0,
    });
    expect(weekAt(result, "2026-09-14")).toMatchObject({
      coverage: "partial",
      deployCount: null,
    });
  });

  it("収集済みで 0 件の週は、0 が「値」であってデータなしではない", () => {
    const zero = weekAt(calculateDeployFrequency(zeroDeploymentWeek.input), "2026-09-07");
    expect(zero.deployCount).toBe(0);
    expect(zero.deployCount).not.toBeNull();
    expect(zero.coverage).toBe("covered");
  });

  it("収集が途中の週は、回数を出さないまま「ここまでは見えている」件数を残す", () => {
    // partial はデータなし側へ倒す（過少な回数を「デプロイが減った」と読ませないため）。
    // ただし件数を捨てると画面が「収集中（現在 2 件）」と言えなくなるので観測値は残す。
    const result = calculateDeployFrequency(
      intervalInput({
        deployedAt: ["2026-09-14T03:00:00.000Z", "2026-09-15T03:00:00.000Z"],
        coverage: {
          backfilledUntil: "2026-09-06T15:00:00.000Z",
          backfillComplete: true,
          lastSuccessAt: "2026-09-16T00:00:00.000Z",
        },
      }),
    );

    expect(weekAt(result, "2026-09-14")).toMatchObject({
      coverage: "partial",
      deployCount: null,
      observedDeployCount: 2,
    });
  });

  it("どのシナリオでも、値が出るのは covered の週だけ", () => {
    for (const { name, input } of allScenarios) {
      for (const week of calculateDeployFrequency(input).weeks) {
        const label = `${name}: ${week.week.key}`;
        if (week.coverage === "covered") {
          expect(week.deployCount, label).toBeGreaterThanOrEqual(0);
        } else {
          expect(week.deployCount, label).toBeNull();
        }
      }
    }
  });
});

describe("デプロイ間隔の中央値（副指標）", () => {
  it("直前のデプロイとの差を週をまたいで取る", () => {
    // 2026-09-14 週の 3 件のうち 1 本目の相方は前の週のデプロイ。週内だけで間隔を取ると
    // 標本が 2 本に減ってゲートで落ち、一番長い間隔（72 時間）が黙って消える。
    const result = calculateDeployFrequency(
      intervalInput({
        deployedAt: [
          "2026-09-11T03:00:00.000Z", // 2026-09-07 週
          "2026-09-14T03:00:00.000Z", // 72 時間
          "2026-09-15T03:00:00.000Z", // 24 時間
          "2026-09-16T09:00:00.000Z", // 30 時間
        ],
        coverage: COLLECTED_TWO_WEEKS,
      }),
    );

    const week = weekAt(result, "2026-09-14");
    expect(week.deployIntervalSampleCount).toBe(3);
    expect(week.deployIntervalHours?.median).toBe(30);
    expect(week.deployIntervalHours?.count).toBe(3);
    // 裾も返す（ADR-0004 の p75 / p90。線形補間なので実在の標本とは限らない）。
    expect(week.deployIntervalHours?.p75).toBe(51);
  });

  it("標本が少なすぎる週は値を返さない（回数は返す）", () => {
    const week = weekAt(calculateDeployFrequency(singleDataPointWeek.input), "2026-09-14");
    expect(week.deployCount).toBe(1);
    expect(week.deployIntervalSampleCount).toBe(0);
    expect(week.deployIntervalHours).toBeUndefined();
  });

  it("同一時刻のデプロイの間隔は 0（負にも NaN にもならない）", () => {
    const week = weekAt(calculateDeployFrequency(simultaneousDeployments.input), "2026-09-14");
    expect(week.deployIntervalSampleCount).toBe(1);
    // 標本 1 本ではゲートに掛かるので中央値は出ない。0 が混ざっても落ちないことが要点。
    expect(week.deployIntervalHours).toBeUndefined();
  });

  it("収集済み範囲より前のデプロイとの間隔は標本にしない", () => {
    // 2026-09-11 のデプロイは収集済み範囲の外。そこからの間隔は「デプロイしなかった時間」
    // ではなく「収集していない時間」を測ってしまう。
    const result = calculateDeployFrequency(
      intervalInput({
        deployedAt: [
          "2026-09-11T03:00:00.000Z",
          "2026-09-14T03:00:00.000Z",
          "2026-09-15T03:00:00.000Z",
          "2026-09-16T09:00:00.000Z",
        ],
        coverage: {
          backfilledUntil: "2026-09-13T15:00:00.000Z",
          backfillComplete: false,
          lastSuccessAt: "2026-09-20T15:00:00.000Z",
        },
      }),
    );

    const week = weekAt(result, "2026-09-14");
    expect(week.deployCount).toBe(3);
    // 72 時間の間隔が落ちて 2 本になり、ゲートで値なしになる。
    expect(week.deployIntervalSampleCount).toBe(2);
    expect(week.deployIntervalHours).toBeUndefined();
  });

  it("収集が途中の週では間隔を出さない（観測できていないデプロイが間に挟まりうる）", () => {
    const result = calculateDeployFrequency(
      intervalInput({
        deployedAt: [
          "2026-09-14T03:00:00.000Z",
          "2026-09-15T03:00:00.000Z",
          "2026-09-16T03:00:00.000Z",
          "2026-09-17T03:00:00.000Z",
        ],
        coverage: {
          backfilledUntil: "2026-09-06T15:00:00.000Z",
          backfillComplete: true,
          lastSuccessAt: "2026-09-18T00:00:00.000Z",
        },
      }),
    );

    expect(weekAt(result, "2026-09-14")).toMatchObject({
      coverage: "partial",
      deployIntervalSampleCount: 0,
      deployIntervalHours: undefined,
    });
  });
});

describe("チャート（#20 / #21）への受け渡し", () => {
  it("週の並びをそのまま x 軸に渡せる", () => {
    expect(toChartWeeks(calculateDeployFrequency(uncoveredWeek.input))).toEqual([
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
    ]);
  });

  it("収集済みで 0 件は点 0、データなしは null（線を繋がない）", () => {
    expect(toDeployCountPoints(calculateDeployFrequency(uncoveredWeek.input))).toEqual([
      { week: "2026-08-31", value: null },
      { week: "2026-09-07", value: 0 },
      { week: "2026-09-14", value: null },
    ]);
  });

  it("null に潰す前の返り値では、0 件とデータなしの理由が残っている", () => {
    // チャートは両方 null になるが、画面は coverage を見て書き分けられる（#17 の核心）。
    const result = calculateDeployFrequency(uncoveredWeek.input);
    const points = toDeployCountPoints(result);
    expect(points[0]?.value).toBeNull();
    expect(weekAt(result, "2026-08-31").coverage).toBe("uncovered");
    expect(weekAt(result, "2026-09-14").coverage).toBe("partial");
  });

  it("副指標も同じ形の系列にできる", () => {
    const result = calculateDeployFrequency(
      intervalInput({
        deployedAt: [
          "2026-09-11T03:00:00.000Z",
          "2026-09-14T03:00:00.000Z",
          "2026-09-15T03:00:00.000Z",
          "2026-09-16T09:00:00.000Z",
        ],
        coverage: COLLECTED_TWO_WEEKS,
      }),
    );

    expect(toDeployIntervalMedianPoints(result)).toEqual([
      // 前の週は間隔が 1 本も作れないので値なし。
      { week: "2026-09-07", value: null },
      { week: "2026-09-14", value: 30 },
    ]);
  });
});
