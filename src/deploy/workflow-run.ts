/**
 * デプロイ検出ルール `workflow_run` — 指定した Actions ワークフローの成功実行を
 * 1 デプロイとみなす（#14 / ADR-0001 決定 2）。
 *
 * ## 責務
 *
 * ワークフロー実行レスポンスの射影（`projectWorkflowRun`）と、
 * 「どれをデプロイとみなすか」の判定、そして `deploy_events` への保存だけを持つ。
 * ルールのディスパッチ（スコープ設定を見てどのルールを走らせるか）は収集ジョブ（#11）の担当で、
 * ここには置かない。
 *
 * 射影を `src/github/project.ts` ではなくこちら側に置いているのは、ワークフロー実行が
 * 生イベント（`commits` / `pull_requests`）ではなく**このルールでしか使わないデータ**だからである。
 * `client.ts` の `listWorkflowRuns` も「射影は #14 が決める」として生のまま返してくる。
 *
 * ## `default_branch` との併用は禁止（ADR-0001 の OR 合成禁止）
 *
 * 同一スコープで 2 つのルールを併用すると同一デプロイの二重計上が起き、
 * 「どのルールで数えたのか」を辿れなくなる。ただしその防御は設定レベルで済んでいる
 * （`src/scopes.ts` の `readDeployRule` が 1 スコープ 1 ルールを強制する）。
 * ここで再実装すると、同じ不変条件が 2 箇所に散る。
 */

import type { Db } from "../db/index.ts";
import { type Deployment, saveDeployment } from "../db/store.ts";
import type { GitHubClient } from "../github/client.ts";
import { logger } from "../logger.ts";
import type { DeployRule, Scope } from "../scopes.ts";

/**
 * `deploy_events.detection_rule` に入れる識別子。**対象ワークフローを含める。**
 *
 * 対象ワークフローが変われば「何をデプロイとみなすか」が変わり、過去に検出したデプロイは
 * もう現在の定義の産物ではない。識別子にワークフローを含めておくと、
 * `discardDerivedData`（`src/db/store.ts`）の「現在のルール以外の行を消す」が
 * ワークフローの差し替えにもそのまま効く。ルール名だけを入れると、`deploy.yml` から
 * `release.yml` に変えても古い行が現在のルールの行として生き残る（柱 4 が嘘になる）。
 */
export function workflowRunRuleKey(workflow: string): string {
  return `workflow_run:${workflow}`;
}

/** 射影後のワークフロー実行。`raw` は `deploy_events.raw` にそのまま入る。 */
export type ProjectedWorkflowRun = {
  id: number;
  /** この実行が対象としたコミット。デプロイの `commit_sha` になる。 */
  headSha: string;
  /** `completed` / `in_progress` など。未完了の実行は `conclusion` が null になる。 */
  status: string | null;
  /** `success` / `failure` / `cancelled` / `skipped` など。未完了なら null。 */
  conclusion: string | null;
  runStartedAt: string;
  /** 実行の完了時刻。デプロイ時刻になる（後述の理由で `updated_at` を採る）。 */
  completedAt: string;
  /** ワークフロー名（例 `build-and-deploy`）。 */
  workflowName: string | null;
  /** ワークフローのファイルパス（例 `.github/workflows/deploy.yml`）。 */
  workflowPath: string;
  htmlUrl: string;
  raw: {
    id: number;
    name: string | null;
    path: string;
    head_sha: string;
    status: string | null;
    conclusion: string | null;
    run_attempt: number;
    run_started_at: string;
    updated_at: string;
    html_url: string;
  };
};

type WorkflowRunResponse = {
  id: number;
  name?: string | null;
  path: string;
  head_sha: string;
  status?: string | null;
  conclusion?: string | null;
  run_attempt?: number;
  run_started_at?: string;
  created_at: string;
  updated_at: string;
  html_url: string;
};

/**
 * ワークフロー実行レスポンスから、本アプリが使う項目だけを取り出す
 * （線引きの方針は `docs/raw-columns.md`）。
 *
 * `actor` / `triggering_actor` / `head_commit.author` / `head_commit.committer` の
 * ユーザー情報は意図的に取り込まない。「個人の評価に使わせない」は方針として書くより
 * データを持たないほうが強い（README のアンチパターン）。`repository` /
 * `head_repository` / 各種 `*_url` は生レスポンスの大半を占めるが一切使わない。
 *
 * ## 完了時刻に `updated_at` を採る理由
 *
 * ワークフロー実行のレスポンスに**完了時刻そのもののフィールドは無い**
 * （実レスポンスに載る時刻は `created_at` / `run_started_at` / `updated_at` の 3 つだけ。
 * `src/deploy/__fixtures__/workflow_run.json` で固定している）。正確な完了時刻を得るには
 * jobs API を実行 1 件ごとに叩いて `completed_at` を集める必要があり、デプロイ 1 件につき
 * 1 コール増える。レート制限で待機しない構成（ADR-0007 / #10）でこれは割に合わない。
 *
 * `updated_at` は実行が終わった時点で更新されるため、実質的な完了時刻として使える。
 * 注意点は、**再実行（`run_attempt` の増加）などで後から動きうる**こと。その場合
 * デプロイ時刻は最新の試行の完了時刻に寄るが、`deploy_events` の主キーは
 * (scope_id, detection_rule, commit_sha) で upsert するため行は増えず、時刻だけが更新される。
 * 「そのコミットが本番に出た最後の時刻」と読めるので、指標としても破綻しない。
 */
