/**
 * スコープに常時添える 2 つの説明（#20）。**どちらも任意表示ではない。**
 *
 * - `DeployRuleNotice` — このスコープが何をデプロイとみなしているか（ADR-0001 決定 5）
 * - `CollectionStatusPanel` — 最終収集成功時刻とバックフィル進捗（ADR-0007）
 *
 * 別ファイルに切り出してあるのは、**#21（指標詳細）でも同じものを出すため**である。
 * 詳細画面だけ「何をデプロイとみなしたか」や「データがどこまで新しいか」が消えると、
 * 根拠イベント一覧（#21）が何の一覧なのか読めなくなる。
 */

import type { DeployRule, Scope } from "../../scopes.ts";
import type { CollectionStatus } from "../collection-status.ts";
import { formatAge, formatJst } from "../format.ts";

/**
 * デプロイ検出ルールの常時表示（ADR-0001 決定 5）。
 *
 * ADR-0001 は `default_branch` ルールが有効な間、画面にこの文を出し続けると決めた。
 * 「デプロイ」という語が何を指しているかはスコープごとに違い（`CONTEXT.md`）、
 * それを知らずに数値を読むと、同じ「週 3 回」がまったく別の意味になる。
 */
export function DeployRuleNotice({ scope }: { scope: Scope }) {
  return (
    <section class="fk-notice" data-testid="deploy-rule">
      <h2>このスコープのデプロイの定義</h2>
      <p data-testid="deploy-rule-sentence">{deployRuleSentence(scope.deployRule)}</p>
      <dl>
        <dt>デプロイ検出ルール</dt>
        <dd>
          <code>{ruleDetail(scope.deployRule)}</code>
        </dd>
        <dt>対象リポジトリ</dt>
        <dd>
          <code>
            {scope.owner}/{scope.repo}
          </code>
        </dd>
      </dl>
      <p class="fk-hint">
        定義を変えるには <code>scopes.toml</code> を編集します（ADR-0005。編集 UI は作りません）。
      </p>
    </section>
  );
}

/** ADR-0001 決定 5 の文言。粒度・対象ワークフローまで文に含める。 */
export function deployRuleSentence(rule: DeployRule): string {
  if (rule.name === "default_branch") {
    return rule.granularity === "merge_only"
      ? "このスコープは「デフォルトブランチへの merge＝デプロイ」として計算しています。"
      : "このスコープは「デフォルトブランチへの全コミット（直接 push を含む）＝デプロイ」として計算しています。";
  }
  return `このスコープは「ワークフロー ${rule.workflow} の成功実行＝デプロイ」として計算しています。`;
}

function ruleDetail(rule: DeployRule): string {
  return rule.name === "default_branch"
    ? `default_branch / granularity = ${rule.granularity}`
    : `workflow_run / workflow = ${rule.workflow}`;
}

/**
 * 収集状態の常時表示（ADR-0007・#20 の必須要件）。
 *
 * **この節を消すと指標が嘘をつく。** ADR-0004 の「データ不足の週は値を出さない」により、
 * 収集が壊れている期間と本当にデプロイが無かった期間は画面上で同じ空白になる。
 * さらに ADR-0007 でアプリは常時稼働しなくなり、最後に起動した時点までしかデータがない。
 * 最終収集成功時刻が無ければ、利用者は**古いデータを現在の状態として読む**。
 *
 * PAT の期限切れで収集が静かに止まったことに気付ける唯一の場所でもあるため、
 * `last_error` は目立つ形で出す（`docs/operations.md` / #24 の手順がここを見る前提）。
 */
export function CollectionStatusPanel({ status }: { status: CollectionStatus }) {
  const { backfill } = status;
  return (
    <section
      class="fk-notice fk-notice--status"
      data-testid="collection-status"
      data-last-success-at={status.lastSuccessAt ?? ""}
      data-backfill-percent={String(backfill.percent)}
    >
      <h2>収集状態</h2>
      <dl>
        <dt>最終収集成功</dt>
        <dd data-testid="last-success">
          {status.lastSuccessAt === null ? (
            <strong>まだ一度も成功していません（データはありません）</strong>
          ) : (
            <>
              <time datetime={status.lastSuccessAt}>{formatJst(status.lastSuccessAt)}</time>
              {status.staleHours === null ? null : <> （{formatAge(status.staleHours)}）</>}
            </>
          )}
        </dd>
        <dt>バックフィル進捗</dt>
        <dd data-testid="backfill-progress">{backfillText(status)}</dd>
      </dl>
      {status.lastError === null ? null : (
        <p class="fk-alert" data-testid="collection-error">
          <strong>直前の収集が失敗しています:</strong> {status.lastError}
          <br />
          PAT の期限切れが疑われる場合は <code>docs/operations.md</code> の手順を確認してください。
        </p>
      )}
      <p class="fk-hint">
        このアプリは常時稼働しません（ADR-0007）。上の時刻より後のデータはまだ集めていません。
        グラフの空白は「デプロイが無かった」ではなく「まだ集めていない」の可能性があります。
      </p>
    </section>
  );
}

function backfillText(status: CollectionStatus): string {
  const { backfill } = status;
  if (status.neverCollected) {
    return `未着手（このスコープはまだ一度も収集していません。目標 ${backfill.targetDays} 日）`;
  }
  if (backfill.complete) {
    return `完了（100%・目標 ${backfill.targetDays} 日ぶんを遡り終えています）`;
  }
  if (backfill.backfilledUntil === null) {
    return `未着手（0%・目標 ${backfill.targetDays} 日）`;
  }
  return (
    `${backfill.percent}%（${formatJst(backfill.backfilledUntil)} まで遡り済み・` +
    `目標 ${backfill.targetDays} 日のうち残り約 ${backfill.remainingDays} 日）`
  );
}
