# Spike 0026: GitHub Deployments API の実態調査

- 日付: 2026-09-20
- 対象 Issue: #26
- 関連 ADR: ADR-0001

## 結論

**`deployments_api` の保留を続ける。3 つ目の検出ルールとしては実装しない。**

ADR-0001 の判断（「実リポジトリに痕跡が無さそう」という推定）は、今回の実測により
**裏付けられた**。対象アカウントの直近 active な 7 リポジトリ（本リポジトリを含め 8）は
すべて Deployments API のレコードが **0 件**（0/8）。全 36 リポジトリまで範囲を広げても
レコードを持つのは 3 件（8.3%）のみで、しかもすべて 2022〜2023 年の個人プロジェクトに対する
Vercel 連携の自動生成であり、現在 active な用途とは無関係だった。

さらに、account 内で唯一 Cloudflare Workers へ実デプロイしている `cloudflare-learning`
（active, 直近 push 2026-09-05）の実際の CD ワークフローを確認したところ、
`cloudflare/wrangler-action` を GitHub Deployments 連携なし（`gitHubToken` 未指定）で
使っており、これは仕様上 Deployments API のレコードを作らない。**対象アカウントが実際に
使っているデプロイ手段は、Deployments API を自動生成しない構成になっている。**

---

## 1. 調査方法と実測値（2026-09-20、`gh api` で実施、書き込み系 API は使用していない）

### 1.1 リポジトリの棚卸し

```
gh api /user/repos --paginate --jq '.[] | {name, fork, archived, pushed_at, private}'
```

- 総リポジトリ数: **36**
- fork: **1**（`amplify-homes`）
- archived: **0**
- **active の定義**: 調査日（2026-09-20）から 90 日以内に push があったリポジトリ
  （ADR-0001 の「デフォルトブランチのコミット（90 日）」の集計期間に合わせた）

active な 8 リポジトリ（`four-keys-metrics-viewer` 自身を含む）:

| リポジトリ | 直近 push | .github/workflows |
| --- | --- | --- |
| four-keys-metrics-viewer | 2026-09-20 | なし（調査時点） |
| incident-management-system | 2026-09-19 | なし |
| gh-dev-pipeline | 2026-09-14 | `generate-check.yml`（生成物整合性チェック、CD ではない） |
| test-dev-pipeline-1 | 2026-09-14 | なし |
| cloudflare-learning | 2026-09-05 | `deploy.yml`（**実 CD**、後述） |
| like-chatgpt | 2026-07-20 | なし |
| life-design-app | 2026-07-25 | なし |
| like-chatgpt-claude | 2026-07-05 | なし |

### 1.2 Deployments API のレコード有無（全 36 リポジトリ）

各リポジトリに対して `gh api /repos/{owner}/{repo}/deployments?per_page=100` を実行し、
件数を確認した（1 リポジトリ最大 100 件・ページングなし。実測ではすべて 1 ページに収まった）。

**active な 8 リポジトリ: 0/8 件がレコードあり（全滅）。**

**全 36 リポジトリ: 3/36 件がレコードあり。**

| リポジトリ | 件数 | 直近 push | 内訳 |
| --- | ---: | --- | --- |
| mahjong | 8 | 2023-09-18 | 全件 `vercel[bot]` / environment `Production` |
| sns-udemy | 17 | 2023-09-07 | 全件 `vercel[bot]` / environment `Production` または `Production – <project>` |
| study-react | 10 | 2022-12-03 | 全件 `vercel[bot]` / environment `Production` |
| 他 33 リポジトリ | 0 | — | — |

3 リポジトリとも `creator.login` は `vercel[bot]`、`performed_via_github_app` は `null`
（Vercel の GitHub 連携はアプリではなくボットユーザーとしてレコードを作る）。
**手動で作られたレコードは 1 件も無かった。** `environment` はすべて `Production` 系で、
staging / preview 相当のレコードは無かった。

3 リポジトリはいずれも 2022〜2023 年に直近 push があり、**active（90 日以内）ではない**。
つまり「Deployments API に実際に痕跡があるのは、今は動いていない古い個人プロジェクトの
Vercel 連携だけ」という結果になった。

