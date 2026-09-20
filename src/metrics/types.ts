/**
 * 指標計算の入力型（#16 / ADR-0004）。
 *
 * ADR-0004 は「指標計算を**純粋関数に切り出し**、記録した GitHub API レスポンス（fixture）で
 * ユニットテストする」と決めた。**この型がその切り出し線である。**
 *
 * デプロイ頻度（#17）も変更のリードタイム（#18）も、受け取るのは `MetricsInput` 1 つだけで、
 * `better-sqlite3` も `fetch` も import しない。DB から読む処理（#19 以降）は
 * 「ストアの行をこの型へ詰め替える」だけの薄い層になる。
 *
 * ## 型の粒度について
 *
 * ストアの行（`db/store.ts`）をそのまま使わず、指標が使う項目だけの「標本」として定義し直す。
 * `raw` や `scopeId` を引きずると、指標計算が「DB から来た形」に縛られ、
 * fixture から組み立てた入力（`fixtures.ts`）と形が揃わなくなる。
 */

import type { Period } from "./week.ts";

/** 指標計算に渡す入力一式。**これ以外の入力を指標計算に与えない。** */
export type MetricsInput = {
  /** どのスコープの数値か（CONTEXT.md のスコープ）。複数スコープを混ぜないための印。 */
  scopeId: string;
  /**
   * どのデプロイ検出ルールで検出したデプロイを見ているか（例 `default_branch:merge_only`）。
   * **デプロイは検出ルールに対して相対的**（CONTEXT.md）なので、数値と対で持ち回る。
   * 画面の「この数値がどう計算されたか」（柱 4）にそのまま出す。
   */
  detectionRule: string;
  /**
   * 集計の対象期間。**週の並びは生イベントではなくここから作る**（`weeksBetween`）。
   * デプロイ 0 件の週は生イベント側には現れないため、期間が無いと 0 件の週を表現できない（#17）。
   */
  period: Period;
  /** デプロイの標本。週あたり回数（#17）とリードタイムの終点（#18）の両方がこれを使う。 */
  deployments: readonly DeploymentSample[];
  /** コミットの標本。リードタイムの起点（#18）。 */
  commits: readonly CommitSample[];
  /** PR の標本。3 区間内訳（#18）にだけ使う。 */
  pullRequests: readonly PullRequestSample[];
  /** デプロイ → そのデプロイに含まれるコミット集合（#15 の compare 結果）。 */
  deployCommits: readonly DeployCommitAssignment[];
  /** 収集がどこまでカバーしているか。「0 件」と「データなし」を分けるために要る（#17）。 */
  coverage: CollectionCoverage;
};

/** デプロイ 1 回分の標本。 */
export type DeploymentSample = {
  /**
   * デプロイ時刻（ISO8601 / UTC 保存）。**PR の `merged_at` ではなく committer date**
   * （ADR-0001）。週バケットへの割り当てと、デプロイ間隔（#17）の計算に使う。
   */
  deployedAt: string;
  /**
   * 対応する commit SHA。`deployCommits` との結合キーであり、
   * ドリルダウン（柱 4）で「どのコミットがこのデプロイか」を示すのにも使う。
   */
  commitSha: string;
  /**
   * どの検出ルールで検出したか。`MetricsInput.detectionRule` と一致している前提だが、
   * ルール変更時の破棄漏れ（ADR-0002）が指標側に混ざったことを検出できるよう標本にも持たせる。
   */
  detectionRule: string;
};

/** コミット 1 件分の標本。**リードタイムは 1 サンプル = 1 コミット**（ADR-0004）。 */
export type CommitSample = {
  /** `deployCommits.commitShas` との結合キー。 */
  sha: string;
  /**
   * committer date（ISO8601）。**リードタイムの起点**。
   * author date は rebase / cherry-pick でずれるため持たない（ADR-0004）。
   */
  committedAt: string;
};

/**
 * PR 1 件分の標本。
 *
 * **リードタイムの標本単位は PR ではなくコミット**（ADR-0004）。PR がここに居るのは
 * 3 区間内訳「コミット → PR open」「PR open → merge」「merge → デプロイ」（#18）の
 * 区切り時刻を与えるため**だけ**である。
 */
export type PullRequestSample = {
  /** ドリルダウン表示（柱 4）と、内訳がどの PR 由来かの提示に使う。 */
  number: number;
  /** 「コミット → PR open」の終点、「PR open → merge」の起点。 */
  createdAt: string;
  /**
   * 「PR open → merge」の終点。**デプロイ時刻には使わない**（ADR-0001）。
   * 未マージの PR は `null`。
   */
  mergedAt: string | null;
  /**
   * マージコミットの SHA。コミットをどの PR に対応付けるかの手掛かり。
   * 未マージなら `null`。**PR を経由しない直接 push のコミットはどの PR にも当たらず、
   * 内訳なしとして扱う**（#18）。
   */
  mergeCommitSha: string | null;
  /** PR の先頭コミット。マージコミット以外のコミットを PR に結び付けるのに使う。 */
  headSha: string;
};

/**
 * 1 デプロイに含まれるコミット集合の割り当て。
 *
 * 実体は #15 が作る compare API の結果（`compare_cache`）。**時刻順近似は採らない**
 * （ADR-0004。3 週間放置された branch のコミットが集計から丸ごと消えるため）。
 * ここを「入力として受け取る」形にしてあるので、指標計算は #15 の実装に依存しない。
 */
export type DeployCommitAssignment = {
  /** どのデプロイの分か。`DeploymentSample.commitSha` と一致する（compare の head）。 */
  deploymentCommitSha: string;
  /** 直前のデプロイの commit SHA（compare の base）。差分範囲の下端。 */
  baseSha: string;
  /** このデプロイに含まれるコミットの SHA 集合。 */
  commitShas: readonly string[];
  /**
   * compare API が 250 件で打ち切られたか。**打ち切られた週のリードタイムは
   * 標本が黙って欠けている**ので、指標側は値を出すかどうかを判断できる必要がある。
   */
  truncated: boolean;
};

/**
 * 収集カバレッジ。**「収集済みで 0 件」と「収集がまだ届いていない」を分けるための入力**（#17）。
 *
 * 中身は `collection_cursors`（CONTEXT.md の収集カーソル）の写しだが、指標側は
 * 「どこまで遡ったか」ではなく「この週を数えてよいか」しか知りたくないため、
 * 判定は `coverage.ts` の関数に閉じる。
 */
export type CollectionCoverage = {
  /**
   * `collection_cursors.backfilled_until`。**収集済み範囲の古い端**。
   * `null` は未着手（＝どの週もカバーしていない）。
   */
  backfilledUntil: string | null;
  /**
   * `collection_cursors.backfill_complete`。バックフィル範囲の端まで遡り終えたか。
   * カバー範囲は広げない（遡っていない過去は依然としてデータが無い）が、
   * 画面で「これ以上は収集対象外」と「まだ収集していない」を言い分けるのに要る（#20）。
   */
  backfillComplete: boolean;
  /**
   * `collection_cursors.last_success_at`。**収集済み範囲の新しい端**。
   * 常時稼働しない構成（ADR-0007）では、ここから現在までが素で欠ける。
   * `null` は「最新を追う収集が一度も成功していない」。
   */
  lastSuccessAt: string | null;
};
