/**
 * コミットのデプロイへの割り当て（#15 / ADR-0004）。
 *
 * 変更のリードタイムは **1 サンプル = 1 コミット**で、対象は**デプロイ間の差分コミット集合**。
 * その差分は GitHub の compare API (`GET /repos/{owner}/{repo}/compare/{base}...{head}`) で
 * グラフ正確に取る。結果は ADR-0002 の導出③（外部 API を再取得しないと復元できない導出）
 * として `compare_cache` に保存する。
 *
 * ## 時刻順近似は実装しない（却下済み・ADR-0004）
 *
 * 「前回デプロイ時刻 〜 今回デプロイ時刻」の窓に committer date でコミットを割り当てる近似は
 * **採らない**。3 週間前に作られた feature branch が今日 merge された場合、そのコミットの
 * committer date は窓に入らず集計から丸ごと消える。つまりリードタイムが最も長かった
 * コミット＝最も会話の価値があるデータをシステマティックに削り落とし、指標が逆向きに嘘をつく
 * （放置された PR ほど数値に現れない）。ここが時刻で絞らず compare の返す SHA 集合を
 * そのまま使うのは、この壊れ方を構造的に起こせなくするためである。
 *
 * ## デプロイ検出ルールが変わったらキャッシュを破棄する（実装上の不変条件）
 *
 * デプロイはルールに対して相対的（`CONTEXT.md`）なので、ルールが変われば差分の base / head も
 * 変わる。古いルールで作った差分が残ったまま集計すると、「この数値がどう計算されたか辿れる」
 * （`README.md` 柱 4）が嘘になる。
 *
 * これを規約ではなく**型で守る**。`compare_cache` を読む関数はすべて `RuleCheckedScope` を
 * 要求し、その値は `checkRule()` でしか作れない。`checkRule()` は必ず
 * `discardDerivedData()`（= ルール変更の検知と破棄）を通る。したがって
 * 「ルール変更を検知していない経路から compare_cache を読む」コードは**コンパイルが通らない**。
 */

import type { Db } from "../db/index.ts";
import {
  type Deployment,
  discardDerivedData,
  findCompareCache,
  listDeployments,
  saveCompareCache,
} from "../db/store.ts";
import type { GitHubClient, Repo } from "../github/client.ts";
import type { ProjectedCompare } from "../github/project.ts";
import { logger } from "../logger.ts";

/**
 * 「ルール変更の検知（と古い導出の破棄）を通過した」ことを表す印。
 * 外から構築できないよう、識別子は非公開の unique symbol にしてある。
 */
declare const ruleChecked: unique symbol;

export type RuleCheckedScope = {
  readonly scopeId: string;
  /** `deploy_events.detection_rule` に入るのと同じルールキー。 */
  readonly detectionRule: string;
  readonly [ruleChecked]: true;
};

/**
 * 割り当ての唯一の入口。ここで古いルールの導出を破棄してから印を返す。
 *
 * ルールキーの作り方（`default_branch` の粒度や `workflow_run` のワークフロー名を
 * どう文字列にするか）はデプロイ検出ルール側（#13 / #14）の担当なので、ここでは決めない。
 * 保存時と同じ文字列を呼び出し元から受け取る。
 */
function checkRule(db: Db, scopeId: string, detectionRule: string): RuleCheckedScope {
  discardDerivedData(db, scopeId, detectionRule);
  return { scopeId, detectionRule } as RuleCheckedScope;
}

/**
 * `compare_cache` に触れてよい唯一の経路（読み）。
 *
 * `findCompareCache` をここ以外から呼ばない。引数に `RuleCheckedScope` を要求しているので、
 * `checkRule()`（= ルール変更の検知と破棄）を通らないコードはこの関数を呼べない。
 */
function readCompareCache(
  db: Db,
  scope: RuleCheckedScope,
  baseSha: string,
  headSha: string,
): { commitShas: string[]; truncated: boolean } | undefined {
  return findCompareCache(db, {
    scopeId: scope.scopeId,
    detectionRule: scope.detectionRule,
    baseSha,
    headSha,
  });
}

/** 同じく、書きの唯一の経路。ルールキーを取り違えた行を作れないようにする。 */
function writeCompareCache(
  db: Db,
  scope: RuleCheckedScope,
  baseSha: string,
  headSha: string,
  compare: ProjectedCompare,
): void {
  saveCompareCache(db, {
    scopeId: scope.scopeId,
    detectionRule: scope.detectionRule,
    baseSha,
    headSha,
    commitShas: compare.commitShas,
    truncated: compare.truncated,
  });
}

/**
 * compare の取得状況。**「コミット 0 件」を 3 つの意味に使い分けない**ための区別（#15）。
 *
 * - `assigned` — compare 済み。`commitShas` が実際の差分（本当に 0 件のこともある）
 * - `oldest` — 最古のデプロイ。1 つ前のデプロイが無く base を決められないので割り当てない
 * - `pending` — まだ compare していない（同期前、あるいはレート制限などで中断した）
 *
 * 集計側（#18）は `assigned` 以外を**標本に含めてはならない**。
 */
export type AssignmentStatus = "assigned" | "oldest" | "pending";

/** デプロイ 1 件と、そのデプロイに含まれるコミット SHA 集合。 */
export type DeploymentCommits = {
  /** デプロイ時刻（ADR-0001）。リードタイムの終点。 */
  deployedAt: string;
  /** デプロイの commit SHA。compare の head。 */
  headSha: string;
  /** 1 つ前のデプロイの commit SHA。compare の base。最古のデプロイでは null。 */
  baseSha: string | null;
  status: AssignmentStatus;
  /** `status === "assigned"` のときだけ意味を持つ。 */
  commitShas: string[];
  /**
   * compare を最後まで取れなかった。立っていたらその差分は欠けている。
   * ページングを実装した今、通常は立たない（`github/client.ts` の `compare`）。
   */
  truncated: boolean;
};

