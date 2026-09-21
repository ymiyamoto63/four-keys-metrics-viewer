# 運用手順: PAT の管理とバックアップ

対象は 3 つ。**GitHub fine-grained PAT の発行・更新**、**ネットワーク公開範囲の確認**、
**SQLite ファイルのバックアップと復旧**。いずれも ADR-0006（改訂）/ ADR-0007 で
決まった構成を前提にした「動かし続けるために必要な作業」であり、初期セットアップ
（`README.md` の「動かし方」）の続きにあたる。

> **前提の確認（2026-09-20 時点）**: ADR-0006 の改訂により、アクセス制御は
> `127.0.0.1` へのバインドのみで完結する。**Cloudflare Access も Tailscale も
> リバースプロキシも VPN も設定不要。** 以下の「2. ネットワーク公開範囲」は
> 確認手順のみで、設定作業は登場しない。

---

## 1. GitHub fine-grained PAT

### なぜ PAT が要るか

ADR-0006 の決定により、このアプリは閲覧者ごとの OAuth ではなく、**単一の read-only
fine-grained PAT** を collector の credential として使う。定期収集（ADR-0007 決定 4）が
閲覧者のいない時間にも動く必要があるため、閲覧者のトークンでは収集できない。

### 1.1 発行手順（GitHub の Web UI 作業）

fine-grained PAT の発行は Web UI でしか行えないため、画面遷移を具体的に書く。

1. ブラウザで **`https://github.com/settings/personal-access-tokens/new`** を開く
   （たどる場合は GitHub 右上のアバター → **Settings** → 左メニュー最下部
   **Developer settings** → **Personal access tokens** → **Fine-grained tokens** →
   **Generate new token**）。
2. **Token name**: 用途がわかる名前（例 `four-keys-metrics-viewer-collector`）。
3. **Expiration**: 期限を設定する。**無期限は選ばない**（漏洩時の影響を抑える）。
   90 日など運用しやすい期間を選び、更新日をカレンダーなどに控えておく
   （期限切れの影響は後述「1.3 期限切れの検知」を参照）。
4. **Resource owner**: PAT を発行する自分のアカウント。ADR-0006 の調査どおり
   Organization は存在しないため、選択肢は自分のアカウントのみのはず。
5. **Repository access**: **Only select repositories** を選び、
   `scopes.toml` に書いた `owner/repo` の組み合わせだけをリポジトリ単位で選択する。
   **全リポジトリを選ばない**（ADR-0006「対象リポジトリのみ選択」）。
   スコープを追加・削除したら、この選択も合わせて更新する。
6. **Permissions → Repository permissions**: 次の 4 つだけを **Read-only** に設定する
   （他はすべて "No access" のまま）。どの権限が要るかは
   `src/github/client.ts` が実際に叩く API から逆算した（下表）。
7. 画面下部の **Generate token** を押す。
8. 生成直後の 1 回だけトークン文字列が表示される。**この画面を離れると二度と表示されない**
   ので、この時点で控える（次の手順ですぐ `.env` に貼る）。

### 必要な Repository permissions（API から逆算）

| 呼び出している API（`src/github/client.ts`） | 必要な Repository permission |
| --- | --- |
| `GET /repos/{owner}/{repo}/commits`（`listCommits`） | **Contents**: Read-only |
| `GET /repos/{owner}/{repo}/compare/{base}...{head}`（`compare`） | **Contents**: Read-only（commits と共通） |
| `GET /repos/{owner}/{repo}/pulls`（`listPullRequests`） | **Pull requests**: Read-only |
| `GET /repos/{owner}/{repo}/actions/runs`<br>`GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs`（`listWorkflowRuns`） | **Actions**: Read-only |
| （リポジトリへアクセスするための必須権限。fine-grained PAT では自動選択される） | **Metadata**: Read-only |

上記 4 つ以外（Issues / Deployments / Webhooks など）は選ばない。
**Write 権限は一切不要。** このアプリは GitHub に書き込みを行わない。

### 1.2 `.env` への設定

```sh
cp .env.example .env
```

`.env` を開き、`GITHUB_TOKEN=` の右辺に発行したトークンを貼る。