export function projectWorkflowRun(response: unknown): ProjectedWorkflowRun {
  const run = response as WorkflowRunResponse;

  const raw = {
    id: run.id,
    name: run.name ?? null,
    path: run.path,
    head_sha: run.head_sha,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    // 再実行を経た実行かどうかは、完了時刻の読み方（上記）に直結するので残す。
    run_attempt: run.run_attempt ?? 1,
    // 古い実行には run_started_at が無いことがある。その場合は作成時刻で代用する。
    run_started_at: run.run_started_at ?? run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
  };

  return {
    id: raw.id,
    headSha: raw.head_sha,
    status: raw.status,
    conclusion: raw.conclusion,
    runStartedAt: raw.run_started_at,
    completedAt: raw.updated_at,
    workflowName: raw.name,
    workflowPath: raw.path,
    htmlUrl: raw.html_url,
    raw,
  };
}

/**
 * デプロイとみなす実行か。**`conclusion` が `success` の実行だけ**を数える。
 *
 * 失敗・キャンセル・スキップ・未完了（`conclusion` が null）は本番に変更が反映された
 * 出来事ではないため、1 件も数えない（CONTEXT.md「デプロイ」/ #14 完了条件）。
 */
export function isDeployRun(run: ProjectedWorkflowRun): boolean {
  return run.conclusion === "success";
}

/** 成功実行を 1 デプロイに変換する。 */
export function toDeployment(
  scopeId: string,
  workflow: string,
  run: ProjectedWorkflowRun,
): Deployment {
  return {
    scopeId,
    detectionRule: workflowRunRuleKey(workflow),
    // デプロイ時刻は実行の完了時刻、対応する commit SHA は実行の head SHA（#14）。
    commitSha: run.headSha,
    deployedAt: run.completedAt,
    raw: run.raw,
  };
}

/** `workflow_run` ルールが設定されているスコープ。ルールの判定は呼び出し元（#11）が済ませる。 */
export type WorkflowRunScope = Pick<Scope, "id" | "owner" | "repo"> & {
  deployRule: Extract<DeployRule, { name: "workflow_run" }>;
};

/**
 * 収集する時間窓。`collector` の `CollectionWindow` と同じ形を構造的に受け取る（#12）。
 * 省略時はワークフローの全実行を対象にする。
 */
export type WorkflowRunCollectionParams = {
  since?: string;
  until?: string;
  /** 対象ブランチを絞る場合のみ。既定は絞らない（どのブランチの CD かはワークフロー側の問題）。 */
  branch?: string;
};

export type WorkflowRunCollectionResult = {
  /** 走査した実行の件数（成功以外も含む）。 */
  examined: number;
  /** デプロイとして保存した実行。並び順は GitHub の返却順のまま。 */
  deployments: Deployment[];
};

/**
 * 対象ワークフローの実行履歴を取り、成功実行を `deploy_events` に upsert する。
 *
 * `client` を引数で受け取るのは、テストからフェイクに差し替えられるようにするためである。
 * Actions の実行日時は過去日付で作れないので、このルールは合成履歴では検証できず、
 * 実地確認はサンプルリポジトリ（#22 / #23）の本物の CD を待つしかない（#14 の注意点）。
 *
 * `status` は `completed` に絞って取得するが、**デプロイか否かの判定は `isDeployRun` に
 * 一本化してある**。GitHub 側のフィルタは取得量を減らすための最適化にすぎず、
 * 「何をデプロイとみなすか」の定義をサーバのクエリパラメータに預けない。
 */
export async function collectWorkflowRunDeployments(
  db: Db,
  client: GitHubClient,
  scope: WorkflowRunScope,
  params: WorkflowRunCollectionParams = {},
): Promise<WorkflowRunCollectionResult> {
  const workflow = scope.deployRule.workflow;
  const result: WorkflowRunCollectionResult = { examined: 0, deployments: [] };

  const runs = client.listWorkflowRuns(
    { owner: scope.owner, repo: scope.repo },
    {
      workflow,
      branch: params.branch,
      status: "completed",
      created: createdQuery(params.since, params.until),
    },
  );

  for await (const raw of runs) {
    const run = projectWorkflowRun(raw);
    result.examined += 1;
    if (!isDeployRun(run)) {
      continue;
    }
    const deployment = toDeployment(scope.id, workflow, run);
    saveDeployment(db, deployment);
    result.deployments.push(deployment);
  }

  logger.info("workflow_run ルールでデプロイを検出した", {
    scopeId: scope.id,
    workflow,
    detectionRule: workflowRunRuleKey(workflow),
    examined: result.examined,
    deployments: result.deployments.length,
  });

  return result;
}

/**
 * 時間窓を GitHub の検索構文（`created` パラメータ）に変換する。
 * 窓が無ければ `undefined` を返し、絞り込みそのものを送らない。
 */
function createdQuery(since: string | undefined, until: string | undefined): string | undefined {
  if (since !== undefined && until !== undefined) {
    return `${since}..${until}`;
  }
  if (since !== undefined) {
    return `>=${since}`;
  }
  if (until !== undefined) {
    return `<=${until}`;
  }
  return undefined;
}
