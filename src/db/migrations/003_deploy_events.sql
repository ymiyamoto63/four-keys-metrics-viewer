-- どのデプロイ検出ルールで検出したかを主キーに含める。
-- 同じコミットでも、ルールが違えば「デプロイか否か」が変わるため（ADR-0001）。
CREATE TABLE deploy_events (
  scope_id       TEXT NOT NULL,
  detection_rule TEXT NOT NULL,
  commit_sha     TEXT NOT NULL,
  deployed_at    TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (scope_id, detection_rule, commit_sha)
);
