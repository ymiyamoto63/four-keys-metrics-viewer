CREATE TABLE pull_requests (
  scope_id         TEXT    NOT NULL,
  number           INTEGER NOT NULL,
  title            TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  merged_at        TEXT,
  merge_commit_sha TEXT,
  head_sha         TEXT    NOT NULL,
  base_sha         TEXT    NOT NULL,
  base_ref         TEXT    NOT NULL,
  html_url         TEXT    NOT NULL,
  raw              TEXT    NOT NULL,
  PRIMARY KEY (scope_id, number)
);
