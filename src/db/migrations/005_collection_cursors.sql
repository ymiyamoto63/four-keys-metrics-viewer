-- スコープごとの収集状態。バックフィルを中断・再開可能にするために持つ。
-- last_success_at は画面に常時表示する（ADR-0007。常時稼働しないため、
-- これが無いと利用者は古いデータを現在の状態として読む）。
CREATE TABLE collection_cursors (
  scope_id          TEXT    NOT NULL PRIMARY KEY,
  backfilled_until  TEXT,
  backfill_complete INTEGER NOT NULL,
  last_success_at   TEXT,
  last_error        TEXT
);
