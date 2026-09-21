/**
 * ストアの行を `MetricsInput` へ詰め替え、指標を計算して画面へ渡す層（#20）。
 *
 * ## なぜ「詰め替えるだけ」の層を挟むのか
 *
 * ADR-0004 は指標計算を**純粋関数に切り出す**と決め、その切り出し線が
 * `metrics/types.ts` の `MetricsInput` である（指標側は `better-sqlite3` も `fetch` も
 * import しない）。DB を読むのはこちら側の仕事で、**この向きを逆にしない**。
 * 指標計算に `Db` を渡せるようにした時点で、fixture からの再現（ADR-0004）も
 * 「この数値がどう計算されたか」（`README.md` 柱 4）も辿れなくなる。
 *
 * ## 集計値は保存しない
 *
 * ADR-0002 の通り、指標はクエリのたびにここを通して計算し直す。
 * したがってこの層は**読み取りと変換だけ**で、書き込み経路もキャッシュも持たない。
 *
 * #21（指標詳細）もここを入口にする。`loadScopeMetrics` は週次の結果をそのまま返すので、
 * 詳細画面は返り値の `deployFrequency.weeks` / `leadTime.weeks` から対象週を引けばよい。
 */

import type { Db } from "../db/index.ts";
import {
  findCollectionCursor,
  listCommits,
  listDeployments,
  listPullRequests,
} from "../db/store.ts";
import { listDeploymentCommits } from "../deploy/assignment.ts";
import { deployRuleKey } from "../deploy/index.ts";
import {
  calculateDeployFrequency,
  type DeployFrequencyResult,
} from "../metrics/deploy-frequency.ts";
import { calculateLeadTime, type LeadTimeMetrics } from "../metrics/lead-time.ts";
import type { DeployCommitAssignment, MetricsInput } from "../metrics/types.ts";
import type { Period } from "../metrics/week.ts";
import type { Scope } from "../scopes.ts";
import { type CollectionStatus, collectionStatusOf } from "./collection-status.ts";

/**
 * スコープ 1 つ分の、画面が必要とするもの一式。
 *
 * **スコープをまたいで足し合わせた値はここに存在しない。** 合算・横並び比較・ランキングは
 * `README.md` のアンチパターンとして禁じており、そもそも「複数スコープ分を 1 つに束ねた型」を
 * 作らないことで、画面側がうっかり合算できないようにしてある。
 */
export type ScopeMetrics = {
  scope: Scope;
  /** このスコープの現在のデプロイ検出ルールキー（例 `default_branch:merge_only`）。 */
  detectionRule: string;
  period: Period;
  /** 計算に使った入力そのもの。#21 が根拠イベントを引くのに使える。 */
  input: MetricsInput;
  deployFrequency: DeployFrequencyResult;
  leadTime: LeadTimeMetrics;
  collection: CollectionStatus;
};

/**
 * ストアから `MetricsInput` を組み立てる。
 *
 * ルールキーは必ず `deployRuleKey` から得る。キーの作り方が分かれると、
 * `discardDerivedData` の「現在のルール以外の行を消す」が効かず、
 * 古い定義で検出したデプロイを混ぜたまま数えることになる（#11 のコメント）。
 */
export function buildMetricsInput(db: Db, scope: Scope, period: Period): MetricsInput {
  const detectionRule = deployRuleKey(scope.deployRule);
  const cursor = findCollectionCursor(db, scope.id);

  return {
    scopeId: scope.id,
    detectionRule,
    period,
    deployments: listDeployments(db, scope.id, detectionRule).map((deployment) => ({
      deployedAt: deployment.deployedAt,
      commitSha: deployment.commitSha,
      detectionRule: deployment.detectionRule,
    })),
    commits: listCommits(db, scope.id).map((commit) => ({
      sha: commit.sha,
      committedAt: commit.committedAt,
    })),
    pullRequests: listPullRequests(db, scope.id).map((pr) => ({
      number: pr.number,
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      mergeCommitSha: pr.mergeCommitSha,
      headSha: pr.headSha,
    })),
    deployCommits: assignments(db, scope.id, detectionRule),
    // カーソルが無い（まだ 1 度も収集していない）スコープは「どの週もカバーしていない」。
    // ここを楽観的に埋めると、収集していない範囲の 0 件が本物の 0 として表示される
    // （`metrics/coverage.ts` の「分からない側はカバーしていないに倒す」と同じ判断）。
    coverage: {
      backfilledUntil: cursor?.backfilledUntil ?? null,
      backfillComplete: cursor?.backfillComplete ?? false,
      lastSuccessAt: cursor?.lastSuccessAt ?? null,
    },
  };
}

/**
 * デプロイ → コミット集合の割り当てのうち、**標本にしてよいものだけ**を渡す。
 *
 * `listDeploymentCommits` は `assigned` / `oldest` / `pending` の 3 状態を返す（#15）。
 * `oldest`（base が決められない最古のデプロイ）と `pending`（まだ compare していない）を
 * 通すと、差分 0 件のデプロイとして扱われ、**リードタイムの標本が黙って欠ける**。
 * 集計側は `assigned` 以外を標本に含めてはならない、という #15 の約束をここで守る。
 */
function assignments(db: Db, scopeId: string, detectionRule: string): DeployCommitAssignment[] {
  const result: DeployCommitAssignment[] = [];
  for (const entry of listDeploymentCommits(db, scopeId, detectionRule)) {
    if (entry.status !== "assigned" || entry.baseSha === null) {
      continue;
    }
    result.push({
      deploymentCommitSha: entry.headSha,
      baseSha: entry.baseSha,
      commitShas: entry.commitShas,
      truncated: entry.truncated,
    });
  }
  return result;
}

/**
 * スコープ 1 つ分の指標と収集状態を読み込む。画面（#20 / #21）の唯一の入口。
 *
 * `now` を引数で受け取るのは、収集状態の「最後の成功から n 時間前」がテストで固定できるように
 * するため（ADR-0007 でこの表示は必須要件になった）。
 */
export function loadScopeMetrics(db: Db, scope: Scope, period: Period, now: Date): ScopeMetrics {
  const input = buildMetricsInput(db, scope, period);
  return {
    scope,
    detectionRule: input.detectionRule,
    period,
    input,
    deployFrequency: calculateDeployFrequency(input),
    leadTime: calculateLeadTime(input),
    collection: collectionStatusOf(findCollectionCursor(db, scope.id), scope, now),
  };
}
