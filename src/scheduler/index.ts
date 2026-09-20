import { type ScheduledTask, schedule, validate } from "node-cron";
import { type CollectionTrigger, runCollection } from "../collector/index.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { logger } from "../logger.ts";

export type Scheduler = {
  stop: () => Promise<void>;
};

/**
 * アプリ内スケジューラ（ADR-0007 決定 4）。
 * 起動時に 1 回追いつき、稼働中は cron 式に従って収集する。
 *
 * 常時稼働しない構成のため、起動時の追いつきが実質的な主経路になる。
 */
export function startScheduler(config: Config, db: Db): Scheduler {
  if (!validate(config.collectCron)) {
    throw new Error(`COLLECT_CRON が cron 式として不正です: ${config.collectCron}`);
  }

  let running = false;

  const runOnce = async (trigger: CollectionTrigger): Promise<void> => {
    // 前回のサイクルが長引いている間に次が発火しても、重ねて走らせない。
    if (running) {
      logger.warn("前回の収集サイクルが継続中のため、今回の発火を見送る", { trigger });
      return;
    }
    running = true;
    try {
      await runCollection(db, trigger);
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
