/**
 * 収集カーソルから「次にどの時間窓を取りに行くか」と「バックフィルの進捗」を導出する（#12）。
 *
 * ここは純粋関数だけに保つ。DB も GitHub も触らない。実際に取得してカーソルを進めるのは
 * `backfill.ts`、1 スコープ分をどう取得するかは収集ジョブ（#11）の担当である。
 *
 * ## なぜ時間窓で分割するのか
 *
 * ADR-0007 決定 6。Workers の CPU 上限という当初の理由は消えたが、根拠は次に置き換わった。
 *
 * - アプリは必要なときにだけ起動され、任意のタイミングで停止・クラッシュしうる
 * - GitHub のレート制限（認証済み 5,000 req/hour）は自ホストでも変わらない
 *
 * したがって「どこまで遡ったか」を窓の単位で記録し、中断しても次回の起動が続きから拾う。
 * 窓を細かくすれば中断時の取り直しは減るが、リクエスト数は増える。
 *
 * ## 窓は過去方向にしか進まない
 *
 * ここが扱うのは「過去へ遡る収集」だけである。「最新を追う収集」は起点が収集カーソルの
 * 別のフィールドになる（CONTEXT.md の収集カーソル）ため #11 で追加するが、
 * **窓を渡されて取得する側**（`WindowCollection`）は両方で同じ形にしてある。
 */

import type { CollectionCursor } from "../db/store.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 1 周回で遡る日数。
 *
 * 30 日にしているのは、既定のバックフィル範囲 1 年（ADR-0003 から引き継ぎ）を
 * 12 窓に割る粒度であり、中断時に取り直す量が最大 1 ヶ月分で収まるため。
 */
export const DEFAULT_BACKFILL_CHUNK_DAYS = 30;

/** GitHub の `since` / `until` に渡す時間窓。両端とも ISO8601。 */
export type CollectionWindow = {
  since: string;
  until: string;
};

export type BackfillPlan =
  | {
      kind: "window";
      window: CollectionWindow;
      /** この窓を取り終えるとバックフィル範囲の端に届く。 */
      reachesTarget: boolean;
    }
  /** 遡る先が残っていない。過去方向の取得は行わない（#12 完了条件）。 */
  | { kind: "complete" };

export type BackfillPlanInput = {
  /** 未収集のスコープでは `undefined`。 */
  cursor: Pick<CollectionCursor, "backfilledUntil" | "backfillComplete"> | undefined;
  /** バックフィル範囲（日数）。スコープ設定から来る（既定 1 年）。 */
  backfillDays: number;
  chunkDays?: number;
  now?: Date;
};

/**
 * 次に取得する時間窓を決める。
 *
 * バックフィル範囲はスコープ設定で変更できる。範囲を広げると目標時刻が過去へ動くため、
 * 完了扱いだったスコープに再び窓が出る。逆に狭めれば、遡り済みのデータを消さずに完了になる。
 */
export function planBackfillWindow(input: BackfillPlanInput): BackfillPlan {
  const now = input.now ?? new Date();
  const chunkDays = input.chunkDays ?? DEFAULT_BACKFILL_CHUNK_DAYS;
  if (!Number.isFinite(chunkDays) || chunkDays <= 0) {
    // 0 以下だと窓が 1 ミリ秒も進まず、遡っているつもりで永遠に同じ窓を取り直す。
    throw new Error(`バックフィルの分割日数は正の数である必要があります: ${chunkDays}`);
  }
  const target = backfillTarget(input.backfillDays, now);

  if (input.cursor?.backfillComplete === true) {
    return { kind: "complete" };
  }

  // 未着手なら現在時刻から遡り始める。ここより新しい範囲は「最新を追う収集」（#11）の担当。
  const until = input.cursor?.backfilledUntil ?? now.toISOString();
  const untilMs = parseInstant(until, "backfilled_until");
  if (untilMs <= target.getTime()) {
    return { kind: "complete" };
  }

  const sinceMs = Math.max(untilMs - chunkDays * MS_PER_DAY, target.getTime());
  return {
    kind: "window",
    window: { since: new Date(sinceMs).toISOString(), until },
    reachesTarget: sinceMs <= target.getTime(),
  };
}

export type BackfillProgress = {
  /** どこまで過去へ遡ったか。`null` は未着手。 */
  backfilledUntil: string | null;
  /** 遡る目標時刻。 */
  target: string;
  targetDays: number;
  /** 遡り終えた日数。画面（#20）の「1 年分のうち N 日分」に使う。 */
  coveredDays: number;
  complete: boolean;
};

/**
 * バックフィルの進捗。画面に常時表示する（ADR-0007。常時稼働しないため、
 * これが無いと利用者は「まだ集めていない範囲」を「デプロイが無かった範囲」と読む）。
 */
export function describeBackfillProgress(
  input: Omit<BackfillPlanInput, "chunkDays">,
): BackfillProgress {
  const now = input.now ?? new Date();
  const target = backfillTarget(input.backfillDays, now);
  const complete = input.cursor?.backfillComplete === true;
  const backfilledUntil = input.cursor?.backfilledUntil ?? null;

  const coveredDays = complete
    ? input.backfillDays
    : backfilledUntil === null
      ? 0
      : clamp(
          (now.getTime() - parseInstant(backfilledUntil, "backfilled_until")) / MS_PER_DAY,
          0,
          input.backfillDays,
        );

  return {
    backfilledUntil,
    target: target.toISOString(),
    targetDays: input.backfillDays,
    coveredDays: Math.floor(coveredDays),
    complete,
  };
}

function backfillTarget(backfillDays: number, now: Date): Date {
  return new Date(now.getTime() - backfillDays * MS_PER_DAY);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * カーソルの時刻は自前で書いた値だが、DB ファイルは手で触れる場所にある。
 * 壊れた値を黙って「未着手」に落とすと、収集済みの範囲を静かに取り直すことになる。
 */
function parseInstant(value: string, label: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`収集カーソルの ${label} が時刻として読めません: ${value}`);
  }
  return ms;
}
