/**
 * サンプルリポジトリの**合成履歴の計画**（#22 / ADR-0004）。
 *
 * 「いつ・どんなコミットとマージコミットを積むか」を決めるだけの純粋関数。git も
 * ファイルシステムも触らない。実際に積むのは `generate.ts`。
 *
 * ## なぜ計画と実行を分けるか
 *
 * #22 が一番気にしているのは「雑に作ると常に綺麗な線が出るテストデータになり、
 * **欠損週や外れ値の表示を検証できない**」という失敗である。つまりこのファイルの出力が
 * サンプルリポジトリの価値そのものを決める。git を回さないと確かめられない形にすると、
 * 「意図した異常ケースが本当に入っているか」をテストできない。ここを純粋関数に切り出せば
 * `plan.test.ts` が週単位で検証でき、ADR-0004 の「判定ロジックは純粋関数でユニットテスト」
 * という方針とも揃う。
 *
 * ## 週の判定は `metrics/week.ts` を使う
 *
 * 「この変更はどの週に入るか」を独自計算しない。画面が集計に使うのと**同じ** JST 月曜始まりの
 * バケットを通す。ここで週をずらすと、意図して置いた欠損週が隣の週に落ち、
 * 計画上は欠損なのに画面では欠損に見えない、という一番たちの悪い食い違いが起きる。
 *
 * ## 決定的であること
 *
 * 同じ `now` と `seed` なら必ず同じ計画になる（乱数は `seed` から作る）。
 * 生成し直すたびに履歴の形が変わると、「先週は見えていた外れ値が消えた」が
 * アプリのバグなのかデータの揺れなのか切り分けられない。
 */

import { type Period, parseInstant, type Week, weekOf, weeksBetween } from "../metrics/week.ts";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/** 既定の週数。バックフィル既定（365 日 / ADR-0003）を覆える長さ。 */
export const DEFAULT_WEEKS = 53;

/**
 * 計画に載せる意図的な異常ケース。#22「合成履歴の設計で注意すること」の 5 項目に対応する。
 *
 * 種類を型で持つのは、テストが「この 5 つが揃っているか」を網羅的に確かめられるようにするため。
 * 項目を増やしたら `plan.test.ts` の網羅テストが漏れを指摘する。
 */
export type AnomalyKind =
  /** デプロイが 1 件も無い週。デプロイ頻度の「本物の 0」と線の途切れを見る。 */
  | "no_deploy_week"
  /** デプロイが 1 件しか無い週。デプロイ間隔の中央値を出さない条件（MIN_SAMPLES）を見る。 */
  | "single_deploy_week"
  /** 長期間放置された branch の merge。リードタイムの外れ値（p90 と裾）を見る。 */
  | "stale_branch"
  /** 同一時刻の複数デプロイ。週境界の二重計上とデプロイ間隔 0 時間を見る。 */
  | "simultaneous_deploys"
  /** PR を経由しない直接 push。コミット単位のリードタイムが取りこぼさないことを見る。 */
  | "direct_push";

/** 異常ケースを「最新の週から何週前に置くか」で指定する。 */
type AnomalyPlacement = {
  /** 最新の週を 0 とした、何週前か。 */
  weeksAgo: number;
  kind: AnomalyKind;
  /** `stale_branch` のとき、ブランチを何週前から生やすか。 */
  staleWeeks?: number;
  /**
   * この週の merge 件数（= `merge_only` でのデプロイ件数）。省略すると平常週の件数のまま。
   *
   * **`max` ではなく上書きにしてある。** 平常週の件数は乱数で 3〜5 に振れるので、
   * `max` にすると「同一時刻に 2 件」と書いた週に 4 件並ぶことが起き、注記が嘘になる。
   * 異常ケースの週は件数まで計画側が決め切る。
   */
  merges?: number;
  /** この週の直接 push 件数。省略すると平常週の件数のまま。 */
  directPushes?: number;
  /** なぜこの週をこの形にしたか。生成ログとテスト名に出す。 */
  note: string;
};

/**
 * 異常ケースの配置。**両端の週を避けている**のが重要な点。
 *
 * 最古の週と最新の週は収集カバレッジが必ず `partial` になる（バックフィルの端と進行中の今週。
 * `metrics/coverage.ts`）。`partial` の週はデプロイ回数が `null` になるので、そこに欠損週を
 * 置いても「意図した 0」なのか「まだ集めていない」なのか画面上で区別が付かず、
 * 検証にならない。したがって異常ケースは 2 週目以降・最新から 2 週前までに置く。
 */
