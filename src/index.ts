import { serve } from "@hono/node-server";
import { type Config, ConfigError, isLoopback, loadConfig } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { patAuth } from "./github/auth.ts";
import { createGitHubClient, type GitHubClient } from "./github/client.ts";
import { logger } from "./logger.ts";
import { startScheduler } from "./scheduler/index.ts";
import { describeDeployRule, loadScopes, type Scope } from "./scopes.ts";
import { createApp } from "./server/app.tsx";

function main(): void {
  let config: Config;
  let scopes: Scope[];
  try {
    config = loadConfig();
    // スコープ設定が不正なまま起動すると、画面には「デプロイ 0 件」が正常値として出る。
    // 指標の定義に関わる設定なので、黙って動かさずここで止める（ADR-0005）。
    scopes = loadScopes(config.scopesPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("設定が不正なため起動を中止する", { error: error.message });
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  logger.info("スコープ設定を読み込んだ", {
    path: config.scopesPath,
    scopes: scopes.map((scope) => ({
      id: scope.id,
      repo: `${scope.owner}/${scope.repo}`,
      deployRule: describeDeployRule(scope.deployRule),
      backfillDays: scope.backfillDays,
    })),
  });

  // GITHUB_TOKEN が無くても画面は開く（ADR-0006）。ただし収集は**黙って空振りさせない**。
  // クライアントを undefined のまま渡し、収集はスコープごとの失敗として記録される（#11）。
  let client: GitHubClient | undefined;
  if (config.githubToken) {
    client = createGitHubClient({ auth: patAuth(config.githubToken) });
  } else {
    logger.warn("GITHUB_TOKEN が未設定です。画面は開きますが収集は失敗として記録されます", {
      hint: ".env に GITHUB_TOKEN を設定してください",
    });
  }

  const db = openDatabase(config.databasePath);
  const scheduler = startScheduler({ config, db, scopes, client });
  // 画面はスコープ設定を唯一の正とする（ADR-0005）。DB に居るが設定に無いスコープは表示しない。
  const app = createApp({ config, db, scopes });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info("HTTP サーバーを開始した", {
      url: `http://${config.host}:${info.port}`,
      loopbackOnly: isLoopback(config.host),
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("終了処理を開始した", { signal });
    server.close(() => {
      void scheduler.stop().then(() => {
        db.close();
        logger.info("終了した");
        process.exit(0);
      });
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
