# `raw` カラムに保存する項目

ADR-0002 は「GitHub 生レスポンスの**必要部分**を `raw` JSON カラムとして残す」と決めたが、
その線引きを定義していなかった。この文書がその線引きである。

実装は `src/github/project.ts` の射影関数 1 箇所に閉じている。テストは
`src/github/project.test.ts` で、実 API レスポンス（`src/github/__fixtures__/`）に対して
「列挙した項目だけが残る」ことを固定している。

## なぜ絞るのか

**容量のためではない。** SQLite にディスク上限はなく、10 スコープ・1 年分を生 raw で
保存しても 514 MB に収まる（`docs/spikes/0025-d1-capacity.md`）。

絞る理由は 2 つ。

1. **クエリ性能と可読性** — `raw` が 21 KB あると、何が入っているのか誰も把握できなくなる
2. **個人単位の集計を構造的に不可能にする** — `user` / `author` / `committer` / `merged_by` の
   ユーザー情報を保存しない。`README.md` のアンチパターン「個人の評価に使わせない」は、
   方針として書くよりデータを持たない方が強い

## コミット (`commits.raw`)

取得元: `GET /repos/{owner}/{repo}/commits`

| 項目 | 用途 |
| --- | --- |
| `sha` | 同一性 |
| `html_url` | ドリルダウン（柱 4） |
| `commit.message` | ドリルダウン表示 |
| `commit.committer.date` | **変更のリードタイムの起点**、および `default_branch` ルールでのデプロイ時刻（ADR-0001 / 0004） |
| `commit.author.date` | committer date との差の確認用。指標には使わない |
| `parents[].sha` | マージコミットの判定（親が 2 つ以上）。`merge_only` の粒度判定に必須 |

**保存しない主な項目**: `author` / `committer`（ユーザー情報）、`node_id`、`url`、
`comments_url`、`commit.tree`、`commit.verification`、`commit.comment_count`。

実測: 5,310 B → 1,095 B。

## プルリクエスト (`pull_requests.raw`)

取得元: `GET /repos/{owner}/{repo}/pulls`

| 項目 | 用途 |
| --- | --- |
| `number` | 同一性、ドリルダウン |
| `title` | ドリルダウン表示 |
| `html_url` | ドリルダウン（柱 4） |
| `created_at` | 「コミット → PR open」「PR open → merge」区間の内訳（ADR-0004） |
| `merged_at` | 同上。**デプロイ時刻には使わない**（ADR-0001） |
| `merge_commit_sha` | PR とデプロイの対応付け |
| `head.sha` / `head.ref` | 差分範囲の特定 |
| `base.sha` / `base.ref` | デフォルトブランチへのマージかの判定 |

**保存しない主な項目**: `user` / `merged_by`（ユーザー情報）、`body`、`labels`、
`assignees`、`requested_reviewers`、`milestone`、`_links`、各種 `*_url`、
統計（`additions` / `deletions` / `changed_files` / `comments` / `commits`）、
`mergeable` / `mergeable_state`（取得時点の一時的な状態で、履歴として意味がない）。

実測: 26,435 B → 500 B 前後。**生レスポンスの 98% は本アプリが使わない。**

## compare (`compare_cache`)

取得元: `GET /repos/{owner}/{repo}/compare/{base}...{head}`

`raw` を持たない。**コミットの SHA 列と件数だけ**を保存する。

| 項目 | 用途 |
| --- | --- |
| `commits[].sha` | デプロイ間の差分コミット集合（ADR-0004） |
| `total_commits` | 打ち切り検出 |

**`files` を保存しない。** 実測でペイロードの約 8 割（compare 1 コールで 75 KB / 95 KB）が
ファイル差分であり、本アプリは一切使わない。

`total_commits` を保持するのは打ち切りを検出するためである。compare API は 1 レスポンスあたり
**最大 250 コミット**しか返さない。取りこぼしに気付かないまま集計すると、リードタイムの標本が
黙って欠け、ADR-0004 が退けた「時刻順近似」と同じ壊れ方をする。

## 障害 (`incidents.raw`)

**MVP では書き込まない。** ADR-0002 決定 5 により、取得元を示す `source` 列を持つ
テーブルだけを先に用意している。取得元が決まった時点でこの節を埋める。
