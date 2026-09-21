import { type ScheduledTask, schedule, validate } from "node-cron";
import { type CollectionTrigger, runCollection } from "../collector/index.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { GitHubClient } from "../github/client.ts";
import { logger } from "../logger.ts";
import type { Scope } from "../scopes.ts";

export type Scheduler = {
  stop: () => Promise<void>;
};

export type SchedulerOptions = {
  config: Config;
  db: Db;
  /** 計測対象のスコープ一覧（#9。`scopes.toml` 由来）。 */
  scopes: readonly Scope[];
  /** GITHUB_TOKEN が未設定なら `undefined`。収集は失敗として記録される（#11）。 */
  client: GitHubClient | undefined;
  /** 収集サイクルの実体。テストから差し替えるための継ぎ目で、既定は `runCollection`。 */
  collect?: (trigger: CollectionTrigger) => Promise<void>;
};

/**
 * アプリ内スケジューラ（ADR-0007 決定 4）。
 * 起動時に 1 回追いつき、稼働中は cron 式に従って収集する。
 *
 * 常時稼働しない構成のため、起動時の追いつきが実質的な主経路になる。
 * 画面からの手動トリガは持たない（#11 で却下済み。起動 = 最新化にする）。
 */
export function startScheduler(options: SchedulerOptions): Scheduler {
  const { config, db, scopes, client } = options;
  if (!validate(config.collectCron)) {
    throw new Error(`COLLECT_CRON が cron 式として不正です: ${config.collectCron}`);
  }

  const collect =
    options.collect ??
    (async (trigger: CollectionTrigger) => {
      await runCollection({ db, scopes, client, trigger });
    });

  let running = false;

  const runOnce = async (trigger: CollectionTrigger): Promise<void> => {
    // 前回のサイクルが長引いている間に次が発火しても、重ねて走らせない。
    if (running) {
      logger.warn("前回の収集サイクルが継続中のため、今回の発火を見送る", { trigger });
      return;
    }
    running = true;
    try {
      await collect(trigger);
    } catch (error) {
      // 収集の失敗でプロセスを落とさない。
      logger.error("収集サイクルが失敗した", {
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const task: ScheduledTask = schedule(config.collectCron, () => {
    void runOnce("schedule");
  });

  logger.info("スケジューラを開始した", {
    cron: config.collectCron,
    collectOnStartup: config.collectOnStartup,
    scopes: scopes.length,
  });

  if (config.collectOnStartup) {
    void runOnce("startup");
  }

  return {
    stop: async () => {
      await task.destroy();
      logger.info("スケジューラを停止した");
    },
  };
}
