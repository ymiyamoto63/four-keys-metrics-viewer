/**
 * 合成履歴の計画のテスト（#22）。
 *
 * ここで守りたいのは 1 点だけ: **意図した異常ケースが本当に履歴に入っていること。**
 * #22 が挙げた失敗（雑に作ると常に綺麗な線が出るテストデータになる）は、生成した後に
 * 画面を見て初めて気付くのでは遅い。計画の段階で落とす。
 *
 * 期待値は `metrics/` の関数で組み立てる。計画側で週やリードタイムを独自に数え直すと、
 * 「計画は正しいが画面には出ない」というズレを見逃す。
 */

import { describe, expect, it } from "vitest";
import { calculateLeadTime } from "../metrics/lead-time.ts";
import { MIN_SAMPLES } from "../metrics/statistics.ts";
import type { MetricsInput } from "../metrics/types.ts";
import { bucketByWeek, parseInstant, weekOf } from "../metrics/week.ts";
import {
  type AnomalyKind,
  DEFAULT_WEEKS,
  type PlannedMerge,
  planSampleHistory,
  type SampleHistoryPlan,
} from "./plan.ts";

/** 基準時刻を固定する。計画は決定的なので、同じ入力なら常に同じ計画になる。 */
const NOW = "2026-09-20T04:00:00.000Z";

function plan(overrides: { weeks?: number; seed?: number } = {}): SampleHistoryPlan {
  return planSampleHistory({ now: NOW, ...overrides });
}

/** `merge_only` ルールで数えたときのデプロイ時刻。merge commit の committer date（ADR-0001）。 */
function deployTimes(built: SampleHistoryPlan): string[] {
  return built.changes
    .filter((change): change is PlannedMerge => change.kind === "merge")
    .map((change) => change.merge.committedAt);
}