const ANOMALIES: readonly AnomalyPlacement[] = [
  {
    weeksAgo: 2,
    kind: "simultaneous_deploys",
    merges: 2,
    note: "同一時刻に 2 件のデプロイ。その週のデプロイはこの 2 件だけで、間隔 0 時間が 1 本立つ",
  },
  {
    weeksAgo: 4,
    kind: "single_deploy_week",
    merges: 1,
    note: "デプロイ 1 件だけの週。間隔の標本が足りず中央値を出さない",
  },
  {
    weeksAgo: 6,
    kind: "no_deploy_week",
    merges: 0,
    directPushes: 0,
    note: "デプロイ 0 件・コミットも 0 件の週。線が途切れる",
  },
  {
    weeksAgo: 8,
    kind: "stale_branch",
    staleWeeks: 7,
    note: "7 週間放置された branch の merge。リードタイムの外れ値",
  },
  {
    weeksAgo: 11,
    kind: "direct_push",
    merges: 0,
    directPushes: 3,
    note:
      "直接 push だけの週。merge_only ではデプロイ 0 件だが、コミットは 3 件ある。" +
      "この 3 件は次のデプロイの差分に入り、そのデプロイのリードタイムを押し上げる",
  },
  {
    weeksAgo: 14,
    kind: "no_deploy_week",
    merges: 0,
    directPushes: 0,
    note: "デプロイ 0 件の週（2 回目）。次の週と合わせて欠損が 2 週続く",
  },
  {
    weeksAgo: 15,
    kind: "no_deploy_week",
    merges: 0,
    directPushes: 0,
    note: "デプロイ 0 件の週（3 回目）。2 週連続の欠損の片側",
  },
  {
    weeksAgo: 19,
    kind: "single_deploy_week",
    merges: 1,
    note: "デプロイ 1 件だけの週（2 回目）。欠損週に挟まれない位置",
  },
  {
    weeksAgo: 24,
    kind: "stale_branch",
    staleWeeks: 12,
    note: "12 週間放置された branch の merge。履歴中盤の外れ値",
  },
  {
    weeksAgo: 30,
    kind: "simultaneous_deploys",
    merges: 3,
    note: "同一時刻に 3 件のデプロイ。2 件より強い同着で、間隔 0 時間が 2 本立つ",
  },
  {
    weeksAgo: 36,
    kind: "no_deploy_week",
    merges: 0,
    directPushes: 0,
    note: "デプロイ 0 件の週（4 回目）。履歴の古い側",
  },
  {
    weeksAgo: 42,
    kind: "direct_push",
    directPushes: 2,
    note: "直接 push と merge が混ざる週。直接 push の分だけリードタイムの標本が増える",
  },
];

/** 合成履歴に積む 1 コミット。 */
export type PlannedCommit = {
  /** 一意な識別子。ファイル名・ブランチ名・コミットメッセージに使う。 */
  id: string;
  /** コミットメッセージの 1 行目。 */
  message: string;
  /**
   * author date / committer date に入れる時刻（UTC の ISO8601）。
   *
   * **両方に同じ値を入れる。** 起点は committer date（ADR-0004）だが、author date だけ
   * 現在時刻のまま残ると「author date は使わない」という決定を確かめられない履歴になる。
   */
  committedAt: string;
};

/** PR を経由せずデフォルトブランチへ直接 push するコミット。 */
export type PlannedDirectPush = {
  kind: "direct_push";
  /** この変更がデフォルトブランチへ載る週（`Week.key`）。 */
  weekKey: string;
  commit: PlannedCommit;
  note: string;
};

/** ブランチを作って `--no-ff` で merge する 1 単位。merge commit が 1 デプロイになる。 */
export type PlannedMerge = {
  kind: "merge";
  /** merge commit が属する週（`Week.key`）。 */
  weekKey: string;
  branch: string;
  /** ブランチ上のコミット。古い順。1 件以上。 */
  commits: readonly PlannedCommit[];
  /** merge commit 自身。この committer date が**デプロイ時刻**になる（ADR-0001）。 */
  merge: PlannedCommit;
  /**
   * ブランチを何週前のデフォルトブランチから生やすか。0 なら現在の先端。
   *
   * 放置ブランチ（`stale_branch`）を「古いコミット日時」だけで作ると、git の履歴としては
   * 先端から生えた枝に古い日付が付いているだけになる。実際に古い地点から生やすことで、
   * compare API が返す差分も本物の放置ブランチと同じ形になる。
   */
  branchFromWeeksAgo: number;
  note: string;
};