```
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**`.env` は `.gitignore` 済みで、コミットされない。** 念のため手元で確認する。

```sh
git check-ignore -v .env
```

`.gitignore:7:.env	.env` のように、無視ルールとファイル名が出れば無視されている
（`.gitignore` に何もヒットしなければこのコマンドは何も出力せず、終了コード 1 を返す。
その場合は `.env` がコミット対象になっているということなので、`.gitignore` を確認する）。

設定を反映するには再起動が要る（Docker の場合 `docker compose up -d` で
コンテナを作り直す。詳細は「1.4 ローテーション手順」と同じ）。

### 1.3 期限切れの検知

PAT の期限が切れると、収集は**エラーにはなるがプロセスは落ちない**
（`src/collector/per-scope.ts` がスコープ単位で失敗を吸収する設計のため）。
つまり画面は動き続け、**気づかないと収集だけが静かに止まる。**

検知手段は**画面の「収集状態」パネル**である（ADR-0007 / #20。`src/server/views/scope-notices.tsx`）。
サマリ画面・指標詳細画面のどちらにも常時出ており、スコープごとに次の 3 つを表示する。

| 表示 | 正常なときの見え方 | 異常のサイン |
| --- | --- | --- |
| **最終収集成功** | 時刻と経過時間。**「今から 1〜2 時間以内」**（`COLLECT_CRON` の既定は毎時） | 経過時間が伸び続ける／「まだ一度も成功していません」 |
| **バックフィル進捗** | `完了（100%・目標 365 日ぶんを遡り終えています）` | いつまでも % が上がらない |
| **直前の収集が失敗しています** | **表示されない**（`last_error` が無いときは要素ごと出ない） | 赤く表示され、エラー本文が出る |

**画面を開くたびにこの 3 つを見る**のが基本の運用になる。とくに 3 つ目は、
`認証に失敗した。PAT が無効か期限切れの可能性がある`（401）がそのまま出るので、
期限切れならこれで分かる。403 の場合は期限切れではなく、対象リポジトリの選択漏れや
権限設定ミスの可能性が高い（`src/github/client.ts` の `describeStatus` を参照）。

> **なぜ「静かに止まる」のか。** 収集の失敗はスコープ単位で吸収され
> （`src/collector/per-scope.ts`）、プロセスは落ちず画面も開く。さらに ADR-0004 の
> 「データ不足の週は値を出さない」により、**収集が壊れている期間と本当にデプロイが
> 無かった期間は、グラフ上では同じ空白に見える。** 収集状態パネルを見ない限り
> 区別が付かない。

起動のたびに一度この確認を行う、または期限の 1 週間前をカレンダーに入れておくなど、
**定期確認を運用に組み込む**こと。常時稼働しない構成（ADR-0007）のため、
「次に起動したときに気づく」が実質的な検知タイミングになる。

### 画面を開けないときの代替手段

アプリが起動しない、コンテナにしか入れない、といった場合は
`collection_cursors` テーブルを直接見る。画面と同じ値をそのまま読む。

```sh
docker compose exec app node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.DATABASE_PATH, { readonly: true });
console.table(db.prepare('SELECT scope_id, last_success_at, last_error FROM collection_cursors').all());
db.close();
"
```

`last_success_at` が更新されていない、または `last_error` に上表のエラーが出ていたら
画面と同じように扱う。

### 1.4 ローテーション手順

1. 「1.1 発行手順」と同じ手順で**新しい** PAT を発行する（対象リポジトリ・権限は同一）。
2. `.env` の `GITHUB_TOKEN` を新しい値に書き換える。
3. コンテナを作り直して設定を反映する。

   ```sh
   docker compose down
   docker compose up -d
   ```

   （ホスト上で直接動かしている場合はプロセスを再起動するだけでよい。）
4. 画面の「収集状態」で**最終収集成功が更新され、失敗の表示が消えている**ことを確認する。
   起動時に自動で 1 回収集が走るため（`COLLECT_ON_STARTUP`）、数秒〜数十秒待って確認する。
5. 更新を確認できたら、**古い PAT を失効させる**。
   `https://github.com/settings/personal-access-tokens` を開き、対象トークンの
   **⋯ → Delete** で失効させる。新旧が同時に有効な期間を長く残さない。

---

## 2. ネットワーク公開範囲の確認（設定作業は不要）

ADR-0006 の改訂により、アクセス制御は**「このホスト以外から到達できないこと」**のみで
成立する。Cloudflare Access・Tailscale・リバースプロキシ・VPN はいずれも不要であり、
**それらを設定する手順はここにはない。** 以下は確認手順のみ。

### 危険な状態とは何か

ここでいう「危険」とは、**同一ネットワーク（同じ Wi-Fi / LAN）に接続した認証なしの
第三者が、ブラウザで IP アドレスを叩くだけで画面を開けてしまう状態**を指す。
`scopes.toml` の対象は private リポジトリを含むため、開けてしまうと
デプロイ頻度・変更のリードタイムのグラフや、ドリルダウン経由でコミット・PR
（`docs/raw-columns.md` に列挙した項目、タイトルやコミットメッセージを含む）が
ログインなしで見える。**「private リポジトリが存在し、こういう頻度で動いている」という
活動履歴そのものが漏れる**、という意味で危険である。