### 1.3 実 CD ワークフローの中身（`cloudflare-learning`）

active リポジトリの中で唯一「本番へのデプロイを行う CD」を持っていたのが
`cloudflare-learning` の `.github/workflows/deploy.yml`。内容を確認した
（`gh api /repos/ymiyamoto63/cloudflare-learning/contents/.github/workflows/deploy.yml`）。

```yaml
- name: Deploy
  if: env.CLOUDFLARE_API_TOKEN != ''
  uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    workingDirectory: hono-app
```

`gitHubToken` パラメータを渡していない。後述の通り `wrangler-action` は `gitHubToken` を
渡した場合のみ GitHub Deployments を作る仕様であり、このリポジトリの実測件数 0 と整合する。
**「実際に使われている CD 構成では Deployments API のレコードが作られない」ことを、
ドキュメントだけでなく実物のワークフローと実測件数の両方で確認できた。**

## 2. 連携サービスが Deployments API を自動生成するか（ドキュメント調査）

| サービス / Action | Deployments API を作るか | 条件 | 出典 |
| --- | --- | --- | --- |
| Vercel（GitHub 連携） | **作る** | デフォルトで有効（opt-in 不要）。本調査で実測済み（1.2 参照） | 本調査の実測（`vercel[bot]` によるレコード） |
| `cloudflare/wrangler-action`（Workers / Pages） | **作らない（既定）** | `gitHubToken` パラメータを渡した場合のみ作る（opt-in） | https://github.com/cloudflare/wrangler-action README |
| `cloudflare/pages-action` | **作らない（既定）** | 同上。`gitHubToken` を渡すとデプロイ前に Deployment を作成し、完了後に status を更新する | https://github.com/marketplace/actions/deploy-to-cloudflare-pages / https://deepwiki.com/cloudflare/pages-action/3.4-github-deployment-integration |
| `actions/deploy-pages`（GitHub Pages） | **作る（既定）** | `github-pages` という環境名で Deployment を作成。環境が無ければ自動作成される。GitHub 公式の標準ワークフローに組み込み | https://github.com/actions/deploy-pages |
| AWS Amplify Hosting（GitHub App 連携） | **未確認・ドキュメントからは判断できず** | ビルドトリガーは webhook 経由と確認できたが、Deployments API を使っているという明確な記述は見つからなかった。account 内に Amplify 連携リポジトリが無く実機確認もできない | https://github.com/aws-amplify/amplify-hosting/blob/main/FAQ.md ほか（Amplify Hosting のドキュメント。Deployments API への直接言及は無し） |

**Cloudflare 系は 2 つとも「既定では作らない・opt-in」という共通点がある。** これは
ADR-0001 の「Workers へのデプロイも既定では GitHub Deployments を生成しない」という記述と
一致し、かつ今回 `cloudflare-learning` の実ワークフローと実測件数（0 件）で裏付けられた。

**Vercel は既定で作る。** ただし対象アカウントでの実例は 2022〜2023 年の個人プロジェクトに
限られ、現在の active リポジトリではいずれも使われていない。

**GitHub Pages（`actions/deploy-pages`）は既定で作る。** ADR-0001 は GitHub Pages を
検討対象に含めていなかったが、#22 のサンプルリポジトリの CD が仮に GitHub Pages への
デプロイであれば、Deployments API のレコードが自動的に手に入る可能性がある（次節）。

## 3. #22（サンプルリポジトリ）は未着手 — 何を確かめればよいか

#22 は本調査時点で未着手（`gh issue view 22` で state: OPEN、実体なし）。実物での検証は
できないため、#22 を作る際に次を確認する手順として残す。

1. **サンプルリポジトリの CD に何を使うか決める段階で、Deployments API を作るかどうかは
   設計の選択肢であることを踏まえる。** 上記の表の通り、`actions/deploy-pages` を使えば
   何もしなくても Deployments が作られる。`wrangler-action` / `pages-action` を使うなら
   `gitHubToken` を渡すかどうかで作る／作らないを選べる。
2. #22 の CD を実装したら、`gh api /repos/{owner}/four-keys-sample-service/deployments`
   で実際にレコードが作られているか確認する。