export type PlannedChange = PlannedDirectPush | PlannedMerge;

/** 週 1 つ分の計画。テストと生成ログが「この週に何を置いたか」を読むための単位。 */
export type PlannedWeek = {
  week: Week;
  /** この週に置いた異常ケース。無ければ空。 */
  anomalies: readonly AnomalyKind[];
  /** この週に merge commit を何件置くか（= `merge_only` でのデプロイ件数）。 */
  mergeCount: number;
  /** この週に直接 push を何件置くか。 */
  directPushCount: number;
  notes: readonly string[];
};

export type SampleHistoryPlan = {
  /** 履歴が覆う期間。最古の週の開始から最新の週の終わりまで。 */
  period: Period;
  weeks: readonly PlannedWeek[];
  /**
   * デフォルトブランチへ反映する順に並べた変更。
   *
   * 並び順は「デフォルトブランチに載った時刻」であって、コミットの committer date 順ではない
   * （放置ブランチのコミットは、載る時刻よりずっと古い committer date を持つ）。
   */
  changes: readonly PlannedChange[];
};

export type PlanOptions = {
  /** 生成の基準時刻。この時刻が属する週が最新の週になる。 */
  now: string | Date;
  /** 何週分作るか。既定 `DEFAULT_WEEKS`。 */
  weeks?: number;
  /** 乱数の種。同じ種なら同じ計画になる。 */
  seed?: number;
};

/**
 * 合成履歴の計画を作る。
 *
 * 平常週は「週 2〜4 回の merge」を種から決め、そこへ `ANOMALIES` の異常ケースを上書きする。
 * 平常週に幅を持たせているのは、全週が同じ回数だとデプロイ頻度のグラフが定数線になり、
 * 「推移が見える」ことを確認できないため。
 */
