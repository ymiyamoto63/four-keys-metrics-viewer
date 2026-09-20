-- 「どこまで最新を追ったか」を落とす。次回の収集は最新を追う起点を失い、
-- バックフィルの端（backfilled_until）から取り直すことになる（行は upsert なので増えない）。
ALTER TABLE collection_cursors DROP COLUMN followed_until;