### 確認 1: `docker-compose.yml` のポート公開設定

```sh
grep -n "ports:" -A1 docker-compose.yml
```

`"127.0.0.1:3000:3000"` のように**左辺（ホスト側）に `127.0.0.1:` が付いている**ことを確認する
（本書作成時点で既にこの状態になっていることを確認済み。左辺が
`"3000:3000"` のように裸のポート番号だけになっていたら、その瞬間に
同一ネットワーク上の全端末へ公開される。`docs/adr/0006-auth-and-access-control.md`
「実装上の補足」参照）。

### 確認 2: コンテナ起動後、ホストの待受アドレスを確認する

```sh
docker compose up -d
docker compose ps
```

`PORTS` 列が `127.0.0.1:3000->3000/tcp` のように**左側に `127.0.0.1:` が付いた形**
であることを確認する（実機で確認済み。`0.0.0.0:3000->3000/tcp` のように左側が
`0.0.0.0` になっていたら公開範囲が広がっている）。

OS のソケット一覧でも同じことを確認できる。

```sh
ss -ltnp | grep 3000
```

`LISTEN ... 127.0.0.1:3000 ...` のように**アドレス部分が `127.0.0.1`** であることを確認する
（`0.0.0.0:3000` や `*:3000` になっていたら全インターフェースで待ち受けている状態）。

### 確認 3: 実際に同一ネットワークの別端末から到達できないことを確認する

このマシンの LAN 側 IP アドレスを調べる。

```sh
ip -4 addr show | grep inet
```

`eth0` や `wlan0` など、実際にネットワークへ出るインターフェースの IP アドレス
（例 `192.168.11.28`）を控える。**同一ネットワーク上の別のスマートフォンや PC の
ブラウザから** `http://<控えたIP>:3000/` を開き、**接続できない（読み込めない）**
ことを確認する。別端末が用意できない場合は、このマシン自身から LAN 側 IP へ
アクセスしても同じ結果になる（`127.0.0.1` 以外の経路を通るため）。

```sh
curl --max-time 3 http://<控えたIP>:3000/
```

**接続を拒否される（`Connection refused` / `curl: (7) ...`）ことが正しい状態。**
HTTP のレスポンス（200 など）が返ってきた場合は、「確認 1・2」に戻って
どこで `0.0.0.0` に開いてしまっているかを特定する。

一方 `curl --max-time 3 http://127.0.0.1:3000/` は `200` が返るのが正しい
（ホスト自身からは開けて当然で、これがアプリの生存確認になる）。

### 確認 4: ホスト上で直接動かす場合（`npm start` / `npm run dev`）

Docker を介さず直接プロセスを動かす場合は、アプリ自身が `127.0.0.1` にバインドする
（`src/config.ts`）。`HOST` を明示的に `0.0.0.0` などループバック以外に変更すると
`ALLOW_NON_LOOPBACK_BIND=1` を要求され、指定しない限り**起動時エラーで止まる**。
これは実機で確認済みの挙動である。通常の使い方（`HOST` を指定しない）であれば、
この節の作業は不要——起動ログの `loopbackOnly` が `true` になっていることだけ確認すれば足りる。

```sh
npm run dev
# ログの最後に "loopbackOnly":true が出ることを確認する
```

---

## 3. SQLite ファイルのバックアップと復旧

### なぜ必要か

ADR-0007 により、収集した全履歴は Docker named volume（`four-keys-data`）上の
SQLite ファイル 1 つに集約されている。**volume を消す（`docker compose down -v` など）と
全履歴が失われる。** バックフィルで取り直せるが、**既定のバックフィル範囲は 1 年
（`backfill_days`、既定 365）であり、それより古いデータは二度と戻らない。**
定期的なバックアップが実質的な唯一の保険になる。

### なぜ単純な `cp` が危険か

`src/db/index.ts` は SQLite を **WAL モード**で開く。WAL モードでは直近の書き込みが
本体ファイル（`four-keys.sqlite`）ではなく `-wal` ファイルに残っていることがあり、
本体ファイルだけを `cp` すると**その時点までの書き込みが欠けたコピー**になる。

これは実際に再現できる。書き込み直後に本体ファイルだけを `cp` し、`-wal` /
`-shm` を含めずに別プロセスとして開くと、**元では確認できる最新の 1 件が
コピー側には存在しない**（実行済みの検証。詳細は PR 本文の実行ログを参照）。
`-wal` / `-shm` を含めて丸ごとコピーすれば理屈上は防げるが、**コピー中に
収集ジョブが書き込むと壊れたコピーになりうる**上に取り扱うファイルが増える。