export function planSampleHistory(options: PlanOptions): SampleHistoryPlan {
  const weekCount = options.weeks ?? DEFAULT_WEEKS;
  if (!Number.isInteger(weekCount) || weekCount < 4) {
    // 3 週以下だと両端の partial を除いた検証可能な週が残らない。黙って作らない。
    throw new Error(`週数は 4 以上の整数である必要があります: ${weekCount}`);
  }

  const latestWeek = weekOf(options.now);
  const nowMs = parseInstant(options.now, "基準時刻");
  const latestStartMs = parseInstant(latestWeek.startedAt, "最新週の開始時刻");
  const oldestStartMs = latestStartMs - (weekCount - 1) * MS_PER_WEEK;

  const period: Period = {
    from: new Date(oldestStartMs).toISOString(),
    to: latestWeek.endedAt,
  };
  const weeks = weeksBetween({ from: period.from, to: new Date(latestStartMs).toISOString() });
  if (weeks.length !== weekCount) {
    throw new Error(`週の数が計画と合いません: ${weeks.length} !== ${weekCount}`);
  }

  const random = mulberry32(options.seed ?? 20260920);
  const anomaliesByWeeksAgo = groupAnomalies(weekCount);

  const plannedWeeks: PlannedWeek[] = [];
  const changes: PlannedChange[] = [];
  let sequence = 0;

  weeks.forEach((week, index) => {
    const weeksAgo = weekCount - 1 - index;
    const placements = anomaliesByWeeksAgo.get(weeksAgo) ?? [];
    const shape = shapeOf(placements, random);
    const notes = placements.map((placement) => placement.note);

    const weekStartMs = parseInstant(week.startedAt, "週の開始時刻");
    // **`now` より後のスロットは捨てる。**
    //
    // 最新週は進行中なので、週内のスロット（月〜金に散らす）は素直に作ると `now` を追い越す。
    // 追い越したまま積むと、リポジトリの履歴に**未来日付のコミット**が並ぶ。進行中の週は
    // 収集カバレッジが `partial` になるので指標値には現れないが、収集は `until = now` の窓で
    // 取るため、生成したコミットの一部が最初から収集対象外になる。検証用の履歴としては
    // 「画面に出ないデータが混ざっている」状態で、あとから原因を切り分けられなくなる。
    //
    // スロットは全数ぶん作ってから捨てる。件数で分岐して作ると乱数を引く回数が変わり、
    // 過去週の形まで `now` に依存して動いてしまう（`shapeOf` と同じ理由）。
    const slots = timeSlots(shape.mergeCount + shape.directPushCount, weekStartMs, random).filter(
      (at) => at <= nowMs,
    );
    // 落とす順は merge より直接 push を優先して残す（直接 push は 1 コミットで完結し、
    // merge はブランチのコミットを伴うので、半端に切れると差分の形が崩れる）。
    const directPushCount = Math.min(shape.directPushCount, slots.length);
    const mergeCount = Math.min(shape.mergeCount, slots.length - directPushCount);
    let slot = 0;

    for (let n = 0; n < directPushCount; n += 1) {
      sequence += 1;
      const at = slots[slot] ?? weekStartMs;
      slot += 1;
      changes.push({
        kind: "direct_push",
        weekKey: week.key,
        commit: {
          id: `push-${pad(sequence)}`,
          message: `fix: 直接 push による修正 (${week.key})`,
          committedAt: new Date(at).toISOString(),
        },
        note: notes.join(" / ") || "平常週の直接 push",
      });
    }

    // 同着デプロイは「同じスロットを共有する merge」として作る。時刻をずらさない。
    const simultaneous = placements.some((placement) => placement.kind === "simultaneous_deploys");
    const sharedSlot = slots[slot] ?? weekStartMs;

    const stale = placements.find((placement) => placement.kind === "stale_branch");

    for (let n = 0; n < mergeCount; n += 1) {
      sequence += 1;
      const mergeAt = simultaneous ? sharedSlot : (slots[slot] ?? weekStartMs);
      slot += 1;
      // **放置ブランチはその週の 1 本目だけ。** 週の全 merge を放置ブランチにすると
      // その週の中央値ごと跳ね上がり、「中央値は平常どおりなのに裾だけ長い」という
      // 一番見たい形（ADR-0004「外れ値こそが話の種」）が作れない。周りを平常の PR にして
      // 初めて、外れ値が中央値に潰されずに p90 へ出ているかを確認できる。
      const staleWeeks = n === 0 ? (stale?.staleWeeks ?? 0) : 0;
      // 放置ブランチは、生やす地点が履歴の外へ出ないところまでしか遡れない。
      const branchFromWeeksAgo = Math.min(staleWeeks, index);

      changes.push({
        kind: "merge",
        weekKey: week.key,
        branch: `feature/${pad(sequence)}`,
        commits: branchCommits(sequence, mergeAt, branchFromWeeksAgo, random),
        merge: {
          id: `merge-${pad(sequence)}`,
          message: `Merge pull request #${sequence} from feature/${pad(sequence)}`,
          committedAt: new Date(mergeAt).toISOString(),
        },
        branchFromWeeksAgo,
        note: notes.join(" / ") || "平常週の merge",
      });
    }

    plannedWeeks.push({
      week,
      anomalies: placements.map((placement) => placement.kind),
      // 計画したとおりではなく**実際に置いた件数**を返す。最新週は `now` で切られるため、
      // `shape` の件数を返すとテストと生成ログが履歴と食い違う。
      mergeCount,
      directPushCount,
      notes,
    });
  });

  return { period, weeks: plannedWeeks, changes };
}

/** 異常ケースを週インデックスで引けるようにする。履歴に収まらない配置は落とす。 */
function groupAnomalies(weekCount: number): Map<number, AnomalyPlacement[]> {
  const grouped = new Map<number, AnomalyPlacement[]>();
  for (const placement of ANOMALIES) {
    // 両端の週は収集カバレッジが partial になり検証に使えない（上のコメント）。
    if (placement.weeksAgo < 1 || placement.weeksAgo > weekCount - 2) {
      continue;
    }
    const bucket = grouped.get(placement.weeksAgo);
    if (bucket === undefined) {
      grouped.set(placement.weeksAgo, [placement]);
    } else {
      bucket.push(placement);
    }
  }
  return grouped;
}

type WeekShape = { mergeCount: number; directPushCount: number };

