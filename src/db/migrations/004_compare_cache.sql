-- デプロイ間のコミット範囲（compare API の結果）のキャッシュ。ADR-0002 の導出 ③。
-- 生イベントではないので、デプロイ検出ルールが変わったら破棄する。
-- そのため detection_rule を主キーに含める（#8 の注意点）。
CREATE TABLE compare_cache (
  scope_id       TEXT    NOT NULL,
  detection_rule TEXT    NOT NULL,
  base_sha       TEXT    NOT NULL,
  head_sha       TEXT    NOT NULL,
  commit_shas    TEXT    NOT NULL,
  truncated      INTEGER NOT NULL,
  fetched_at     TEXT    NOT NULL,
  PRIMARY KEY (scope_id, detection_rule, base_sha, head_sha)
);
