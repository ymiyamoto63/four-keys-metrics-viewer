import type { Db } from "./index.ts";

export type Commit = {
  scopeId: string;
  sha: string;
  committedAt: string;
  authoredAt: string;
  message: string;
  raw: unknown;
};

export function saveCommit(db: Db, commit: Commit): void {
  db.prepare(
    `INSERT INTO commits (scope_id, sha, committed_at, authored_at, message, raw)
     VALUES (@scopeId, @sha, @committedAt, @authoredAt, @message, @raw)
     ON CONFLICT (scope_id, sha) DO UPDATE SET
       committed_at = excluded.committed_at,
       authored_at  = excluded.authored_at,
       message      = excluded.message,
       raw          = excluded.raw`,
  ).run({ ...commit, raw: JSON.stringify(commit.raw) });
}

type CommitRow = {
  scope_id: string;
  sha: string;
  committed_at: string;
  authored_at: string;
  message: string;
  raw: string;
};

export function listCommits(db: Db, scopeId: string): Commit[] {
  const rows = db
    .prepare("SELECT * FROM commits WHERE scope_id = ? ORDER BY committed_at")
    .all(scopeId) as CommitRow[];
  return rows.map((row) => ({
    scopeId: row.scope_id,
    sha: row.sha,
    committedAt: row.committed_at,
    authoredAt: row.authored_at,
    message: row.message,
    raw: JSON.parse(row.raw),
  }));
}

export type PullRequest = {
  scopeId: string;
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headSha: string;
  baseSha: string;
  baseRef: string;
  htmlUrl: string;
  raw: unknown;
};

export function savePullRequest(db: Db, pr: PullRequest): void {
  db.prepare(
    `INSERT INTO pull_requests
       (scope_id, number, title, created_at, merged_at, merge_commit_sha,
        head_sha, base_sha, base_ref, html_url, raw)
     VALUES
       (@scopeId, @number, @title, @createdAt, @mergedAt, @mergeCommitSha,
        @headSha, @baseSha, @baseRef, @htmlUrl, @raw)
     ON CONFLICT (scope_id, number) DO UPDATE SET
       title            = excluded.title,
       created_at       = excluded.created_at,
       merged_at        = excluded.merged_at,
       merge_commit_sha = excluded.merge_commit_sha,
       head_sha         = excluded.head_sha,
       base_sha         = excluded.base_sha,
       base_ref         = excluded.base_ref,
       html_url         = excluded.html_url,
       raw              = excluded.raw`,
  ).run({ ...pr, raw: JSON.stringify(pr.raw) });
}

type PullRequestRow = {
  scope_id: string;
  number: number;
  title: string;
  created_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head_sha: string;
  base_sha: string;
  base_ref: string;
  html_url: string;
  raw: string;
};

export function listPullRequests(db: Db, scopeId: string): PullRequest[] {
  const rows = db
    .prepare("SELECT * FROM pull_requests WHERE scope_id = ? ORDER BY created_at")
    .all(scopeId) as PullRequestRow[];
  return rows.map((row) => ({
    scopeId: row.scope_id,
    number: row.number,
    title: row.title,
    createdAt: row.created_at,
    mergedAt: row.merged_at,
    mergeCommitSha: row.merge_commit_sha,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    baseRef: row.base_ref,
    htmlUrl: row.html_url,
    raw: JSON.parse(row.raw),
  }));
}

export type Deployment = {
  scopeId: string;
  /** どのデプロイ検出ルールで検出したか（ADR-0001）。 */
  detectionRule: string;
  commitSha: string;
  /** デプロイ時刻。PR の merged_at ではなく committer date（ADR-0001）。 */
  deployedAt: string;
  raw: unknown;
};