/** 週の形を決める。異常ケースの指定があれば平常週の形を上書きする。 */
function shapeOf(placements: readonly AnomalyPlacement[], random: () => number): WeekShape {
  // 乱数は分岐に関わらず必ず 2 回引く。引く回数が週ごとに変わると、異常ケースを
  // 1 つ足しただけで以降の全週の形がずれ、差分が読めなくなる。
  //
  // 平常週を 3〜5 件にしてあるのは、デプロイ間隔の標本が週あたり 3 本（= MIN_SAMPLES）に
  // 届くようにするため。2 件にすると平常週まで中央値が出なくなり、
  // 「意図して値を出さない週」と「たまたま足りなかった週」が画面上で区別できない。
  const baseMerges = 3 + Math.floor(random() * 3);
  const basePushes = random() < 0.25 ? 1 : 0;

  const shape: WeekShape = { mergeCount: baseMerges, directPushCount: basePushes };

  for (const placement of placements) {
    if (placement.merges !== undefined) {
      shape.mergeCount = placement.merges;
    }
    if (placement.directPushes !== undefined) {
      shape.directPushCount = placement.directPushes;
    }
  }
  return shape;
}

/**
 * ブランチ上のコミットを作る。**merge 時刻より前**に収まるよう遡って置く。
 *
 * `branchFromWeeksAgo` が 0 なら merge の数時間〜数日前（通常の PR）、
 * 大きければその週数ぶん前（放置ブランチ）に置く。リードタイムの外れ値はここで生まれる。
 */
function branchCommits(
  sequence: number,
  mergeAtMs: number,
  branchFromWeeksAgo: number,
  random: () => number,
): PlannedCommit[] {
  // 乱数は分岐に関わらず必ず 2 回引く（`shapeOf` と同じ理由）。
  const countDraw = random();
  const spanDraw = random();

  // **放置ブランチはコミットを多めに積む。** 1 件しか積まないと、その週の標本 20 件のうち
  // 外れ値が 1 件だけになり、p90（上位 10%）に届かない。ADR-0004 が p75 / p90 を重ねる目的は
  // 「たまに 3 週間かかる PR がある」を消さないことなので、**外れ値が代表値に現れない
  // 合成履歴では検証にならない。** 長く放置されたブランチほどコミットが溜まっているのは
  // 実際の履歴でもそうなので、realism と検証可能性がここでは一致する。
  const count =
    branchFromWeeksAgo > 0 ? 4 + Math.floor(countDraw * 3) : 1 + Math.floor(countDraw * 3);
  const spanMs =
    branchFromWeeksAgo > 0
      ? branchFromWeeksAgo * MS_PER_WEEK - MS_PER_HOUR
      : (2 + spanDraw * 70) * MS_PER_HOUR;

  const commits: PlannedCommit[] = [];
  for (let n = 0; n < count; n += 1) {
    // 古い順に並べる。最初のコミットが最も古く（= リードタイムが最も長い）なる。
    const ratio = (count - n) / count;
    const at = mergeAtMs - Math.round(spanMs * ratio) + n * MS_PER_HOUR;
    commits.push({
      id: `feat-${pad(sequence)}-${n + 1}`,
      message: `feat: 機能 ${pad(sequence)} の実装 (${n + 1}/${count})`,
      committedAt: new Date(Math.min(at, mergeAtMs - MS_PER_HOUR)).toISOString(),
    });
  }
  return commits;
}

/**
 * 週内の時刻スロットを作る。JST の平日 09:00〜20:00 に散らす。
 *
 * 深夜や週末に寄せないのは、週境界（JST 月曜 00:00）の直前直後に偶然かかる変更を
 * 平常週に混ぜないため。境界そのものの検証は fixture 側のシナリオ（#16）の担当であり、
 * ここで偶然の境界跨ぎが起きると、意図した異常ケースと区別が付かなくなる。
 */
function timeSlots(count: number, weekStartMs: number, random: () => number): number[] {
  const slots: number[] = [];
  for (let n = 0; n < count; n += 1) {
    // 週の頭から均等に散らし、日内の時刻だけ乱数で振る。
    const day = Math.min(4, Math.floor((n * 5) / Math.max(count, 1)));
    const jstHour = 9 + Math.floor(random() * 11);
    const minute = Math.floor(random() * 60);
    slots.push(weekStartMs + day * MS_PER_DAY + jstHour * MS_PER_HOUR + minute * 60 * 1000);
  }
  return slots.sort((a, b) => a - b);
}

function pad(value: number): string {
  return String(value).padStart(4, "0");
}

/**
 * 決定的な擬似乱数（mulberry32）。`Math.random` を使わないのは再現性のため
 * （このファイル冒頭「決定的であること」）。
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
