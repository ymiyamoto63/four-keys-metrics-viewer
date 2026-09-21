/**
 * 根拠イベント一覧（#21）。**この画面の存在理由そのもの。**
 *
 * `README.md` 柱 4「算出ロジックを開示する」は、設定で定義を変えられることと、
 * **画面上で「この数値がどう計算されたか」を辿れること**の 2 つで果たされる。前者は
 * `scopes.toml`（ADR-0005）が担い、後者がここである。選んだ週に含まれたデプロイと
 * コミットを 1 件ずつ並べ、各行から GitHub の該当ページへ送る。
 *
 * ## 守っていること
 *
 * - **個別イベントの詳細画面を自前で作らない**（ADR-0003 決定 3）。このファイルに
 *   アプリ内リンクを組み立てる処理は無く、行のリンク先は `https://github.com/` だけ
 * - **3 区間内訳が無いコミットを 0 で埋めない**（#18）。`—` と理由を出す。0 と書くと
 *   「0 秒でレビューされた PR」が実在したように読める
 * - **標本から外したものを隠さない**（#18 / #17）。`excluded` と `coverage` を同じ画面に出す
 * - **個人を出さない**。`raw` にユーザー情報を保存していない（`docs/raw-columns.md`）ので、
 *   ここから個人単位の集計は作れない。`README.md` のアンチパターンをデータ構造で守っている
 */

import type { LeadTimeMetrics } from "../../metrics/lead-time.ts";
import type {
  BreakdownAbsence,
  CommitEvidence,
  DeploymentEvidence,
  WeekEvidence,
} from "../evidence.ts";
import { formatJst } from "../format.ts";

/** 内訳が無い理由の文言。**0 と読ませない**ための「—」つき（#18 / #21）。 */
const BREAKDOWN_ABSENCE_TEXT: Record<BreakdownAbsence, string> = {
  "no-pull-request": "— なし（PR を経由していないコミット）",
  "out-of-order": "— なし（PR の時刻が区間の順序と合わない。マージコミット等）",
};

export function EvidenceList({
  evidence,
  leadTime,
}: {
  evidence: WeekEvidence;
  leadTime: LeadTimeMetrics;
}) {
  return (
    <section data-testid="evidence-list">
      <h2>この週の根拠イベント</h2>
      <p class="fk-hint">
        上のチャートの {evidence.week} の週の値は、次のデプロイとコミットから計算しています。
        週の範囲は <time datetime={evidence.startedAt}>{formatJst(evidence.startedAt)}</time> 〜{" "}
        <time datetime={evidence.endedAt}>{formatJst(evidence.endedAt)}</time>
        （この終端は含みません）。 各行のリンク先は GitHub
        です。個別イベントの画面はこのアプリには作っていません（ADR-0003）。
      </p>

      {evidence.deployments.length === 0 ? (
        <p class="fk-notice" data-testid="evidence-empty">
          この週にはデプロイがありません。上の「収集状態」と「この週の空白について」を見ると、
          収集が届いていないのか、本当にデプロイが無かったのかが分かります。
        </p>
      ) : (
        <ol class="fk-evidence" data-testid="evidence-deployments">
          {evidence.deployments.map((deployment) => (
            <DeploymentRow key={deployment.commitSha} deployment={deployment} />
          ))}
        </ol>
      )}

      <ExclusionNote evidence={evidence} leadTime={leadTime} />
    </section>
  );
}

