/**
 * デプロイ検出ルール `default_branch`（#13 / ADR-0001 決定 2・4）。
 *
 * デフォルトブランチのコミットから**デプロイ**を検出する。粒度は 2 つ。
 *
 * - `merge_only`（既定）— 親が 2 つ以上のコミット（merge commit）だけをデプロイとみなす
 * - `all_pushes` — デフォルトブランチの全コミットをデプロイとみなす
 *
 * ## 検出を純粋関数に切り出している理由
 *
 * ADR-0004 の方針（判定ロジックは純粋関数に切り出してユニットテストする）に揃えている。
 * 粒度の違いは指標の値をそのまま変える（`all_pushes` ではリードタイムがほぼ全件ゼロになる）ため、
 * ここは DB も GitHub API も無しで網羅的に回せる状態に保つ。
 *
 * このファイルは**ルールのディスパッチを持たない**。どのスコープにどのルールを適用するかは
 * 収集ジョブ（#11）の担当で、そちらが `scopes.ts` の `DeployRule` を見て呼び分ける。
 *
 * ## デプロイ時刻に committer date を使う（`merged_at` ではない）
 *
 * ADR-0001 決定 4 / #13。理由は 2 つあり、実装で戻してはならない。
 *
 * 1. **検証可能性** — PR の `merged_at` は GitHub がサーバー時刻で刻むため過去日付を作れず、
 *    合成履歴による検証（#22）が成立しなくなる。committer date は git オブジェクトの一部なので
 *    過去日付を作れる。
 * 2. **直接 push への対応** — `merged_at` は PR が存在しないと得られない。committer date なら
 *    `merge_only` / `all_pushes` の両粒度で同じコードパスが使える。
 */

import type { Db } from "../db/index.ts";
import { type Commit, listCommits, saveDeployment } from "../db/store.ts";
import type { DefaultBranchGranularity } from "../scopes.ts";

/**
 * 検出の入力。デフォルトブランチのコミット 1 件分から、判定に要る項目だけを取る。
 *
 * `committedAt` は committer date（author date ではない。rebase / cherry-pick でずれるため。
 * ADR-0004）。`parentShas` は merge commit の判定に使う。
 */
export type DeployCandidateCommit = {
  sha: string;
  committedAt: string;
  parentShas: readonly string[];
};

/** 検出されたデプロイ。スコープに依らないので `scopeId` を持たない。 */
export type DetectedDeployment = {
  /** `deploy_events.detection_rule` に入る識別子（粒度込み）。 */
  detectionRule: string;
  commitSha: string;
  /** デプロイ時刻 = 対象コミットの committer date。 */
  deployedAt: string;
  /** 「この数値がどう計算されたか」を行から辿れるようにする判定根拠（README 柱 4）。 */
  raw: {
    rule: "default_branch";
    granularity: DefaultBranchGranularity;
    /** 判定根拠。`merge_only` は 2 以上を merge commit とみなす。 */
    parent_count: number;
  };
};

/**
 * `deploy_events.detection_rule` に入れる識別子。**粒度を識別子に含める。**
 *
 * 粒度が変わればデプロイの集合そのものが変わる（`merge_only` の 1 件が `all_pushes` では
 * 数十件になる）。それを同じ識別子で書くと、`discardDerivedData`（`src/db/store.ts`）の
 * 「現在のルール以外の行を消す」が効かず、前の粒度で検出したデプロイが生き残って二重計上になる。
 * 粒度は CONTEXT.md の言う「どのデプロイ検出ルールによって検出されたか」の一部である。
 */
export function defaultBranchRuleKey(granularity: DefaultBranchGranularity): string {
  return `default_branch:${granularity}`;
}

/**
 * デフォルトブランチのコミット列からデプロイを検出する。純粋関数。
 *
 * 返す順序は入力順のまま（並べ替えは呼び出し元の責務）。
 */
export function detectDefaultBranchDeployments(
  commits: readonly DeployCandidateCommit[],
  granularity: DefaultBranchGranularity,
): DetectedDeployment[] {
  const detectionRule = defaultBranchRuleKey(granularity);

  return commits
    .filter((commit) => isDeployment(commit, granularity))
    .map((commit) => ({
      detectionRule,
      commitSha: commit.sha,
      // デプロイ時刻は対象コミットの committer date。PR の merged_at は使わない（ADR-0001）。
      deployedAt: commit.committedAt,
      raw: {
        rule: "default_branch" as const,
        granularity,
        parent_count: commit.parentShas.length,
      },
    }));
}

function isDeployment(
  commit: DeployCandidateCommit,
  granularity: DefaultBranchGranularity,
): boolean {
  // 粒度の分岐はここ 1 箇所に閉じる。増やしたくなったらルール自体を分ける（ADR-0001 決定 1）。
  return granularity === "all_pushes" ? true : commit.parentShas.length >= 2;
}

/**
 * 保存済みのコミットからデプロイを検出して `deploy_events` に書く。
 *
 * ここは DB との薄い境界に留める。GitHub API は叩かない——`default_branch` ルールが要るのは
 * 生イベントとして保存済みのコミットだけであり、検出のために再取得する必要がない
 * （CONTEXT.md「デプロイは生イベントではない」）。
 *
 * 保存は `saveDeployment` の upsert なので、同じ入力で何度走らせても行は増えない。
 * ルールや粒度を変えたときに古い行を落とすのは `discardDerivedData` の担当で、ここではやらない
 * （どのルールが「現在」かを知っているのはスコープ設定を持つ収集ジョブ側のため）。
 */
export function recordDefaultBranchDeployments(
  db: Db,
  scopeId: string,
  granularity: DefaultBranchGranularity,
): DetectedDeployment[] {
  const candidates = listCommits(db, scopeId).map(toCandidate);
  const deployments = detectDefaultBranchDeployments(candidates, granularity);

  for (const deployment of deployments) {
    saveDeployment(db, { scopeId, ...deployment });
  }
  return deployments;
}

/**
 * `commits` 行を検出の入力に変換する。
 *
 * 親 SHA は専用の列を持たず `raw` JSON にしかない（`docs/raw-columns.md`）ため、
 * 取り出しはここの責務になる。列を足さないのは、親 SHA が**検出でしか使わない**値であり、
 * 列にすると「生イベントの正規化された形」と「1 ルールの都合」が混ざるため。
 */
function toCandidate(commit: Commit): DeployCandidateCommit {
  return {
    sha: commit.sha,
    committedAt: commit.committedAt,
    parentShas: parentShasOf(commit),
  };
}

function parentShasOf(commit: Commit): string[] {
  const parents = (commit.raw as { parents?: unknown } | null)?.parents;
  if (!Array.isArray(parents)) {
    // 空配列に落として先へ進めない。`merge_only` では親が読めないコミットが黙って
    // 「デプロイではない」に倒れ、デプロイ 0 件という誤った指標がそのまま画面に出るため。
    // 初回コミットの `parents: []` は正当な値なので、落とすのは配列でない場合だけ。
    throw new Error(
      `コミット ${commit.sha} の raw に parents がありません。` +
        "デプロイ検出ルール `default_branch` は merge commit の判定に親 SHA を使います" +
        "（`docs/raw-columns.md`）",
    );
  }
  return parents.map((parent) => String((parent as { sha?: unknown }).sha));
}
