/**
 * 収集サイクル 1 回分（#11 / ADR-0007 決定 4）。
 *
 * ここで守る約束は 2 つ。
 * - 例外を外に投げない。1 スコープの失敗が他スコープやプロセスを巻き込まない（ADR-0003 引き継ぎ）
 * - 起動時（追いつき）と定期実行で同じ入口を通る
 *
 * 部品は #10〜#15 で切り出してあり、ここはそれを繋ぐだけに留める。
 * - スコープ単位の失敗分離: `per-scope.ts`（#10）
 * - 最新を追う収集: `follow.ts`（#11。収集カーソルの `followed_until`）
 * - 過去へ遡る収集: `backfill.ts` / `window.ts`（#12。収集カーソルの `backfilled_until`）
 * - 窓 1 つ分の生イベント取得と保存: `events.ts`
 * - デプロイ検出ルールのディスパッチ: `../deploy/index.ts`（#13 / #14）
 * - コミットのデプロイへの割り当て: `../deploy/assignment.ts`（#15）
 *
 * ## 手動トリガは作らない（#11 で却下済み）
 *
 * 画面にボタンを置いて人間に押させる案は却下されている。押し忘れると古いデータで判断する
 * ことになるため、**起動 = 最新化**にする。したがって収集の入口はスケジューラだけである。
 *
 * ## 一括で取り切らない
 *
 * 1 ヶ月起動しなければ 1 ヶ月分の遅れが溜まる（ADR-0007 決定 3）。最新方向も過去方向も
 * 窓に分けて進め、レート制限（`GitHubRateLimitError`）に当たれば**待たずに中断**する。
 * 中断の処理は `per-scope.ts` がすでに持っているので、ここでは例外をそのまま抜けさせる。
 */

import type { Db } from "../db/index.ts";
import { assignCommitsToDeployments } from "../deploy/assignment.ts";
import { createDeployDetection } from "../deploy/index.ts";
import type { GitHubClient } from "../github/client.ts";
import { logger } from "../logger.ts";
import type { Scope } from "../scopes.ts";
import type { WindowCollection } from "./backfill.ts";
import { runBackfill } from "./backfill.ts";
import { collectWindowEvents } from "./events.ts";
import { runFollow } from "./follow.ts";
import { collectPerScope, type PerScopeOutcome } from "./per-scope.ts";

export type CollectionTrigger = "startup" | "schedule";

/**
 * GITHUB_TOKEN が未設定のまま収集しようとした。
 *
 * **黙って空振りさせない。** 空振りにすると画面は「デプロイ 0 件」を正常値として表示し、
 * 利用者は設定漏れに気づかないまま古い（あるいは存在しない）データで判断することになる。
 * レート制限ではないので収集サイクル全体は止めず、`per-scope.ts` がスコープごとの
 * 収集失敗として `collection_cursors.last_error` に残す（画面に出る / ADR-0007）。
 */
export class MissingGitHubTokenError extends Error {
  constructor() {
    super(
      "GITHUB_TOKEN が未設定のため収集できません" +
        "（.env に read-only の fine-grained PAT を設定してください）",
    );
    this.name = "MissingGitHubTokenError";
  }
}

export type CollectionOptions = {
  db: Db;
  /** 計測対象のスコープ一覧（#9。`scopes.toml` 由来）。 */
  scopes: readonly Scope[];
  /** GITHUB_TOKEN が未設定なら `undefined`。全スコープが収集失敗として記録される。 */
  client: GitHubClient | undefined;
  trigger: CollectionTrigger;
  /** テストから時刻を固定するための継ぎ目。 */
  now?: Date;
  /** 窓の分割日数。既定は `window.ts` / `follow.ts` の値。 */
  chunkDays?: number;
};

/** 収集サイクル 1 回分を実行する。例外は外に出さない。 */
export async function runCollection(options: CollectionOptions): Promise<PerScopeOutcome> {
  const { db, scopes, trigger } = options;
  logger.info("収集サイクルを開始", { trigger, scopes: scopes.length });

  const byId = new Map(scopes.map((scope) => [scope.id, scope]));
  const outcome = await collectPerScope(
    db,
    scopes.map((scope) => scope.id),
    async (scopeId) => {
      const scope = byId.get(scopeId);
      if (scope === undefined) {
        throw new Error(`スコープ設定に ${scopeId} がありません`);
      }
      await collectScope(scope, options);
    },
  );

  logger.info("収集サイクルを終了", {
    trigger,
    succeeded: outcome.succeeded.length,
    failed: outcome.failed.length,
    skipped: outcome.skipped.length,
    rateLimited: outcome.rateLimited,
  });
  return outcome;
}

/**
 * 1 スコープ分の収集。
 *
 * 順序に意味がある。
 * 1. **最新を追う** — 最も価値が高いのは直近のデータである。レート制限で中断しても、
 *    少なくとも最新側は入っている状態にする
 * 2. **過去へ遡る** — 残った予算で範囲の端まで進める
 * 3. **デプロイを確定させる** — 取り込んだ生イベントにルールを適用する
 * 4. **コミットを割り当てる** — デプロイが確定してからでないと差分の base / head が決まらない
 *
 * 収集の成否（`recordCollectionSuccess` / `recordCollectionFailure`）は `per-scope.ts` が
 * 記録する。ここでは二重に呼ばない。
 */
async function collectScope(scope: Scope, options: CollectionOptions): Promise<void> {
  const { db, now, chunkDays } = options;
  if (options.client === undefined) {
    throw new MissingGitHubTokenError();
  }
  const client = options.client;

  const detection = createDeployDetection(db, client, scope);

  // 最新方向と過去方向で同じ形（`WindowCollection`）の処理を使い回す。
  // 窓の決め方だけが違い、窓を渡されてからやることは同一である。
  const collect: WindowCollection = async (window) => {
    await collectWindowEvents(db, client, scope, window);
    await detection.collectWindow(window);
  };

  const follow = await runFollow(db, scope, collect, { now, chunkDays });
  const backfill = await runBackfill(db, scope, collect, { now, chunkDays });

  // 保存済みの生イベントから確定させるルール（`default_branch`）はここで動く。
  await detection.finalize();

  // 割り当ての入口は `discardDerivedData` を通るため、ルールを変更した直後の収集で
  // 古いルールのデプロイと差分キャッシュがここで落ちる（CONTEXT.md「デプロイ」）。
  const assigned = await assignCommitsToDeployments({
    db,
    client,
    repo: { owner: scope.owner, repo: scope.repo },
    scopeId: scope.id,
    detectionRule: detection.ruleKey,
  });

  logger.info("スコープの収集を終えた", {
    scopeId: scope.id,
    detectionRule: detection.ruleKey,
    followedWindows: follow.windows.length,
    followedUntil: follow.followedUntil,
    backfilledWindows: backfill.windows.length,
    backfillComplete: backfill.progress.complete,
    coveredDays: backfill.progress.coveredDays,
    deployments: assigned.length,
  });
}
