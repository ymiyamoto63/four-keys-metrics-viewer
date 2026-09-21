/**
 * デプロイ検出ルールのディスパッチ（#11 / ADR-0001）。
 *
 * スコープ設定の `DeployRule` を見て、`default_branch`（#13）と `workflow_run`（#14）の
 * どちらを走らせるかを決める**唯一の場所**である。各ルールの実装ファイルは意図的に
 * ディスパッチを持たず（それぞれの冒頭コメント参照）、ここに集めてある。
 *
 * ## 分岐を 1 箇所に閉じる理由
 *
 * ルールは 1 スコープに 1 つで、OR 合成しない（ADR-0001 決定 1 / CONTEXT.md）。
 * 分岐が散ると「このスコープはどのルールで数えているか」がコードから読めなくなり、
 * README 柱 4（算出ロジックの開示）が実装側から崩れる。`DeployRule` は判別可能ユニオンなので、
 * ここで網羅していればルールを増やしたときに型検査が漏れを指摘する。
 *
 * ## 「窓ごと」と「最後に 1 回」を分けてある理由
 *
 * ルールによってデプロイの材料が違う。
 *
 * - `default_branch` は**保存済みのコミット**だけで判定できる。外部 API は要らないので、
 *   窓ごとに呼ぶ必要はなく、収集サイクルの最後に 1 回まとめて確定させればよい
 * - `workflow_run` は**ワークフロー実行**という別のデータを外部から取る必要がある。
 *   取得量を抑えるには収集した窓に合わせて取るしかないので、窓ごとに呼ぶ
 *
 * この差を収集ジョブ側に漏らさないため、ディスパッチを `collectWindow` / `finalize` の
 * 2 段に分けた 1 つの値として返す。収集ジョブ（`collector/index.ts`）はルール名を一切見ない。
 */

import type { Db } from "../db/index.ts";
import type { GitHubClient } from "../github/client.ts";
import type { DeployRule, Scope } from "../scopes.ts";
import { defaultBranchRuleKey, recordDefaultBranchDeployments } from "./default-branch.ts";
import { collectWorkflowRunDeployments, workflowRunRuleKey } from "./workflow-run.ts";

/**
 * `deploy_events.detection_rule` に入るルールキー。
 *
 * 粒度（`default_branch`）や対象ワークフロー（`workflow_run`）まで含んだ文字列を返す。
 * 検出・割り当て（#15）・画面（#20）はすべてこの 1 つの関数からキーを得ること。
 * キーの作り方が分かれると `discardDerivedData`（`db/store.ts`）の
 * 「現在のルール以外の行を消す」が効かず、古い定義で検出したデプロイが生き残る。
 */
export function deployRuleKey(rule: DeployRule): string {
  switch (rule.name) {
    case "default_branch":
      return defaultBranchRuleKey(rule.granularity);
    case "workflow_run":
      return workflowRunRuleKey(rule.workflow);
  }
}

/** 収集する時間窓。`collector` の `CollectionWindow` を構造的に受け取る（#12 と共通の形）。 */
export type DeployDetectionWindow = {
  since: string;
  until: string;
};

export type DeployDetection = {
  /** このスコープの現在のルールキー。割り当て（#15）と画面（#20）に渡す。 */
  readonly ruleKey: string;
  /** 生イベントの窓を 1 つ取り終えるたびに呼ぶ。外部 API が要るルールだけが実際に動く。 */
  collectWindow(window: DeployDetectionWindow): Promise<void>;
  /** 収集サイクルの最後に 1 回呼ぶ。保存済みの生イベントからデプロイを確定させる。 */
  finalize(): Promise<void>;
};

export type DeployDetectionScope = Pick<Scope, "id" | "owner" | "repo" | "deployRule">;

/**
 * スコープのデプロイ検出ルールに対応する検出器を組み立てる。
 *
 * 古いルールで検出したデプロイの破棄はここではやらない。割り当ての入口
 * （`assignment.ts` の `assignCommitsToDeployments` / `listDeploymentCommits`）が
 * 必ず `discardDerivedData` を通す作りになっており、そちらに一本化してある。
 */
export function createDeployDetection(
  db: Db,
  client: GitHubClient,
  scope: DeployDetectionScope,
): DeployDetection {
  const rule = scope.deployRule;

  switch (rule.name) {
    case "default_branch":
      return {
        ruleKey: defaultBranchRuleKey(rule.granularity),
        // 材料は保存済みのコミットだけ。窓ごとにやることは無い。
        collectWindow: async () => {},
        finalize: async () => {
          recordDefaultBranchDeployments(db, scope.id, rule.granularity);
        },
      };

    case "workflow_run":
      return {
        ruleKey: workflowRunRuleKey(rule.workflow),
        collectWindow: async (window) => {
          await collectWorkflowRunDeployments(
            db,
            client,
            { id: scope.id, owner: scope.owner, repo: scope.repo, deployRule: rule },
            { since: window.since, until: window.until },
          );
        },
        // 窓ごとの取得で `deploy_events` まで書き終わっているので、ここでやることは無い。
        finalize: async () => {},
      };
  }
}
