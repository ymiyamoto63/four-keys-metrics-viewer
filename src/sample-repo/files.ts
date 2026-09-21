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
 * 本物の CD ワークフロー。**main への push で走り、GitHub Pages へ実際にデプロイする。**
 *
 * ## なぜ本物のデプロイ先が要るか
 *
 * `workflow_run` ルールは「指定したワークフローの成功実行」をデプロイとみなす
 * （ADR-0001 決定 2）。成功実行さえ積めれば形式的には検証できるが、中身が空の
 * ワークフローだと「デプロイしていないのにデプロイと数えた」状態を作ることになり、
 * サンプルリポジトリが検証したい「本物の CD の形」から外れる。Pages は secret 不要で
 * 実際に Deployments と Releases 相当の痕跡が残るため、保留にした `deployments_api`
 * ルール（`docs/spikes/0026-deployments-api.md`）を将来調べ直すときの材料にもなる。
 *
 * ## `enablement: true` を付けてある理由
 *
 * Pages が未設定のリポジトリでは `deploy-pages` が失敗する。失敗実行は
 * `isDeployRun`（`src/deploy/workflow-run.ts`）が弾くのでデプロイ 0 件になり、
 * `workflow_run` ルールの E2E（#23）が「アプリのバグなのか設定漏れなのか」
 * 分からない状態で止まる。`configure-pages` に有効化を任せて、手作業の前提を減らす。
 * それでも有効化できない場合は Settings → Pages → Source を GitHub Actions にする。
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
  pages: write
  id-token: write

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
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - run: npm run build
      - uses: actions/configure-pages@v5
        with:
          enablement: true
      - uses: actions/upload-pages-artifact@v4
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
`;

const GITIGNORE = `node_modules/
dist/
`;

const README = `# four-keys-sample-service

\`four-keys-metrics-viewer\` の E2E 検証用サンプルリポジトリ。**本番用途ではない。**

## これは何か

- **最小アプリ** — \`features/\` を走査して一覧を返すだけの Node HTTP サーバー。依存ゼロ
- **本物の CD** — \`.github/workflows/deploy.yml\`。main への push で GitHub Pages へ実際にデプロイする
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
