/**
 * 記録した GitHub API レスポンス（fixture）から、指標計算の入力（`MetricsInput`）を組み立てる。
 *
 * ADR-0004 の「指標計算を純粋関数に切り出し、記録した API レスポンスでユニットテストする」の
 * **記録側**がここ。取得して書き出すのは `record-fixtures.ts`（薄い I/O だけ）で、
 * 形の定義・サニタイズ・組み立てというロジックはすべてこちらに置く。そうしないと
 * ネットワークに出ないと検証できないコードが増える。
 *
 * ## 射影を再発明しない
 *
 * レスポンスから項目を取り出すのは `github/project.ts` の射影関数だけの仕事
 * （`docs/raw-columns.md` が「線引きの唯一の場所」と書いている）。ここはその出力を
 * 指標の標本へ詰め替えるだけで、`response.commit.committer.date` のような
 * レスポンス構造への参照を持たない。2 箇所で取り出すと、収集経路と指標経路で
 * 別の項目を見ている状態が起こりうる。
 *
 * ## デプロイの検出はここでしない
 *
 * 何をデプロイとみなすかは**デプロイ検出ルール**（#13 / #14）の担当。fixture 側は
 * 「どのコミットをデプロイとみなすか」を SHA の列として与えるだけにする。
 * ここで検出を真似ると、検出ルールの実装が 2 つになる。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectCommit, projectCompare, projectPullRequest } from "../github/project.ts";
import type {
  CollectionCoverage,
  CommitSample,
  DeployCommitAssignment,
  DeploymentSample,
  MetricsInput,
  PullRequestSample,
} from "./types.ts";
import { type Period, parseInstant } from "./week.ts";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

/** 記録の既定ファイル名（`record-fixtures.ts` が書き出す先）。 */
export const RECORDED_RESPONSES_NAME = "recorded-responses";

/** 記録した compare 1 回分。どの 2 デプロイ間の差分かが分かるよう SHA を添える。 */
export type RecordedCompare = {
  baseSha: string;
  headSha: string;
  /** `GET /repos/{owner}/{repo}/compare/{base}...{head}` のレスポンス（サニタイズ済み）。 */
  response: unknown;
};

/**
 * `__fixtures__/*.json` の形。**記録した生レスポンスだけ**を持つ。
 *
 * スコープ・検出ルール・収集カバレッジといった「人が決める前提」は入れない。
 * それらは `MetricsInputSpec` として TypeScript 側に書く。前提を JSON に混ぜると、
 * 記録し直すたびに人が書いた前提が消える。
 */
export type RecordedResponses = {
  /** 記録した時刻。fixture がいつの API 仕様かを示す。 */
  recordedAt: string;
  repo: { owner: string; repo: string };
  /** 由来のメモ。手で組み立てた場合にそれを隠さないために持つ。 */
  note?: string;
  /** `GET /repos/{owner}/{repo}/commits` のレスポンス要素。 */
  commits: unknown[];
  /** `GET /repos/{owner}/{repo}/pulls` のレスポンス要素。 */
  pullRequests: unknown[];
  compares: RecordedCompare[];
};

export function readRecordedResponses(name: string = RECORDED_RESPONSES_NAME): RecordedResponses {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")) as RecordedResponses;
}

/**
 * 記録したレスポンスに、指標計算が必要とする前提を足したもの。
 *
 * `MetricsInput` を直接手で書かずこの形を挟むのは、デプロイ時刻を
 * **コミットの committer date から引く**（ADR-0001）という規則を 1 箇所に閉じるため。
 * 手書きの `MetricsInput` では、デプロイ時刻とコミット時刻が食い違った fixture を作れてしまう。
 */
export type MetricsInputSpec = {
  responses: RecordedResponses;
  scopeId: string;
  /** 例 `default_branch:merge_only`。`db/store.ts` の `detection_rule` と同じ書式。 */
  detectionRule: string;
  /** デプロイとみなすコミットの SHA。検出自体は #13 / #14 の担当（上のコメント参照）。 */
  deployShas: readonly string[];
  coverage: CollectionCoverage;
  /** 省略すると、記録された標本の全体を覆う期間を使う。 */
  period?: Period;
};

export function buildMetricsInput(spec: MetricsInputSpec): MetricsInput {
  const commits: CommitSample[] = spec.responses.commits.map((response) => {
    const projected = projectCommit(response);
    return { sha: projected.sha, committedAt: projected.committedAt };
  });

  const committedAtBySha = new Map(commits.map((commit) => [commit.sha, commit.committedAt]));

  const deployments: DeploymentSample[] = spec.deployShas
    .map((sha) => {
      const committedAt = committedAtBySha.get(sha);
      if (committedAt === undefined) {
        // デプロイ時刻は対象コミットの committer date から引く（ADR-0001）。
        // 元のコミットが記録に無いと時刻を作れない。捏造せず落とす。
        throw new Error(
          `デプロイとみなす SHA ${sha} が記録したコミットに含まれていません（fixture の作り間違い）`,
        );
      }
      return { commitSha: sha, deployedAt: committedAt, detectionRule: spec.detectionRule };
    })
    .sort((left, right) => parseInstant(left.deployedAt) - parseInstant(right.deployedAt));

  const pullRequests: PullRequestSample[] = spec.responses.pullRequests.map((response) => {
    const projected = projectPullRequest(response);
    return {
      number: projected.number,
      createdAt: projected.createdAt,
      mergedAt: projected.mergedAt,
      mergeCommitSha: projected.mergeCommitSha,
      headSha: projected.headSha,
    };
  });

  const deployCommits: DeployCommitAssignment[] = spec.responses.compares.map((compare) => {
    const projected = projectCompare(compare.response);
    return {
      deploymentCommitSha: compare.headSha,
      baseSha: compare.baseSha,
      commitShas: projected.commitShas,
      truncated: projected.truncated,
    };
  });

  return {
    scopeId: spec.scopeId,
    detectionRule: spec.detectionRule,
    period: spec.period ?? coveringPeriod([...commits.map((commit) => commit.committedAt)]),
    deployments,
    commits,
    pullRequests,
    deployCommits,
    coverage: spec.coverage,
  };
}

