-- スコープはリポジトリ内の設定ファイルで管理するため、テーブルを持たない（ADR-0005）。
-- 各テーブルは scope_id を文字列として持つ。
CREATE TABLE commits (
  scope_id     TEXT NOT NULL,
  sha          TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  authored_at  TEXT NOT NULL,
  message      TEXT NOT NULL,
  raw          TEXT NOT NULL,
  PRIMARY KEY (scope_id, sha)
);