describe("planSampleHistory", () => {
  it("既定で 1 年分（53 週）を覆う", () => {
    const built = plan();
    expect(built.weeks).toHaveLength(DEFAULT_WEEKS);
    // バックフィル既定の 365 日を覆えること。覆えないと 1 年分の推移を検証できない。
    const spanDays =
      (parseInstant(built.period.to) - parseInstant(built.period.from)) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeGreaterThanOrEqual(365);
  });

  it("同じ now と seed なら同じ計画になる", () => {
    expect(plan()).toEqual(plan());
  });

  it("seed が違えば平常週の形が変わる", () => {
    expect(plan({ seed: 1 }).weeks.map((week) => week.mergeCount)).not.toEqual(
      plan({ seed: 2 }).weeks.map((week) => week.mergeCount),
    );
  });

  it("週が 4 未満なら落とす", () => {
    // 両端の partial を除いた検証可能な週が残らない。黙って作らせない。
    expect(() => plan({ weeks: 3 })).toThrow(/週数は 4 以上/);
  });

  it("変更はデフォルトブランチへ載る順に並んでいる", () => {
    const built = plan();
    const landedAt = built.changes.map((change) =>
      parseInstant(change.kind === "merge" ? change.merge.committedAt : change.commit.committedAt),
    );
    expect(landedAt).toEqual([...landedAt].sort((a, b) => a - b));
  });

  /**
   * `now` を週内のいろいろな位置に置いて試す。**曜日を変えないと再現しない。**
   *
   * 週内スロットは JST 月曜〜金曜に散らすので、`now` が週の後半（例: 日曜）なら
   * 素直に作っても偶然すべて過去に収まる。`now` が週初（月曜の朝）のときだけ
   * スロットが `now` を追い越す。#22 のサンプルリポジトリはまさに月曜に生成され、
   * 4 日先のコミットが 13 件積まれた。単一の `now` で書いたテストはこれを見逃す。
   *
   * JST 月曜 00:00 = UTC 日曜 15:00。以下はその前後を意図的にまたいでいる。
   */
  it.each([
    ["JST 月曜の朝（週の頭）", "2026-09-21T01:00:00.000Z"],
    ["JST 月曜 00:30（週境界の直後）", "2026-09-20T15:30:00.000Z"],
    ["JST 水曜の昼（週の半ば）", "2026-09-23T03:00:00.000Z"],
    ["JST 日曜の夜（週の終わり）", "2026-09-27T10:00:00.000Z"],
    ["既定のテスト基準時刻", NOW],
  ])("未来日付のコミットを作らない: %s", (_label, now) => {
    // 進行中の週は partial 扱いで指標値に出ないため、**画面を見ても気付けない。**
    const built = planSampleHistory({ now });
    const nowMs = parseInstant(now);
    for (const change of built.changes) {
      const commits = change.kind === "merge" ? [...change.commits, change.merge] : [change.commit];
      for (const commit of commits) {
        expect(parseInstant(commit.committedAt)).toBeLessThanOrEqual(nowMs);
      }
    }
  });

  it("now による切り落としは進行中の週だけに効く", () => {
    // 切り落としが過去週まで削ると、意図して置いた異常ケースが「生成した時刻」次第で
    // 消えることになる。同じ週の中で `now` を動かしても、最後の週以外は一致すること。
    //
    // 最後の週が空になること自体は正しい。JST 月曜の朝 10 時に生成すれば、
    // その週にはまだ何も起きていないのが実際の履歴である。
    const early = planSampleHistory({ now: "2026-09-21T01:00:00.000Z" });
    const late = planSampleHistory({ now: "2026-09-25T10:00:00.000Z" });

    expect(early.weeks).toHaveLength(late.weeks.length);
    const shapeOfWeeks = (built: SampleHistoryPlan) =>
      built.weeks
        .slice(0, -1)
        .map((week) => [week.week.key, week.mergeCount, week.directPushCount]);
    expect(shapeOfWeeks(early)).toEqual(shapeOfWeeks(late));
  });

  it("最新のコミットが now から遠く離れない", () => {
    // 切り落としが効きすぎて直近が丸ごと消えると、画面の右端が不自然に古くなる。
    // 進行中の週が空になることはあるので、許容は 1 週間強に取る。
    for (const now of [NOW, "2026-09-21T01:00:00.000Z", "2026-09-23T03:00:00.000Z"]) {
      const built = planSampleHistory({ now });
      const newest = Math.max(
        ...built.changes.map((change) =>
          parseInstant(
            change.kind === "merge" ? change.merge.committedAt : change.commit.committedAt,
          ),
        ),
      );
      const daysBehind = (parseInstant(now) - newest) / (24 * 60 * 60 * 1000);
      expect(daysBehind).toBeGreaterThanOrEqual(0);
      expect(daysBehind).toBeLessThan(8);
    }
  });

  it("週ごとの mergeCount が実際に置いた merge の件数と一致する", () => {
    // 最新週は now で切られるので、計画値ではなく実数を返さないと
    // 生成ログとテストが履歴と食い違う。
    const built = plan();
    const merges = new Map<string, number>();
    const pushes = new Map<string, number>();
    for (const change of built.changes) {
      const target = change.kind === "merge" ? merges : pushes;
      target.set(change.weekKey, (target.get(change.weekKey) ?? 0) + 1);
    }
    for (const week of built.weeks) {
      expect(week.mergeCount).toBe(merges.get(week.week.key) ?? 0);
      expect(week.directPushCount).toBe(pushes.get(week.week.key) ?? 0);
    }
  });

  it("各変更は自分の weekKey の週に載る", () => {
    // ここがずれると、意図して置いた欠損週が隣の週に落ちて検証にならない。
    for (const change of plan().changes) {
      const landedAt =
        change.kind === "merge" ? change.merge.committedAt : change.commit.committedAt;
      expect(weekOf(landedAt).key).toBe(change.weekKey);
    }
  });
});

