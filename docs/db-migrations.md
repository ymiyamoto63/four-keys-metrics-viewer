# マイグレーションの適用と取り消し

実装は `src/db/migrate.ts`、SQL は `src/db/migrations/`。

## 仕組み

- `NNN_name.sql` を名前順に適用する。対になる `NNN_name.down.sql` が取り消し用
- 適用済みは `schema_migrations` テーブルに記録する
- **未適用のものだけを適用する。** 何度実行しても安全
- 1 マイグレーションはトランザクションで適用する。途中で失敗したら記録も残らない

## 適用

アプリの起動時に `openDatabase()` が自動で適用する。手動操作は要らない。

```sh
docker compose up   # 起動時に適用される
```

古いバージョンの DB を持ったままアプリを更新した場合も、起動時に未適用分だけが適用される。

## 取り消し

`rollbackLast(db)` が直近の 1 つを取り消す。**取り消した分のデータは戻らない**
（`DROP TABLE` / `DROP INDEX` を実行するため）。

```sh
docker compose run --rm app node -e "
  const { openDatabase } = await import('./dist/db/index.js');
  const { rollbackLast, appliedMigrations } = await import('./dist/db/migrate.js');
  const db = openDatabase(process.env.DATABASE_PATH);
  rollbackLast(db);
  console.log(appliedMigrations(db));
"
```

> **注意**: `openDatabase()` は開いた時点で未適用分を適用する。上の手順は
> 「適用 → 直近を取り消す」という動きになる。複数戻したい場合は `rollbackLast` を繰り返す。

## 取り消す前に必ずバックアップを取ること

生イベントは恒久保存する前提であり（ADR-0002）、失うとバックフィルで取り直すことになる。
**既定のバックフィル範囲は 1 年なので、それより古いデータは戻らない。**

```sh
# volume 上の SQLite ファイルをホストへコピーする
docker compose run --rm -v "$PWD:/backup" app \
  sh -c 'sqlite3 "$DATABASE_PATH" ".backup /backup/four-keys-$(date +%Y%m%d).sqlite"'
```

WAL モードで動いているため、**ファイルを直接 `cp` しないこと。** `.backup` を使う
（`-wal` / `-shm` を取りこぼすと壊れたコピーになる）。

## 新しいマイグレーションを足すとき

1. `src/db/migrations/NNN_name.sql` と `NNN_name.down.sql` を対で作る
2. `src/db/migrate.test.ts` の `ALL_MIGRATIONS` に名前を足す
3. `npm test` で、空の DB への適用・冪等性・古い DB の追いつき・取り消しが通ることを確認する

**既存のマイグレーションファイルを書き換えないこと。** 適用済みの DB には反映されず、
環境ごとにスキーマがずれる。変更は必ず新しい番号で足す。