export function saveDeployment(db: Db, deployment: Deployment): void {
  db.prepare(
    `INSERT INTO deploy_events (scope_id, detection_rule, commit_sha, deployed_at, raw)
     VALUES (@scopeId, @detectionRule, @commitSha, @deployedAt, @raw)
     ON CONFLICT (scope_id, detection_rule, commit_sha) DO UPDATE SET
       deployed_at = excluded.deployed_at,
       raw         = excluded.raw`,
  ).run({ ...deployment, raw: JSON.stringify(deployment.raw) });
}

type DeploymentRow = {
  scope_id: string;
  detection_rule: string;
  commit_sha: string;
  deployed_at: string;
  raw: string;
};

export function listDeployments(db: Db, scopeId: string, detectionRule: string): Deployment[] {
  const rows = db
    .prepare(
      `SELECT * FROM deploy_events
       WHERE scope_id = ? AND detection_rule = ?
       ORDER BY deployed_at`,
    )
    .all(scopeId, detectionRule) as DeploymentRow[];
  return rows.map((row) => ({
    scopeId: row.scope_id,
    detectionRule: row.detection_rule,
    commitSha: row.commit_sha,
    deployedAt: row.deployed_at,
    raw: JSON.parse(row.raw),
  }));
}

/**
 * スコープのデプロイ検出ルールが変わったときに、古いルールで導出したデータを破棄する。
 *
 * ADR-0002 の③「外部 API を再取得しないと復元できない導出はキャッシュとして保存し、
 * ルールが変わったら破棄する」の実装。破棄しないと古い導出が生き残り、
 * 「この数値がどう計算されたか辿れる」（柱 4）が嘘になる。
 *
 * commits / pull_requests は生イベント（①）なので破棄しない。
 */
export function discardDerivedData(db: Db, scopeId: string, currentDetectionRule: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM deploy_events WHERE scope_id = ? AND detection_rule != ?").run(
      scopeId,
      currentDetectionRule,
    );
    db.prepare("DELETE FROM compare_cache WHERE scope_id = ? AND detection_rule != ?").run(
      scopeId,
      currentDetectionRule,
    );
  })();
}

export type CompareCacheKey = {
  scopeId: string;
  detectionRule: string;
  baseSha: string;
  headSha: string;
};

export type CompareCacheEntry = CompareCacheKey & {
  commitShas: string[];
  truncated: boolean;
};

export function saveCompareCache(db: Db, entry: CompareCacheEntry): void {
  db.prepare(
    `INSERT INTO compare_cache
       (scope_id, detection_rule, base_sha, head_sha, commit_shas, truncated, fetched_at)
     VALUES (@scopeId, @detectionRule, @baseSha, @headSha, @commitShas, @truncated, @fetchedAt)
     ON CONFLICT (scope_id, detection_rule, base_sha, head_sha) DO UPDATE SET
       commit_shas = excluded.commit_shas,
       truncated   = excluded.truncated,
       fetched_at  = excluded.fetched_at`,
  ).run({
    scopeId: entry.scopeId,
    detectionRule: entry.detectionRule,
    baseSha: entry.baseSha,
    headSha: entry.headSha,
    commitShas: JSON.stringify(entry.commitShas),
    truncated: entry.truncated ? 1 : 0,
    fetchedAt: new Date().toISOString(),
  });
}

type CompareCacheRow = {
  scope_id: string;
  detection_rule: string;
  base_sha: string;
  head_sha: string;
  commit_shas: string;
  truncated: number;
};

export function findCompareCache(db: Db, key: CompareCacheKey): CompareCacheEntry | undefined {
  const row = db
    .prepare(
      `SELECT * FROM compare_cache
       WHERE scope_id = @scopeId AND detection_rule = @detectionRule
         AND base_sha = @baseSha AND head_sha = @headSha`,
    )
    .get(key) as CompareCacheRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    scopeId: row.scope_id,
    detectionRule: row.detection_rule,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    commitShas: JSON.parse(row.commit_shas),
    truncated: row.truncated === 1,
  };
}