3. レコードがあれば、`environment` / `created_at` / `creator` / `performed_via_github_app`
   の実際の値を確認し、`deployment_status` の `state`（`success` 等）と紐づく `created_at`
   が「デプロイ時刻」として使える粒度・精度か検証する。
4. ADR-0001 の制約どおり、Deployments の日時は過去日付で作れないため、#22 の
   **合成履歴（過去日付側）では検証できない。本物の CD が実行された分だけしか検証できない**
   （`workflow_run` ルールと同じ制約）。1 年分のデータでの検証はできないことを前提に、
   「直近数件のレコードが期待通りの形で取れるか」レベルの確認にとどめる。

## 4. 実装する場合の注意（今回は実装しないが、将来 着手する場合のために記録）

- **OR 合成は引き続き禁止**（ADR-0001 決定 1）。`deployments_api` を追加しても
  1 スコープ 1 ルールの原則は崩さない。既存の `default_branch` / `workflow_run` と並ぶ
  3 つ目の選択肢として追加する形にする。
- Deployments の日時は過去日付で作れないため、`workflow_run` と同様に
  **サンプルリポジトリの実データでしか検証できない**（3 節参照）。
- `creator` が連携サービスのボット（`vercel[bot]` 等）かどうかを判定に使う場合、
  `performed_via_github_app` は `null` になりうる（Vercel はアプリとしてではなく
  ボットユーザーとして記録する）ことを踏まえて判定ロジックを組む必要がある。
- `environment` の値はサービスごとに揺れる（`Production` / `Production – <project>` など）。
  完全一致ではなく前方一致 or 設定可能な文字列マッチが必要になりそうだが、これは
  実装時に #22 の実データで再検証すること。

## 5. ADR-0001 への追記案（下書き。ADR ファイル自体は未編集）

新しい ADR は起こさない。**判断（`deployments_api` を保留する）は変わっていない**ため、
ADR-0001 の「結果・影響」節末尾に以下の追記を提案する。

```markdown
### 追記 (2026-09-20, spike #26)

`docs/spikes/0026-deployments-api.md` で Deployments API の実態を実測した。対象アカウントの
active な 8 リポジトリは Deployments API レコードが 0/8。全 36 リポジトリでも保有するのは
3 件のみで、いずれも 2022〜2023 年の Vercel 連携による自動生成であり、現在 active な用途とは
無関係。account 内で唯一 Cloudflare Workers へ実デプロイしている `cloudflare-learning` は
`cloudflare/wrangler-action` を GitHub Deployments 連携なしで使っており、これは仕様上
レコードを作らない。**「保留」の判断は実測によって裏付けられたため維持する。**
再検証が必要になるのは、#22 のサンプルリポジトリで Deployments API を作る CD
（`actions/deploy-pages` 等）を採用した場合のみ。
```

## 6. この調査の限界

- レート制限は消費していない（`gh api rate_limit` で 5000/5000 残存を確認済み）ため、
  今回はリポジトリ全件を確認できたが、対象アカウントの規模でしか検証していない。
  他アカウント・組織リポジトリでの Deployments API 利用実態は未調査。
- Deployments API のレコードが 0 件の 33 リポジトリについて、`deployment_status`
  サブリソースは確認していない（親の Deployments が 0 件ならサブリソースも存在しないため）。
- AWS Amplify については実機・実リポジトリでの確認ができず、ドキュメントからも
  明確な結論を得られなかった。対象アカウントで Amplify を使う予定がない限り優先度は低い。
- `pages-action` / `actions/deploy-pages` の挙動はドキュメントベースの確認であり、
  実際のレコード形状（`environment` 名や `created_at` の粒度）は #22 で実物を見るまで未確定。

## 参照

- https://github.com/cloudflare/wrangler-action（README、`gitHubToken` パラメータの説明）
- https://github.com/marketplace/actions/deploy-to-cloudflare-pages
- https://deepwiki.com/cloudflare/pages-action/3.4-github-deployment-integration
- https://github.com/actions/deploy-pages
- https://github.com/aws-amplify/amplify-hosting/blob/main/FAQ.md
- `docs/adr/0001-deploy-detection-rule.md`
- Issue #26 / Issue #22
