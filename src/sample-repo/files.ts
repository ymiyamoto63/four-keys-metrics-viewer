/**
 * サンプルリポジトリに置く**最小アプリと本物の CD ワークフロー**の中身（#22）。
 *
 * 文字列定数だけを持つ。書き出すのは `generate.ts`。
 *
 * ## なぜ「最小」なのか
 *
 * サンプルリポジトリの用途は E2E（GitHub API のレスポンス形の確認）に限定する
 * （ADR-0004 / #23）。アプリの中身は指標に一切影響しない——効くのは
 * 「コミットとマージコミットがどう積まれたか」と「CD の成功実行があるか」だけである。
 * 依存ゼロ・Node 標準ライブラリだけにしてあるのは、サンプル側のビルドが壊れて
 * CD が赤くなると `workflow_run` ルールの検証（成功実行をデプロイとして数える）が
 * 止まるためで、手抜きではなく検証を止めないための選択である。
 *
 * ## なぜ 1 コミット = 1 新規ファイルなのか
 *
 * 合成履歴では 500 件規模のコミットを積み、その多くがブランチ上で並行する
 * （放置ブランチは 12 週前から生える）。既存ファイルを編集する形にすると merge が競合し、
 * 生成が途中で止まる。コミットごとに `features/<id>.js` を新規作成すれば競合は起きない。
 * アプリ側はこのディレクトリを実行時に走査するので、増えたファイルはそのまま機能になる。
 */

/** `deploy.yml` のファイル名。`scopes.toml` の `workflow_run.workflow` と一致させる。 */
export const DEPLOY_WORKFLOW_FILENAME = "deploy.yml";

export type SampleFile = {
  /** リポジトリルートからの相対パス。 */
  path: string;
  contents: string;
};

const SERVER_JS = `#!/usr/bin/env node
// 最小アプリ。features/ 配下のモジュールを読み込んで一覧を返すだけの HTTP サーバー。
import { createServer } from "node:http";
import { loadFeatures } from "./features.mjs";

const port = Number(process.env.PORT ?? 3000);

const server = createServer(async (request, response) => {
  const features = await loadFeatures();
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", features: features.length }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ features }, null, 2));
});

server.listen(port, () => {
  console.log(\`listening on http://127.0.0.1:\${port}\`);
});
`;

const FEATURES_JS = `// features/ 配下のモジュールを走査して名前を集める。
// 合成履歴のコミットは 1 件につき features/ に 1 ファイルを足すので、
// ここを通してアプリの機能として実際に読み込まれる。
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const featuresDir = join(dirname(fileURLToPath(import.meta.url)), "features");

export async function loadFeatures() {
  let entries = [];
  try {
    entries = await readdir(featuresDir);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return [];
  }

  const features = [];
  for (const entry of entries.filter((name) => name.endsWith(".js")).sort()) {
    const module = await import(pathToFileURL(join(featuresDir, entry)).href);
    features.push({ id: entry.replace(/\\.js$/, ""), label: module.label ?? entry });
  }
  return features;
}
`;

const SMOKE_TEST_JS = `// CD が本当にアプリを検証していること。node --test で走る。
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFeatures } from "../features.mjs";

test("features/ を走査できる", async () => {
  const features = await loadFeatures();
  assert.ok(Array.isArray(features));
  for (const feature of features) {
    assert.equal(typeof feature.id, "string");
  }
});
`;

const BUILD_SITE_JS = `// デプロイする成果物（静的サイト）を dist/ に作る。
import { mkdir, writeFile } from "node:fs/promises";
import { loadFeatures } from "../features.mjs";

const features = await loadFeatures();
await mkdir("dist", { recursive: true });
await writeFile(
  "dist/index.html",
  \`<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8"><title>four-keys-sample-service</title></head>
  <body>
    <h1>four-keys-sample-service</h1>
    <p>features: \${features.length}</p>
    <p>deployed at: \${new Date().toISOString()}</p>
  </body>
</html>
\`,
);
console.log(\`built dist/index.html (features: \${features.length})\`);
`;

const PACKAGE_JSON = `{
  "name": "four-keys-sample-service",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "start": "node server.mjs",
    "test": "node --test",
    "build": "node scripts/build-site.mjs"
  }
}
`;

/**
 * 本物の CD ワークフロー。**main への push で走り、GitHub Deployment を実際に記録する。**
 *
 * ## なぜ GitHub Pages をやめたか
 *
 * 当初は Pages へデプロイしていたが、**private リポジトリの Pages は有料プランでしか使えない。**
 * 実際に #22 で作ったサンプルリポジトリ（private）では `actions/configure-pages` が
 * `Create Pages site failed. Error: Resource not accessible by integration` で落ち、
 * CD の成功実行が 0 件になった。
 *
 * これは単に赤いだけでは済まない。`workflow_run` ルールは成功実行だけを数えるので
 * （`src/deploy/workflow-run.ts` の `isDeployRun`）、デプロイ 0 件になる。そして画面上の症状は
 * 「グラフが空」であり、**収集側のバグと区別が付かない。** サンプルリポジトリは
 * 「アプリが正しいか」を確かめる道具なので、道具側が黙って壊れているのが最悪の状態である。
 *
 * サンプルリポジトリは合成履歴（1 年分の実在しない開発）を持つため public にしづらい。
 * したがって**公開範囲に依存しないデプロイ先**を選ぶ必要がある。
 *
 * ## なぜ Deployments API なのか
 *
 * GitHub Deployments は「デプロイが起きた」ことを表す GitHub 自身の記録であり、
 * private リポジトリでも無料で作れる。成果物は artifact として実際に上げるので、
 * 「テストして、ビルドして、デプロイを記録する」という CD の形も保てる。
 *
 * 副次的な利点として、保留中の `deployments_api` ルール
 * （ADR-0001 決定 3 / `docs/spikes/0026-deployments-api.md`）を将来調べ直すときの
 * 実データがここに溜まる。Pages のままではこの材料は得られなかった。
 *
 * ## 落ちやすい箇所を減らしてある
 *
 * `required_contexts: []` を渡すのは、これを省くと GitHub が「このコミットのチェックが
 * 全部成功しているか」を見にいき、自分自身がまだ完了していないため 409 で落ちるため。
 * `auto_merge: false` を渡すのは、既定の `true` だとベースブランチへの自動マージを試み、
 * デプロイを作らずに 202 を返すことがあるため。
 */