export type CollectionCursor = {
  scopeId: string;
  /** どこまで過去へ遡ったか。null は未着手。 */
  backfilledUntil: string | null;
  backfillComplete: boolean;
  /** 最終収集成功時刻。画面に常時表示する（ADR-0007）。 */
  lastSuccessAt: string | null;
  lastError: string | null;
};

export function saveCollectionCursor(db: Db, cursor: CollectionCursor): void {
  db.prepare(
    `INSERT INTO collection_cursors
       (scope_id, backfilled_until, backfill_complete, last_success_at, last_error)
     VALUES (@scopeId, @backfilledUntil, @backfillComplete, @lastSuccessAt, @lastError)
     ON CONFLICT (scope_id) DO UPDATE SET
       backfilled_until  = excluded.backfilled_until,
       backfill_complete = excluded.backfill_complete,
       last_success_at   = excluded.last_success_at,
       last_error        = excluded.last_error`,
  ).run({ ...cursor, backfillComplete: cursor.backfillComplete ? 1 : 0 });
}

type CollectionCursorRow = {
  scope_id: string;
  backfilled_until: string | null;
  backfill_complete: number;
  last_success_at: string | null;
  last_error: string | null;
};

export function findCollectionCursor(db: Db, scopeId: string): CollectionCursor | undefined {
  const row = db.prepare("SELECT * FROM collection_cursors WHERE scope_id = ?").get(scopeId) as
    | CollectionCursorRow
    | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    scopeId: row.scope_id,
    backfilledUntil: row.backfilled_until,
    backfillComplete: row.backfill_complete === 1,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
  };
}

/**
 * バックフィルの進捗を記録する（#12）。最終収集成功時刻と直前の失敗には触らない。
 *
 * 「どこまで過去へ遡ったか」と収集サイクルの成否は別々に進む。1 窓だけ取ってレート制限で
 * 中断した場合、遡った分は確定させたいが、そのサイクルを成功扱いにはできない。
 */
export function recordBackfillProgress(
  db: Db,
  scopeId: string,
  backfilledUntil: string | null,
  complete: boolean,
): void {
  db.prepare(
    `INSERT INTO collection_cursors
       (scope_id, backfilled_until, backfill_complete, last_success_at, last_error)
     VALUES (?, ?, ?, NULL, NULL)
     ON CONFLICT (scope_id) DO UPDATE SET
       backfilled_until  = excluded.backfilled_until,
       backfill_complete = excluded.backfill_complete`,
  ).run(scopeId, backfilledUntil, complete ? 1 : 0);
}

/**
 * 収集の失敗を記録する。最終収集成功時刻は上書きしない。
 * PAT の期限切れなどで収集が静かに止まったことを、画面から読み取れるようにするため。
 */
export function recordCollectionFailure(db: Db, scopeId: string, message: string): void {
  db.prepare(
    `INSERT INTO collection_cursors
       (scope_id, backfilled_until, backfill_complete, last_success_at, last_error)
     VALUES (?, NULL, 0, NULL, ?)
     ON CONFLICT (scope_id) DO UPDATE SET last_error = excluded.last_error`,
  ).run(scopeId, message);
}

/**
 * 収集の成功を記録する。最終収集成功時刻を更新し、直前の失敗を消す。
 *
 * バックフィルの進捗（`backfilled_until` / `backfill_complete`）には触らない。
 * 「どこまで最新を追ったか」と「どこまで過去へ遡ったか」は別々に進むため（#12）。
 */
export function recordCollectionSuccess(
  db: Db,
  scopeId: string,
  at: string = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO collection_cursors
       (scope_id, backfilled_until, backfill_complete, last_success_at, last_error)
     VALUES (?, NULL, 0, ?, NULL)
     ON CONFLICT (scope_id) DO UPDATE SET
       last_success_at = excluded.last_success_at,
       last_error      = NULL`,
  ).run(scopeId, at);
}
