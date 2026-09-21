/**
 * 最新を追う収集（#11 / ADR-0007 決定 4）。
 *
 * 収集カーソルの `followed_until`（どこまで最新を追ったか。マイグレーション 008）を起点に、
 * 現在時刻まで**前へ**進む。過去へ**遡る**のは `backfill.ts` の担当で、両者は同じカーソル行の
 * 別々の列を進める（CONTEXT.md の収集カーソル）。
 *
 * ## ここも窓に分ける
 *
 * ADR-0007 決定 3 によりアプリは必要なときにしか起動しない。1 ヶ月起動しなければ
 * 1 ヶ月分の遅れが溜まり、「最新を追う」といっても実体は長い追いつきになる。
 * #11 が「起動時の追いつきは #12 の分割ジョブに乗せる」と言うのはこのためで、
 * 過去方向と同じく**窓の単位で区切り、取り終えた窓の分だけカーソルを進める**。
 * 途中でレート制限に当たっても、次の収集サイクルが続きから拾う。
 *
 * 窓は必ず**古い側から**進める。カーソルは「ここまでは取り込んだ」という 1 本の水位線であり、
 * 新しい側から取ると、中断時に水位線を動かせる根拠が無くなる（間に穴が開く）。
 */

import type { Db } from "../db/index.ts";
import { type CollectionCursor, findCollectionCursor, recordFollowProgress } from "../db/store.ts";
import { logger } from "../logger.ts";
import type { Scope } from "../scopes.ts";
import type { WindowCollection } from "./backfill.ts";
import { type CollectionWindow, DEFAULT_BACKFILL_CHUNK_DAYS } from "./window.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 1 窓で進む日数。過去方向（#12）と揃えておく。 */
export const DEFAULT_FOLLOW_CHUNK_DAYS = DEFAULT_BACKFILL_CHUNK_DAYS;

/**
 * 起点を遡らせる日数（窓の重ね取り）。
 *
 * GitHub 上の出来事は、**窓を閉じたあとに窓の中の時刻で現れることがある**。
 * force push による committer date の書き換え、窓より前に作られた PR の後からのマージ、
 * 再実行によるワークフロー実行の更新がそれにあたる。前回の到達点をそのまま `since` にすると
 * これらを永久に取りこぼす。保存はすべて upsert（`store.ts`）なので、重ねて取っても行は増えない。
 *
 * 7 日にしているのは、1 時間ごとの収集で毎回 7 日分を取り直しても 1 スコープあたり
 * 数リクエストで収まり、レート制限（5,000 req/hour）に対して無視できる量だからである。
 */
export const DEFAULT_FOLLOW_OVERLAP_DAYS = 7;

export type FollowPlanInput = {
  /** 未収集のスコープでは `undefined`。 */
  cursor: Pick<CollectionCursor, "followedUntil"> | undefined;
  chunkDays?: number;
  overlapDays?: number;
  now?: Date;
};

export type FollowPlan =
  /** 次に取る窓。`reachesNow` が立てばこの窓で現在時刻に届く。 */
  | { kind: "window"; window: CollectionWindow; reachesNow: boolean }
  /**
   * 追いつき済み。取りに行くものが無い。
   *
   * 初回（`followed_until` が null）もここに来る。**過去へ遡る収集の最初の窓が
   * 現在時刻から始まる**（`window.ts` の `planBackfillWindow`）ため、初回に限っては
   * 最新側はバックフィルが覆う。ここで別に取りに行くと同じ範囲を二重に取ることになる。
   */
  | { kind: "caught-up" };