したがって本書では、SQLite が公式に提供する**アトミックなスナップショット機構**である
`VACUUM INTO` を第一手段にする。実行時点の一貫した状態を単一ファイルへ書き出すため、
WAL の状態を意識する必要がなく、実行中のアプリを止める必要もない。

### 3.1 バックアップ手順（Docker 運用。通常はこちら）

`better-sqlite3`（このアプリの依存）はコンテナの `node_modules` に既に入っているので、
追加のツール（`sqlite3` CLI など。ランタイムイメージには入っていない）は要らない。

```sh
mkdir -p backups

# volume 内（/data）に VACUUM INTO でバックアップを作る
docker compose exec app node -e "
const Database = require('better-sqlite3');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const path = '/data/backup-' + stamp + '.sqlite';
const db = new Database(process.env.DATABASE_PATH, { readonly: true });
db.prepare('VACUUM INTO ?').run(path);
console.log('backup created:', path);
db.close();
"
```

出力された `backup created: /data/backup-....sqlite` のパスをそのまま使い、
ホスト側へ取り出す。

```sh
# <パス> は上のコマンドが出力した /data/backup-....sqlite に置き換える
docker compose cp app:<パス> ./backups/four-keys-$(date +%Y%m%d).sqlite

# volume 内の一時ファイルは削除しておく（バックアップの中にバックアップが積み重ならないように）
docker compose exec app rm <パス>
```

`./backups/four-keys-YYYYMMDD.sqlite` が単体のバックアップファイル（`.wal` / `.shm` なし、
そのまま持ち運べる）。`backups/` はリポジトリにコミットしない
（`.gitignore` の `*.sqlite` に既にマッチする）。定期実行したい場合は、上記 2 コマンドを
cron などホスト側のスケジューラに登録する。

### 3.2 バックアップ手順（ホスト上で直接動かしている場合）

Docker を使わない場合は `DATABASE_PATH` を直接指定して同じことを行う。

```sh
mkdir -p backups
node -e "
const Database = require('better-sqlite3');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const path = './backups/four-keys-' + stamp + '.sqlite';
const db = new Database(process.env.DATABASE_PATH || './data/four-keys.sqlite', { readonly: true });
db.prepare('VACUUM INTO ?').run(path);
console.log('backup created:', path);
db.close();
"
```

### 3.3 復旧手順

**volume が残っている状態での復旧**（例: 特定日時の状態に戻したいだけの場合）は、
アプリを止めてから DB ファイルを置き換える。

```sh
docker compose down
docker compose run --rm -v "$PWD/backups:/backup" app node -e "
const fs = require('node:fs');
fs.copyFileSync('/backup/four-keys-YYYYMMDD.sqlite', '/data/four-keys.sqlite');
console.log('restored /data/four-keys.sqlite from backup');
"
docker compose up -d
```

**volume 自体を失った場合**（`docker compose down -v` を誤って実行した、
volume が壊れたなど）も同じ手順でよい。`docker compose up -d` は
volume が存在しなければ新しい空の volume を作るため、上の `docker compose run`
の時点で（volume がまだ無ければ）新規作成された空の volume に対して
バックアップファイルがコピーされる形になる。

復旧後は次のことを確認する。

- `docker compose exec app node -e "..."`（「1.3」と同じクエリ）で
  `collection_cursors` の中身が想定どおり戻っていること
- 画面の「収集状態」で最終収集成功時刻とバックフィル進捗を確認すること
- 復旧したバックアップより新しい期間のデータは失われているが、
  **次の収集サイクルで自動的に前へ追いつく**（バックフィルカーソルも
  バックアップ時点の状態に戻るため、二重取得にはならない。ADR-0007 決定 6）。
  ただし既定 1 年より古い欠損は埋まらない点は「なぜ必要か」と同じ制約を引き継ぐ。

---

## 参照

- `docs/adr/0006-auth-and-access-control.md`（2026-09-20 改訂・実装上の補足）
- `docs/adr/0007-self-hosted-node-sqlite.md`
- `docs/db-migrations.md`（マイグレーション取り消し前のバックアップ手順。本書の
  バックアップ手順が正の手順であり、`db-migrations.md` 側の手順は本書を参照する形に
  揃えるのが望ましいが、今回のスコープでは変更しない）
- `docs/raw-columns.md`（画面・ドリルダウンで露出する項目の一覧）
- `src/github/client.ts`（PAT に必要な権限の根拠）
- `src/config.ts`（`HOST` / `ALLOW_NON_LOOPBACK_BIND` の実装）
- `src/server/views/scope-notices.tsx` / `src/server/collection-status.ts`（収集状態パネルの実装）
- `docs/sample-repo.md`（検証用サンプルリポジトリの生成と E2E 確認手順）
- Issue #24, #20, #7
