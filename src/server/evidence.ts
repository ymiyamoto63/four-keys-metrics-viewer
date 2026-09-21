/**
 * 指標詳細（#21）の**根拠イベント**を、選択した 1 週ぶんだけ組み立てる層。
 *
 * ## なぜこの層が要るのか
 *
 * `README.md` 柱 4「算出ロジックを開示する」を UI で果たすのがこの画面で、その中心が
 * 「その週の数値がどの出来事から出たのか」を 1 件ずつ辿れることである。ところが
 * `MetricsInput`（`metrics/types.ts`）は**指標が使う項目だけの標本**に絞ってあり、
 * ドリルダウンに要る `html_url` / コミットメッセージ / PR タイトルを持たない。
 * ADR-0004 の切り出し線（指標計算は純粋関数）を守ったままこれらを拾うには、
 * 「指標の結果」と「ストアの行」をここで突き合わせるしかない。
 *
 * したがってこのファイルは**読み取りと突き合わせだけ**を行う。指標は一切再計算しない
 * （再計算すると画面のチャートと一覧が別々の計算経路を持つことになり、
 * 「この数値がどう計算されたか」がむしろ辿れなくなる）。
 *
 * ## 3 階層目は作らない（ADR-0003 決定 3）
 *
 * 各行のリンク先は **GitHub の該当ページ**であって、自前の個別イベント画面ではない。
 * ここが返すのは `githubUrl` が通した `https://github.com/` の URL だけで、
 * アプリ内の個別イベント URL を組み立てる関数はこのファイルに存在しない。
 */

import type { Db } from "../db/index.ts";
import { listCommits, listDeployments, listPullRequests } from "../db/store.ts";
import type { AssignmentStatus } from "../deploy/assignment.ts";
import { listDeploymentCommits } from "../deploy/assignment.ts";
import type { DeployFrequencyWeek } from "../metrics/deploy-frequency.ts";
import type { LeadTimeBreakdown, LeadTimeWeek } from "../metrics/lead-time.ts";
import { parseInstant } from "../metrics/week.ts";
import type { ScopeMetrics } from "./scope-metrics.ts";

/** GitHub のページだけを外部リンクとして通す接頭辞。 */
const GITHUB_ORIGIN = "https://github.com/";

/**
 * 根拠イベントのコミット 1 行。**リードタイムの標本 1 件と 1 対 1**（ADR-0004）。
 *
 * ここに出るコミットは「その週のデプロイに含まれたコミット」であって、
 * 「その週に書かれたコミット」ではない。リードタイムの週バケットは終点（デプロイ時刻）で
 * 決まる（#18）ので、一覧もその定義に合わせないと画面と数値が食い違う。
 */
export type CommitEvidence = {
  sha: string;
  /** 一覧で読める長さに詰めた SHA。リンクの文字列にだけ使う（同一性は `sha`）。 */
  shortSha: string;
  /** リードタイムの起点。committer date（ADR-0004）。 */
  committedAt: string;
  /** コミットメッセージの 1 行目。無ければ空文字。 */
  subject: string;
  /** GitHub のコミットページ。`commits.raw.html_url` が無ければ `null`。 */
  htmlUrl: string | null;
  /** 合計リードタイム（時間）。 */
  leadTimeHours: number;
  /**
   * 3 区間内訳。**`null` は 0 ではない**（#18）。画面は必ず `—` 等で 0 と区別して出す。
   */
  breakdown: LeadTimeBreakdown | null;
  /** 内訳が出せなかった理由。`breakdown` が `null` のときだけ意味を持つ。 */
  breakdownAbsence: BreakdownAbsence | null;
  /** 対応する PR。直接 push のコミットは `null`。 */
  pullRequest: PullRequestEvidence | null;
};

/**
 * 内訳が無い理由。**「0 時間」と読ませないために理由まで出す**（#21）。
 *
 * - `no-pull-request` — PR を経由しないコミット（直接 push）。「PR open」「merge」が存在しない
 * - `out-of-order` — PR の時刻が区間の順序と合わない。マージコミット自身がここに来る（#18）
 */
export type BreakdownAbsence = "no-pull-request" | "out-of-order";

export type PullRequestEvidence = {
  number: number;
  title: string;
  /** `pull_requests.html_url`（専用の列がある）。 */
  htmlUrl: string | null;
};

/**
 * 根拠イベントのデプロイ 1 行。**デプロイ頻度の 1 件と 1 対 1**（#17）。
 *
 * コミットをこの下にぶら下げるのは、「デプロイ頻度の 1 回」と
 * 「リードタイムの標本たち」が同じ出来事の表と裏だからである。2 つの平たい一覧に分けると、
 * どのコミットがどのデプロイで本番に出たのかが画面から消える。
 */
