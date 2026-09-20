-- スコープ + 時刻での範囲検索が全クエリの基本形になる（週次バケット集計、ADR-0004）。
CREATE INDEX idx_commits_scope_committed_at
  ON commits (scope_id, committed_at);

CREATE INDEX idx_pull_requests_scope_created_at
  ON pull_requests (scope_id, created_at);

CREATE INDEX idx_pull_requests_scope_merged_at
  ON pull_requests (scope_id, merged_at);

-- デプロイは常に検出ルールで絞ってから時刻順に並べる。
CREATE INDEX idx_deploy_events_scope_rule_deployed_at
  ON deploy_events (scope_id, detection_rule, deployed_at);

-- マージコミット SHA からデプロイを引く経路（PR → デプロイの対応付け）。
CREATE INDEX idx_pull_requests_scope_merge_commit
  ON pull_requests (scope_id, merge_commit_sha);

CREATE INDEX idx_incidents_scope_started_at
  ON incidents (scope_id, started_at);