function DeploymentRow({ deployment }: { deployment: DeploymentEvidence }) {
  return (
    <li class="fk-evidence__deployment" data-testid="evidence-deployment">
      <h3>
        デプロイ <ExternalLink href={deployment.htmlUrl} label={`${deployment.shortSha}`} />{" "}
        <span class="fk-hint">（{deployment.linkLabel}のページへ）</span>
      </h3>
      <dl>
        <dt>デプロイ時刻</dt>
        <dd>
          <time datetime={deployment.deployedAt}>{formatJst(deployment.deployedAt)}</time>
        </dd>
        <dt>検出根拠</dt>
        <dd>
          <code>{deployment.detection}</code>
        </dd>
        <dt>含まれるコミット</dt>
        <dd data-testid="evidence-commit-count">{assignmentText(deployment)}</dd>
      </dl>

      {deployment.commits.length === 0 ? null : (
        <table class="fk-evidence__table">
          <thead>
            <tr>
              <th scope="col">コミット</th>
              <th scope="col">committer date（起点）</th>
              <th scope="col">リードタイム</th>
              <th scope="col">コミット → PR open</th>
              <th scope="col">PR open → merge</th>
              <th scope="col">merge → デプロイ</th>
              <th scope="col">PR</th>
            </tr>
          </thead>
          <tbody>
            {deployment.commits.map((commit) => (
              <CommitRow key={commit.sha} commit={commit} />
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

function CommitRow({ commit }: { commit: CommitEvidence }) {
  const absence =
    commit.breakdownAbsence === null ? null : BREAKDOWN_ABSENCE_TEXT[commit.breakdownAbsence];

  return (
    <tr data-testid="evidence-commit" data-commit-sha={commit.sha}>
      <td>
        <ExternalLink href={commit.htmlUrl} label={commit.shortSha} />
        <br />
        <span class="fk-hint">{commit.subject}</span>
      </td>
      <td>
        <time datetime={commit.committedAt}>{formatJst(commit.committedAt)}</time>
      </td>
      <td>{formatHours(commit.leadTimeHours)}</td>
      {commit.breakdown === null ? (
        // **0 で埋めない。** 3 列を 1 つにまとめ、理由まで書く（#18 / #21）。
        <td colspan={3} data-testid="breakdown-absent">
          {absence}
        </td>
      ) : (
        <>
          <td data-testid="breakdown-commit-to-pr-open">
            {formatHours(commit.breakdown.commitToPrOpen)}
          </td>
          <td data-testid="breakdown-pr-open-to-merge">
            {formatHours(commit.breakdown.prOpenToMerge)}
          </td>
          <td data-testid="breakdown-merge-to-deploy">
            {formatHours(commit.breakdown.mergeToDeploy)}
          </td>
        </>
      )}
      <td>
        {commit.pullRequest === null ? (
          "—"
        ) : (
          <ExternalLink
            href={commit.pullRequest.htmlUrl}
            label={`#${commit.pullRequest.number}`}
            title={commit.pullRequest.title}
          />
        )}
      </td>
    </tr>
  );
}

/**
 * 標本から外れたものの開示（#18 / #17）。**該当する週では必ず出す。**
 *
 * 「なぜこの週は値が出ないのか」に答えられる状態を保つのがこの節の役目で、
 * ADR-0004 の標本数ゲートと ADR-0007 の収集の穴のどちらなのかは、ここを見れば分かる。
 */
function ExclusionNote({
  evidence,
  leadTime,
}: {
  evidence: WeekEvidence;
  leadTime: LeadTimeMetrics;
}) {
  const { excluded } = evidence.leadTime;
  const orphan = leadTime.orphanAssignments;
  const truncated = excluded.truncatedDeployments;
  const unknown = excluded.unknownCommitShas;

  return (
    <section class="fk-notice" data-testid="exclusion-note">
      <h3>この週の空白について（標本から外したもの）</h3>
      <dl>
        <dt>収集カバレッジ</dt>
        <dd data-testid="exclusion-coverage">{coverageText(evidence)}</dd>
        <dt>リードタイムの標本数</dt>
        <dd data-testid="exclusion-sample-count">
          {evidence.leadTime.samples.length} 件
          {evidence.leadTime.summary === null
            ? `（代表値の下限 ${leadTime.minSamples} 件に届かないため、合計リードタイムの値は出していません。ADR-0004）`
            : "（代表値を出しています）"}
        </dd>
        <dt>3 区間内訳の標本数</dt>
        <dd data-testid="exclusion-breakdown-count">
          {evidence.leadTime.breakdown === null
            ? `${leadTime.minSamples} 件未満（内訳の値は出していません。内訳を持つのは PR に結び付いたコミットだけです）`
            : `${evidence.leadTime.breakdown.count} 件`}
        </dd>
        <dt>compare が打ち切られたデプロイ</dt>
        <dd data-testid="exclusion-truncated">
          {truncated.length === 0
            ? "なし"
            : `${truncated.length} 件（${truncated.join(" / ")}）。差分が欠けているため、このデプロイのコミットは 1 件も標本にしていません`}
        </dd>
        <dt>コミットが見つからない SHA</dt>
        <dd data-testid="exclusion-unknown">
          {unknown.length === 0
            ? "なし"
            : `${unknown.length} 件（${unknown.join(" / ")}）。起点（committer date）が取れないため標本にできていません。収集が届いていない範囲の可能性があります`}
        </dd>
        <dt>デプロイが見つからない割り当て</dt>
        <dd data-testid="exclusion-orphan">
          {orphan.length === 0
            ? "なし"
            : `${orphan.length} 件（${orphan.join(" / ")}）。デプロイ時刻が無くどの週にも載せられません。収集の取りこぼしの印です（期間全体の件数）`}
        </dd>
      </dl>
    </section>
  );
}

function coverageText(evidence: WeekEvidence): string {
  const { coverage, observedDeployCount, deployCount } = evidence.deployFrequency;
  if (coverage === "covered") {
    return `収集済み（この週のデプロイ回数 ${deployCount ?? observedDeployCount} 回は実データです。0 回なら本当に 0 回です）`;
  }
  if (coverage === "partial") {
    return `収集の途中（この週の一部しか数えていません。現在 ${observedDeployCount} 件まで見えていますが、主指標としては値を出していません）`;
  }
  return "収集がカバーしていません（データがありません。デプロイが無かったという意味ではありません）";
}

/**
 * 外部リンク。**URL が取れないときはリンクにせず素のテキストにする。**
 *
 * `raw` に `html_url` が無い行（古い収集・`default_branch` ルールのデプロイなど）で
 * 空の `href` を出すと、クリックできるのに同じページへ戻るリンクになり、
 * 「3 階層目は作らず GitHub へ送る」という約束が画面上で嘘になる。
 */
function ExternalLink({
  href,
  label,
  title,
}: {
  href: string | null;
  label: string;
  title?: string;
}) {
  if (href === null) {
    return (
      <span>
        <code>{label}</code>
        <span class="fk-hint">（GitHub の URL が収集されていません）</span>
      </span>
    );
  }
  return (
    <a href={href} rel="noreferrer noopener external" title={title}>
      <code>{label}</code>
    </a>
  );
}

function assignmentText(deployment: DeploymentEvidence): string {
  if (deployment.truncated) {
    return "差分が打ち切られています（compare が 1 レスポンスに収まらなかった）。標本にしていません";
  }
  if (deployment.assignment === "oldest") {
    return "割り当てなし（期間内で最も古いデプロイのため、差分の base が決められません。#15）";
  }
  if (deployment.assignment === "pending") {
    return "差分が未取得です（compare をまだ取っていないため、標本にしていません）";
  }
  return `${deployment.commits.length} 件`;
}

/** 時間の表示。小数 1 桁まで。丸めは画面の仕事（`metrics/lead-time.ts`）。 */
function formatHours(hours: number): string {
  return `${hours.toFixed(1)} 時間`;
}