/** 次に取得する時間窓を決める。純粋関数。DB も GitHub も触らない。 */
export function planFollowWindow(input: FollowPlanInput): FollowPlan {
  const now = input.now ?? new Date();
  const chunkDays = positiveDays(input.chunkDays ?? DEFAULT_FOLLOW_CHUNK_DAYS, "分割日数");
  const overlapDays = input.overlapDays ?? DEFAULT_FOLLOW_OVERLAP_DAYS;
  // 重ね取りが 1 窓分以上あると、窓を取り終えてカーソルを進めても次の窓の起点が前へ戻り、
  // 追いついているつもりで同じ範囲を永遠に取り直す。
  if (!Number.isFinite(overlapDays) || overlapDays < 0 || overlapDays >= chunkDays) {
    throw new Error(
      `最新を追う収集の重ね取り日数は 0 以上・分割日数（${chunkDays}）未満である必要があります: ${overlapDays}`,
    );
  }

  const followedUntil = input.cursor?.followedUntil ?? null;
  if (followedUntil === null) {
    return { kind: "caught-up" };
  }

  const sinceMs = parseInstant(followedUntil, "followed_until") - overlapDays * MS_PER_DAY;
  const nowMs = now.getTime();
  if (sinceMs >= nowMs) {
    return { kind: "caught-up" };
  }

  const untilMs = Math.min(sinceMs + chunkDays * MS_PER_DAY, nowMs);
  return {
    kind: "window",
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    reachesNow: untilMs >= nowMs,
  };
}

export type FollowOptions = {
  now?: Date;
  chunkDays?: number;
  overlapDays?: number;
};

export type FollowResult = {
  /** この呼び出しで取り終えた窓。古い順。 */
  windows: CollectionWindow[];
  /** 更新後の「どこまで最新を追ったか」。 */
  followedUntil: string;
};

/**
 * 前回の到達点から現在時刻まで、窓を分けて追いつく。
 *
 * `runBackfill`（#12）と同じく、例外は分類せずそのまま投げる。スコープ単位の失敗分離と
 * 収集サイクルの中断は `per-scope.ts` の担当で、ここで捕まえると
 * 「1 スコープの問題」と「credential 全体の問題」の区別が消える。
 */
export async function runFollow(
  db: Db,
  scope: Pick<Scope, "id">,
  collect: WindowCollection,
  options: FollowOptions = {},
): Promise<FollowResult> {
  const now = options.now ?? new Date();
  const windows: CollectionWindow[] = [];

  for (let index = 0; ; index += 1) {
    const cursor = findCollectionCursor(db, scope.id);
    const plan = planFollowWindow({
      cursor,
      chunkDays: options.chunkDays,
      // 重ね取りは**この実行の最初の窓にだけ**効かせる。2 窓目以降は直前の窓の続きから
      // 取るので、そこにも重ねると 1 窓あたりの前進が（分割日数 − 重ね取り日数）まで縮み、
      // 長い追いつきほど同じ範囲を何度も取り直すことになる。
      overlapDays: index === 0 ? options.overlapDays : 0,
      now,
    });

    if (plan.kind === "caught-up") {
      if (cursor?.followedUntil == null) {
        // 初回。取りに行かずに水位線だけ置く。ここより過去はバックフィルが覆う。
        recordFollowProgress(db, scope.id, now.toISOString());
        logger.info("最新を追う収集の起点を置いた（初回。過去分はバックフィルが覆う）", {
          scopeId: scope.id,
          followedUntil: now.toISOString(),
        });
      }
      break;
    }

    await collect(plan.window);
    // カーソルを進めるのは取得と保存が終わったあと。ここより手前で中断すれば同じ窓から再開する。
    recordFollowProgress(db, scope.id, plan.window.until);
    windows.push(plan.window);
    logger.info("最新を追う収集の窓を取り終えた", {
      scopeId: scope.id,
      since: plan.window.since,
      until: plan.window.until,
      reachesNow: plan.reachesNow,
    });

    if (plan.reachesNow) {
      break;
    }
  }

  return {
    windows,
    // 直前に自分で書いた値を読み直す。途中で中断されていない限り now と一致する。
    followedUntil: findCollectionCursor(db, scope.id)?.followedUntil ?? now.toISOString(),
  };
}

function positiveDays(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    // 0 以下だと窓が 1 ミリ秒も進まず、追いついているつもりで同じ窓を取り直し続ける。
    throw new Error(`最新を追う収集の${label}は正の数である必要があります: ${value}`);
  }
  return value;
}

/** カーソルの時刻は自前で書いた値だが、DB ファイルは手で触れる場所にある（`window.ts` と同じ理由）。 */
function parseInstant(value: string, label: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`収集カーソルの ${label} が時刻として読めません: ${value}`);
  }
  return ms;
}