const DEPLOY_WORKFLOW = `name: deploy

# デプロイ検出ルール workflow_run はこのワークフローの**成功実行**を 1 デプロイと数える。
# ファイル名を変えるときは scopes.toml の workflow も合わせて変えること。
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  # Deployment を記録するために要る。Pages は private + 無料プランでは使えないため使わない。
  deployments: write

# デプロイは直列にする。同時実行を取り消すと成功実行が積まれない。
concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - run: npm run build

      - uses: actions/upload-artifact@v4
        with:
          name: site
          path: dist

      - name: Deployment を記録する
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          # required_contexts: [] を渡さないと、GitHub がこのコミットのチェック完了を待ち、
          # 自分自身がまだ完了していないため 409 になる。
          # auto_merge: false を渡さないと、既定の true がベースへの自動マージを試みる。
          id=$(jq -nc --arg ref "$GITHUB_SHA" '{
                 ref: $ref,
                 environment: "production",
                 auto_merge: false,
                 required_contexts: [],
                 description: "four-keys-sample-service"
               }' \\
             | gh api --method POST "repos/$GITHUB_REPOSITORY/deployments" --input - --jq '.id')
          echo "deployment id: $id"
          jq -nc '{ state: "success", description: "deployed" }' \\
            | gh api --method POST "repos/$GITHUB_REPOSITORY/deployments/$id/statuses" \\
                --input - --jq '.state'
`;

const GITIGNORE = `node_modules/
dist/
`;

const README = `# four-keys-sample-service

\`four-keys-metrics-viewer\` の E2E 検証用サンプルリポジトリ。**本番用途ではない。**

## これは何か

- **最小アプリ** — \`features/\` を走査して一覧を返すだけの Node HTTP サーバー。依存ゼロ
- **本物の CD** — \`.github/workflows/deploy.yml\`。main への push でテスト → ビルド →
  GitHub Deployment の記録まで行う（private + 無料プランで Pages が使えないため Pages は使わない）
- **1 年分の合成履歴** — 過去日付のコミットとマージコミット。生成元は
  \`four-keys-metrics-viewer\` の \`src/sample-repo/\`

## なぜ合成履歴と本物の CD の両方があるか

GitHub のタイムスタンプには過去日付で作れるものと作れないものがある。コミットの
committer date は git オブジェクトの一部なので過去日付で作れるが、Actions の実行日時は
作れない。したがって**合成履歴だけでは \`workflow_run\` ルールを検証できず、本物の CD だけでは
1 年分の推移を検証できない**（\`four-keys-metrics-viewer\` の ADR-0004）。

## 履歴に意図的に含めてある異常ケース

「常に綺麗な線が出るテストデータ」にしないため、次を意図的に仕込んである。

- デプロイが 1 件も無い週（線が途切れることの確認）
- デプロイが 1 件しか無い週（中央値を出さない条件の確認）
- 長期間放置された branch の merge（リードタイムの外れ値）
- 同一時刻の複数デプロイ
- PR を経由しない直接 push

配置は \`four-keys-metrics-viewer\` の \`src/sample-repo/plan.ts\` の \`ANOMALIES\` が正であり、
そちらのユニットテストで検証している。

## 履歴の書き換えについて

合成履歴は生成し直すと**別のコミット SHA になる**。作り直す場合は force push になり、
\`four-keys-metrics-viewer\` 側の収集済みデータとは結び付かなくなる。作り直したら
収集側の DB も作り直すこと（\`docs/operations.md\` の復旧手順）。
`;

/** サンプルリポジトリの初期コミットに含めるファイル。 */
export const SAMPLE_FILES: readonly SampleFile[] = [
  { path: "package.json", contents: PACKAGE_JSON },
  { path: "server.mjs", contents: SERVER_JS },
  { path: "features.mjs", contents: FEATURES_JS },
  { path: "test/smoke.test.mjs", contents: SMOKE_TEST_JS },
  { path: "scripts/build-site.mjs", contents: BUILD_SITE_JS },
  { path: `.github/workflows/${DEPLOY_WORKFLOW_FILENAME}`, contents: DEPLOY_WORKFLOW },
  { path: ".gitignore", contents: GITIGNORE },
  { path: "README.md", contents: README },
];

/**
 * 合成履歴の 1 コミットが作るファイル。**必ず新規ファイル**（冒頭の理由）。
 */
export function featureFile(commitId: string, message: string): SampleFile {
  return {
    path: `features/${commitId}.js`,
    contents: `// ${message}\nexport const label = ${JSON.stringify(commitId)};\n`,
  };
}