export type DeploymentEvidence = {
  /** デプロイの commit SHA（CONTEXT.md のデプロイ）。 */
  commitSha: string;
  shortSha: string;
  /** デプロイ時刻（ADR-0001）。 */
  deployedAt: string;
  /**
   * GitHub の該当ページ。`workflow_run` ルールではワークフロー実行、
   * `default_branch` ルールでは対象コミットのページ（デプロイ自体に URL が無いため）。
   */
  htmlUrl: string | null;
  /** そのリンクが何のページか。`workflow_run` と `default_branch` で行き先が違うので明示する。 */
  linkLabel: string;
  /** どう検出されたか（柱 4）。`deploy_events.raw` に入っている判定根拠を文にしたもの。 */
  detection: string;
  /** compare の状態（#15）。`assigned` 以外の週は標本が欠ける。 */
  assignment: AssignmentStatus;
  /** compare が打ち切られている（差分が欠けている）。 */
  truncated: boolean;
  /** このデプロイで本番に出たコミット（= リードタイムの標本）。 */
  commits: CommitEvidence[];
};

/** 選択した 1 週ぶんの根拠。 */
export type WeekEvidence = {
  week: string;
  startedAt: string;
  endedAt: string;
  deployFrequency: DeployFrequencyWeek;
  leadTime: LeadTimeWeek;
  /** その週のデプロイ、古い順。 */
  deployments: DeploymentEvidence[];
};

/**
 * 選択した週の根拠イベントを組み立てる。週が集計期間の外なら `undefined`。
 *
 * `undefined` を返して呼び出し側に 400 を出させるのは、空の一覧を返さないためである。
 * 本アプリの空白は「収集の穴」の可能性があり（ADR-0004 / ADR-0007）、
 * URL の誤りを空の一覧として見せると、その 2 つが画面上で混ざる（`views/notice-page.tsx`）。
 */
export function loadWeekEvidence(
  db: Db,
  metrics: ScopeMetrics,
  week: string,
): WeekEvidence | undefined {
  const leadTimeWeek = metrics.leadTime.weeks.find((candidate) => candidate.week === week);
  const deployFrequencyWeek = metrics.deployFrequency.weeks.find(
    (candidate) => candidate.week.key === week,
  );
  if (leadTimeWeek === undefined || deployFrequencyWeek === undefined) {
    return undefined;
  }

  const { scope, detectionRule } = metrics;
  const commitRows = new Map(
    listCommits(db, scope.id).map((commit) => [commit.sha, commit] as const),
  );
  const pullRequestRows = listPullRequests(db, scope.id);
  const findPullRequest = indexPullRequests(pullRequestRows);
  const assignmentByHeadSha = new Map(
    listDeploymentCommits(db, scope.id, detectionRule).map((entry) => [entry.headSha, entry]),
  );
  const samplesByDeployment = groupSamplesByDeployment(leadTimeWeek);

  const startedMs = parseInstant(leadTimeWeek.startedAt, "週の開始");
  const endedMs = parseInstant(leadTimeWeek.endedAt, "週の終了");

  const deployments: DeploymentEvidence[] = [];
  for (const deployment of listDeployments(db, scope.id, detectionRule)) {
    const deployedMs = parseInstant(deployment.deployedAt, "デプロイ時刻");
    // 週は半開区間 `[startedAt, endedAt)`（`metrics/week.ts`）。ここを閉区間にすると
    // 月曜 00:00 ちょうどのデプロイが隣の週の一覧にも現れ、チャートの回数と合わなくなる。
    if (deployedMs < startedMs || deployedMs >= endedMs) {
      continue;
    }
    const assignmentEntry = assignmentByHeadSha.get(deployment.commitSha);
    const deployCommit = commitRows.get(deployment.commitSha);
    deployments.push({
      commitSha: deployment.commitSha,
      shortSha: shortSha(deployment.commitSha),
      deployedAt: deployment.deployedAt,
      // `default_branch` ルールのデプロイは GitHub 上に固有のページを持たない。
      // 対象コミットのページへ送るのが最も近い「その出来事そのもの」である。
      htmlUrl: githubUrl(deployment.raw) ?? githubUrl(deployCommit?.raw),
      linkLabel: githubUrl(deployment.raw) === null ? "コミット" : "ワークフロー実行",
      detection: detectionSentence(deployment.raw, detectionRule),
      assignment: assignmentEntry?.status ?? "pending",
      truncated: assignmentEntry?.truncated ?? false,
      commits: (samplesByDeployment.get(deployment.commitSha) ?? []).map((sample) => {
        const pullRequest = findPullRequest(sample.commitSha);
        return {
          sha: sample.commitSha,
          shortSha: shortSha(sample.commitSha),
          committedAt: sample.committedAt,
          subject: subjectOf(commitRows.get(sample.commitSha)?.message),
          htmlUrl: githubUrl(commitRows.get(sample.commitSha)?.raw),
          leadTimeHours: sample.leadTimeHours,
          breakdown: sample.breakdown,
          breakdownAbsence:
            sample.breakdown !== null
              ? null
              : pullRequest === undefined
                ? "no-pull-request"
                : "out-of-order",
          pullRequest:
            pullRequest === undefined
              ? null
              : {
                  number: pullRequest.number,
                  title: pullRequest.title,
                  htmlUrl: externalGithubUrl(pullRequest.htmlUrl),
                },
        };
      }),
    });
  }

  return {
    week,
    startedAt: leadTimeWeek.startedAt,
    endedAt: leadTimeWeek.endedAt,
    deployFrequency: deployFrequencyWeek,
    leadTime: leadTimeWeek,
    deployments,
  };
}

