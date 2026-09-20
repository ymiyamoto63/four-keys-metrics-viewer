-- MVP では書き込まない。不安定性側 3 指標の前提となる概念で、取得元を示す source 列を
-- 最初から持たせておく（ADR-0002 決定 5）。将来の取得元の第一候補は GitHub Issue のラベル運用。
CREATE TABLE incidents (
  scope_id     TEXT NOT NULL,
  incident_id  TEXT NOT NULL,
  source       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  resolved_at  TEXT,
  raw          TEXT NOT NULL,
  PRIMARY KEY (scope_id, incident_id)
);