describe("意図的な異常ケース（#22「合成履歴の設計で注意すること」）", () => {
  const ALL_KINDS: readonly AnomalyKind[] = [
    "no_deploy_week",
    "single_deploy_week",
    "stale_branch",
    "simultaneous_deploys",
    "direct_push",
  ];

  it.each(ALL_KINDS)("%s が計画に含まれている", (kind) => {
    const built = plan();
    expect(built.weeks.some((week) => week.anomalies.includes(kind))).toBe(true);
  });

  it("デプロイが 1 件も無い週が存在する", () => {
    const built = plan();
    const byWeek = bucketByWeek(deployTimes(built), (at) => at);
    const empty = built.weeks.filter((week) => (byWeek.get(week.week.key) ?? []).length === 0);
    expect(empty.length).toBeGreaterThanOrEqual(3);
  });

  it("デプロイが 1 件しか無い週が存在する（中央値を出さない条件）", () => {
    const built = plan();
    const byWeek = bucketByWeek(deployTimes(built), (at) => at);
    const single = built.weeks.filter((week) => (byWeek.get(week.week.key) ?? []).length === 1);
    expect(single.length).toBeGreaterThanOrEqual(1);
    // デプロイ 1 件の週は間隔の標本が MIN_SAMPLES に届かない。そこが確認したい状態。
    expect(1).toBeLessThan(MIN_SAMPLES);
  });

  it("同一時刻のデプロイが存在する", () => {
    const times = deployTimes(plan());
    const counts = new Map<string, number>();
    for (const at of times) {
      counts.set(at, (counts.get(at) ?? 0) + 1);
    }
    const duplicated = [...counts.values()].filter((count) => count >= 2);
    expect(duplicated.length).toBeGreaterThanOrEqual(2);
    // 3 件同着の週も置いてある（2 件より強い同着）。
    expect(Math.max(...counts.values())).toBeGreaterThanOrEqual(3);
  });

  it("極端に長いリードタイムのコミットが存在する", () => {
    const built = plan();
    const leadTimeDays = built.changes
      .filter((change): change is PlannedMerge => change.kind === "merge")
      .flatMap((change) =>
        change.commits.map(
          (commit) =>
            (parseInstant(change.merge.committedAt) - parseInstant(commit.committedAt)) /
            (24 * 60 * 60 * 1000),
        ),
      );

    // 平常の PR は数時間〜3 日。放置ブランチはそれを桁で超える。
    expect(Math.max(...leadTimeDays)).toBeGreaterThan(60);
    // 裾だけでなく本体もあること。全部が外れ値では分布として意味がない。
    expect(Math.min(...leadTimeDays)).toBeLessThan(3);
  });

  it("リードタイムは必ず正になる（コミットは merge より前）", () => {
    for (const change of plan().changes) {
      if (change.kind !== "merge") {
        continue;
      }
      for (const commit of change.commits) {
        expect(parseInstant(commit.committedAt)).toBeLessThan(
          parseInstant(change.merge.committedAt),
        );
      }
    }
  });

  it("PR を経由しない直接 push が存在する", () => {
    const built = plan();
    const pushes = built.changes.filter((change) => change.kind === "direct_push");
    expect(pushes.length).toBeGreaterThanOrEqual(2);
  });

  it("放置ブランチは実際に過去の地点から生える", () => {
    const stale = plan()
      .changes.filter((change): change is PlannedMerge => change.kind === "merge")
      .filter((change) => change.branchFromWeeksAgo > 0);
    expect(stale.length).toBeGreaterThanOrEqual(2);
    for (const change of stale) {
      expect(change.branchFromWeeksAgo).toBeGreaterThanOrEqual(1);
    }
  });

  it("異常ケースを最古と最新の週に置かない（どちらも収集カバレッジが partial になる）", () => {
    const built = plan();
    const first = built.weeks[0];
    const last = built.weeks[built.weeks.length - 1];
    expect(first?.anomalies).toEqual([]);
    expect(last?.anomalies).toEqual([]);
  });

  it("平常週は定数にならない（推移が見えること）", () => {
    const built = plan();
    const normal = built.weeks.filter((week) => week.anomalies.length === 0);
    expect(new Set(normal.map((week) => week.mergeCount)).size).toBeGreaterThanOrEqual(3);
  });
});