/**
 * リポジトリに記録済みの fixture から組み立てた入力。
 *
 * #17 / #18 はこれを「**本物の API レスポンス由来の入力**」として使える。
 * 境界条件は `__fixtures__/scenarios.ts` の方で作る（こちらは記録した数時間分しかない）。
 *
 * ここに書いてある前提の根拠:
 * - 検出ルールは `default_branch:all_pushes`。記録した 3 コミットには通常コミットが
 *   含まれており、`merge_only` だとそれがデプロイにならず compare の相手が居なくなる
 * - デプロイ時刻は各コミットの committer date から引かれる（ADR-0001）
 * - カバレッジは「記録した瞬間に収集が成功した」状態。週の途中なので `partial` になる
 */
export function recordedMetricsInput(): MetricsInput {
  const responses = readRecordedResponses();
  return buildMetricsInput({
    responses,
    scopeId: "four-keys-metrics-viewer",
    detectionRule: "default_branch:all_pushes",
    deployShas: responses.commits.map((response) => projectCommit(response).sha),
    coverage: {
      // 2026-09-14 週（JST 月曜 00:00 = 2026-09-13T15:00:00Z）の頭まで遡った状態。
      backfilledUntil: "2026-09-13T15:00:00.000Z",
      backfillComplete: false,
      lastSuccessAt: responses.recordedAt,
    },
  });
}

/** 記録した標本の全体を覆う期間。`period` を省略したときの既定。 */
function coveringPeriod(instants: string[]): Period {
  const first = instants[0];
  if (first === undefined) {
    throw new Error("標本が 1 件も無いため集計期間を決められません（period を明示してください）");
  }
  let fromMs = parseInstant(first);
  let toMs = fromMs;
  for (const instant of instants) {
    const ms = parseInstant(instant);
    fromMs = Math.min(fromMs, ms);
    toMs = Math.max(toMs, ms);
  }
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

/* ------------------------------------------------------------------------- *
 * サニタイズ
 *
 * `docs/raw-columns.md`: 「`user` / `author` / `committer` / `merged_by` の
 * ユーザー情報を保存しない。個人単位の集計を構造的に不可能にする」。
 * **保存しないものは記録もしない。** fixture はリポジトリに恒久的に残るため、
 * ここを通さずに記録すると、DB には入らない個人情報が git 履歴に焼き付く。
 *
 * 落とすのは個人情報だけで、それ以外の項目は残す。射影（`project.ts`）が
 * 「使わない項目を捨てられているか」をテストできるのは、fixture に余分が残っているからである。
 * ------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

/** コミット（`GET /commits` の要素、compare 内のコミットも同じ形）。 */
export function sanitizeCommitResponse(response: unknown): unknown {
  // author / committer はユーザーオブジェクト（login, avatar_url, ...）。丸ごと落とす。
  const { author: _author, committer: _committer, commit, ...rest } = response as Json;
  return { ...rest, commit: sanitizeCommitDetail(commit) };
}

function sanitizeCommitDetail(detail: unknown): unknown {
  // commit.author / commit.committer は {name, email, date}。**date だけ残す**
  // （リードタイムの起点とデプロイ時刻に要る。氏名とメールは要らない）。
  // verification は payload と signature に氏名とメールがそのまま入るため落とす。
  const {
    author,
    committer,
    verification: _verification,
    ...rest
  } = detail as Json & {
    author: { date: string };
    committer: { date: string };
  };
  return { ...rest, author: { date: author.date }, committer: { date: committer.date } };
}

/** PR（`GET /pulls` の要素）。 */
export function sanitizePullRequestResponse(response: unknown): unknown {
  const {
    user: _user,
    merged_by: _mergedBy,
    assignee: _assignee,
    assignees: _assignees,
    requested_reviewers: _requestedReviewers,
    requested_teams: _requestedTeams,
    // auto_merge は enabled_by にユーザーオブジェクトを抱える。
    auto_merge: _autoMerge,
    head,
    base,
    ...rest
  } = response as Json;
  return { ...rest, head: sanitizePullRequestRef(head), base: sanitizePullRequestRef(base) };
}

function sanitizePullRequestRef(ref: unknown): unknown {
  // head / base は user と repo（repo.owner がユーザーオブジェクト）を抱える。
  // 射影が使うのは sha と ref だけ（docs/raw-columns.md）。
  const { label, ref: refName, sha } = ref as Json;
  return { label, ref: refName, sha };
}

/** compare（`GET /compare/{base}...{head}`）。 */
export function sanitizeCompareResponse(response: unknown): unknown {
  const {
    base_commit: baseCommit,
    merge_base_commit: mergeBaseCommit,
    commits,
    // files は本アプリが一切使わず（docs/raw-columns.md）、ペイロードの約 8 割を占める。
    // patch 本文をリポジトリに焼き込む意味も無いので記録しない。
    files: _files,
    ...rest
  } = response as Json;
  return {
    ...rest,
    base_commit: sanitizeCommitResponse(baseCommit),
    merge_base_commit: sanitizeCommitResponse(mergeBaseCommit),
    commits: (commits as unknown[]).map(sanitizeCommitResponse),
  };
}