/* --- 内部 ---------------------------------------------------------------- */

function groupSamplesByDeployment(
  week: LeadTimeWeek,
): Map<string, LeadTimeWeek["samples"][number][]> {
  const grouped = new Map<string, LeadTimeWeek["samples"][number][]>();
  for (const sample of week.samples) {
    const bucket = grouped.get(sample.deploymentCommitSha);
    if (bucket === undefined) {
      grouped.set(sample.deploymentCommitSha, [sample]);
      continue;
    }
    bucket.push(sample);
  }
  return grouped;
}

/**
 * `raw` から GitHub のページ URL を取り出す。
 *
 * **`https://github.com/` で始まるものしか通さない。** `raw` は外部（GitHub API）由来の
 * JSON をそのまま入れた列で、画面はその値を `href` に流す。接頭辞を確かめずに流すと、
 * 収集経路が差し替えられたときに `javascript:` 等がそのままリンクになる。
 * 値が取れなければ `null` を返し、画面はリンクではなく素のテキストとして出す。
 */
function githubUrl(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  return externalGithubUrl((raw as { html_url?: unknown }).html_url);
}

function externalGithubUrl(value: unknown): string | null {
  return typeof value === "string" && value.startsWith(GITHUB_ORIGIN) ? value : null;
}

/**
 * どう検出されたデプロイかを 1 文にする（柱 4）。
 *
 * 材料は `deploy_events.raw` の判定根拠（`docs/raw-columns.md`）。ルールごとに中身が違うので、
 * 読めなければルールキーだけを返す（黙って「マージコミット」と決め付けない）。
 */
function detectionSentence(raw: unknown, detectionRule: string): string {
  if (typeof raw !== "object" || raw === null) {
    return detectionRule;
  }
  const record = raw as { rule?: unknown; parent_count?: unknown; name?: unknown; path?: unknown };
  if (record.rule === "default_branch" && typeof record.parent_count === "number") {
    return record.parent_count >= 2
      ? `${detectionRule}（親 ${record.parent_count} 件のマージコミット）`
      : `${detectionRule}（親 ${record.parent_count} 件のコミット）`;
  }
  if (typeof record.name === "string") {
    return `${detectionRule}（ワークフロー ${record.name} の成功実行）`;
  }
  return detectionRule;
}

/**
 * コミット SHA → PR を引く。
 *
 * 手掛かりは `head_sha` と `merge_commit_sha` だけで、`metrics/lead-time.ts` の内部関数と
 * 同じ引き方をする。あちらを import したいところだが、内訳の区切り時刻を引くための
 * 内部関数であって公開されていない（`src/metrics/` は #21 の変更禁止領域でもある）。
 * **引き方がずれると、内訳を持つコミットなのに一覧に PR が出ない**という食い違いになるため、
 * 優先順（head を先に見る）まで含めて揃えてある。
 */
function indexPullRequests(
  pullRequests: readonly {
    number: number;
    title: string;
    htmlUrl: string;
    headSha: string;
    mergeCommitSha: string | null;
  }[],
): (sha: string) => (typeof pullRequests)[number] | undefined {
  const byHeadSha = new Map<string, (typeof pullRequests)[number]>();
  const byMergeCommitSha = new Map<string, (typeof pullRequests)[number]>();
  for (const pullRequest of pullRequests) {
    if (!byHeadSha.has(pullRequest.headSha)) {
      byHeadSha.set(pullRequest.headSha, pullRequest);
    }
    if (pullRequest.mergeCommitSha !== null && !byMergeCommitSha.has(pullRequest.mergeCommitSha)) {
      byMergeCommitSha.set(pullRequest.mergeCommitSha, pullRequest);
    }
  }
  return (sha) => byHeadSha.get(sha) ?? byMergeCommitSha.get(sha);
}

/** コミットメッセージの 1 行目。一覧の行に本文を流し込まないため。 */
function subjectOf(message: string | undefined): string {
  return (message ?? "").split("\n")[0] ?? "";
}

/** 表示用の短い SHA。**同一性の判断には使わない**（衝突しうる）。 */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