/**
 * 計画を**そのまま指標計算に流す**（`merge_only` 相当）。
 *
 * ここだけ `metrics/lead-time.ts` を呼んでいるのは、外れ値については
 * 「履歴に入っていること」と「画面に出ること」が別問題だからである。放置ブランチの
 * コミットが 1 件しかないと、その週の標本 20 件のうち外れ値が 1 件になり、
 * **p90（上位 10%）に届かず代表値には一切現れない。** 履歴としては正しいのに
 * 検証には使えない、という状態を計画のテストで捕まえる。
 *
 * SHA は計画の id をそのまま使う（`__fixtures__/scenarios.ts` と同じ割り切り）。
 * ここで見たいのは時刻の関係だけで、本物のレスポンス形は fixture 側の仕事である。
 */
function leadTimeOf(built: SampleHistoryPlan) {
  const merges = built.changes.filter((change): change is PlannedMerge => change.kind === "merge");
  const commits = built.changes.flatMap((change) =>
    change.kind === "merge"
      ? [...change.commits, change.merge].map((commit) => ({
          sha: commit.id,
          committedAt: commit.committedAt,
        }))
      : [{ sha: change.commit.id, committedAt: change.commit.committedAt }],
  );

  // デプロイ間の差分 = そのブランチのコミット + merge commit 自身
  // （直接 push は次のデプロイの差分に入る。ここでは外れ値だけを見たいので含めない）。
  const input: MetricsInput = {
    scopeId: "sample",
    detectionRule: "default_branch:merge_only",
    period: built.period,
    coverage: {
      backfilledUntil: built.period.from,
      backfillComplete: true,
      lastSuccessAt: built.period.to,
    },
    deployments: merges.map((merge) => ({
      commitSha: merge.merge.id,
      deployedAt: merge.merge.committedAt,
      detectionRule: "default_branch:merge_only",
    })),
    commits,
    pullRequests: [],
    deployCommits: merges.map((merge, index) => ({
      deploymentCommitSha: merge.merge.id,
      baseSha: merges[index - 1]?.merge.id ?? "root",
      commitShas: [...merge.commits.map((commit) => commit.id), merge.merge.id],
      truncated: false,
    })),
  };
  return calculateLeadTime(input);
}

describe("外れ値が代表値に現れること（ADR-0004 の p75 / p90 の目的）", () => {
  it("放置ブランチの週で p90 が平常週の何倍にも跳ねる", () => {
    const weeks = leadTimeOf(plan()).weeks.filter((week) => week.summary !== null);
    const p90Days = weeks.map((week) => (week.summary?.p90 ?? 0) / 24);
    const sorted = [...p90Days].sort((left, right) => left - right);
    const typical = sorted[Math.floor(sorted.length / 2)] ?? 0;

    // 平常週の p90 は数日。放置ブランチの週はその桁を超える。
    expect(typical).toBeLessThan(5);
    expect(Math.max(...p90Days)).toBeGreaterThan(typical * 5);
    expect(Math.max(...p90Days)).toBeGreaterThan(20);
  });

  it("外れ値の週でも中央値は平常の範囲に留まる（中央値に潰されていない）", () => {
    // 週の merge を全部放置ブランチにすると中央値ごと跳ね上がり、
    // 「中央値は平常、裾だけ長い」という一番見たい形が作れない。
    const weeks = leadTimeOf(plan()).weeks.filter((week) => week.summary !== null);
    const worst = weeks.reduce((left, right) =>
      (right.summary?.p90 ?? 0) > (left.summary?.p90 ?? 0) ? right : left,
    );
    expect((worst.summary?.p90 ?? 0) / 24).toBeGreaterThan(20);
    expect((worst.summary?.median ?? 0) / 24).toBeLessThan(10);
  });
});