export type AssignCommitsOptions = {
  db: Db;
  /** compare だけ使う。テストはフェイクを渡してネットワークに出ない。 */
  client: Pick<GitHubClient, "compare">;
  repo: Repo;
  scopeId: string;
  /** 現在のデプロイ検出ルールのキー。保存時と同じ文字列。 */
  detectionRule: string;
};

/**
 * 連続する 2 デプロイごとに compare を取り、`compare_cache` を埋める。
 *
 * **キャッシュがあれば API を叩かない。** 1 年分のバックフィルでデプロイが数百件あっても、
 * 2 周目以降の compare 呼び出しは新しく増えたデプロイの分だけになる。
 *
 * 例外（レート制限・権限エラー）は握り潰さずそのまま投げる。分類と失敗分離は
 * `collector/per-scope.ts` の担当で、ここで捕まえると区別が消える。途中まで埋めた
 * キャッシュは残るので、次の収集サイクルは続きから進む。
 */
export async function assignCommitsToDeployments(
  options: AssignCommitsOptions,
): Promise<DeploymentCommits[]> {
  const { db, client, repo, scopeId, detectionRule } = options;
  const scope = checkRule(db, scopeId, detectionRule);
  const deployments = listDeployments(db, scope.scopeId, scope.detectionRule);

  const assigned: DeploymentCommits[] = [];
  for (const [index, deployment] of deployments.entries()) {
    const previous = deployments[index - 1];
    if (previous === undefined) {
      assigned.push(oldestDeployment(deployment));
      continue;
    }

    const baseSha = previous.commitSha;
    const headSha = deployment.commitSha;

    const cached = readCompareCache(db, scope, baseSha, headSha);
    if (cached !== undefined) {
      assigned.push({
        deployedAt: deployment.deployedAt,
        headSha,
        baseSha,
        status: "assigned",
        commitShas: cached.commitShas,
        truncated: cached.truncated,
      });
      continue;
    }

    const compare = await client.compare(repo, baseSha, headSha);
    if (compare.truncated) {
      // 取りこぼしは集計を黙って歪めるので、必ず痕跡を残す（#15 / ADR-0004）。
      logger.warn("compare を最後まで取得できなかった（差分コミットが欠けている）", {
        scopeId: scope.scopeId,
        detectionRule: scope.detectionRule,
        baseSha,
        headSha,
        fetched: compare.commitShas.length,
        totalCommits: compare.totalCommits,
      });
    }
    writeCompareCache(db, scope, baseSha, headSha, compare);
    assigned.push({
      deployedAt: deployment.deployedAt,
      headSha,
      baseSha,
      status: "assigned",
      commitShas: compare.commitShas,
      truncated: compare.truncated,
    });
  }

  return assigned;
}

/**
 * 集計側（#18 リードタイム）が使う参照 API。
 * あるスコープ・ルールについて「デプロイ → そのデプロイに含まれるコミット SHA 集合」を返す。
 *
 * **DB だけを見る。** 外部 API は叩かず、未取得の差分は `pending` として返す（勝手に
 * 取りに行くと、集計の 1 クエリが GitHub のレート制限に触れて画面が落ちる）。
 * 入口は `assignCommitsToDeployments` と同じ `checkRule` なので、
 * ルールが変わっていれば古い `compare_cache` はここでも破棄され、`pending` になる。
 */
export function listDeploymentCommits(
  db: Db,
  scopeId: string,
  detectionRule: string,
): DeploymentCommits[] {
  const scope = checkRule(db, scopeId, detectionRule);
  const deployments = listDeployments(db, scope.scopeId, scope.detectionRule);

  return deployments.map((deployment, index) => {
    const previous = deployments[index - 1];
    if (previous === undefined) {
      return oldestDeployment(deployment);
    }
    const cached = readCompareCache(db, scope, previous.commitSha, deployment.commitSha);
    return {
      deployedAt: deployment.deployedAt,
      headSha: deployment.commitSha,
      baseSha: previous.commitSha,
      status: cached === undefined ? "pending" : "assigned",
      commitShas: cached?.commitShas ?? [],
      truncated: cached?.truncated ?? false,
    };
  });
}

/**
 * 最古のデプロイには**コミットを割り当てない**（#15 の設計判断）。
 *
 * 1 つ前のデプロイが無いため compare の base が決まらない。代替は 2 つ考えられるが、
 * どちらも採らない。
 *
 * - **リポジトリの最初のコミットを base にする**: バックフィル範囲（既定 1 年）の外の
 *   コミットまで 1 回のデプロイに流れ込み、リードタイム数年のサンプルが先頭に立つ。
 *   実際には「その前のデプロイで出ていた」だけなので、指標が嘘をつく。
 * - **時刻の窓で拾う**: ADR-0004 が退けた時刻順近似そのもの。採らない。
 *
 * ただし**黙って 0 件にはしない**。`status: "oldest"` を立て、集計側（#18）が
 * 「差分 0 件のデプロイ」と「割り当て不能なデプロイ」を区別できるようにする。
 * デプロイ頻度には数えられ、リードタイムの標本にだけ入らない、という扱いになる。
 */
function oldestDeployment(deployment: Deployment): DeploymentCommits {
  return {
    deployedAt: deployment.deployedAt,
    headSha: deployment.commitSha,
    baseSha: null,
    status: "oldest",
    commitShas: [],
    truncated: false,
  };
}
