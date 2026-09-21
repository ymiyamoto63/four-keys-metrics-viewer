/**
 * アプリ内スケジューラのテスト（#11 / ADR-0007 決定 4）。
 *
 * タイマーはフェイク。収集の実体も差し替えるので、DB も GitHub も触らない。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionTrigger } from "../collector/index.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { startScheduler } from "./index.ts";

const HOUR = 60 * 60 * 1000;

const CONFIG: Config = {
  host: "127.0.0.1",
  port: 3000,
  databasePath: ":memory:",
  scopesPath: "./scopes.toml",
  githubToken: "dummy",
  collectCron: "0 * * * *",
  collectOnStartup: true,
};

/** スケジューラは収集を差し替えれば DB に触らない。 */
const DB = {} as Db;

function start(
  config: Partial<Config>,
  collect: (trigger: CollectionTrigger) => Promise<void>,
): ReturnType<typeof startScheduler> {
  return startScheduler({
    config: { ...CONFIG, ...config },
    db: DB,
    scopes: [],
    client: undefined,
    collect,
  });
}

beforeEach(() => {
  // cron 式が「毎時 0 分」なので、ちょうど 0 分に置いて時計を進める。
  vi.useFakeTimers({ now: new Date("2026-09-20T06:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("スケジューラ", () => {
  it("起動時に 1 回収集し、1 時間経過するともう 1 回走る", async () => {
    const triggers: CollectionTrigger[] = [];
    const scheduler = start({}, async (trigger) => {
      triggers.push(trigger);
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(triggers).toEqual(["startup"]);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(triggers).toEqual(["startup", "schedule"]);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(triggers).toEqual(["startup", "schedule", "schedule"]);

    await scheduler.stop();
  });

  it("COLLECT_ON_STARTUP が false なら起動時には走らない", async () => {
    const triggers: CollectionTrigger[] = [];
    const scheduler = start({ collectOnStartup: false }, async (trigger) => {
      triggers.push(trigger);
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(triggers).toEqual([]);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(triggers).toEqual(["schedule"]);

    await scheduler.stop();
  });

  it("前回の収集が継続中なら、今回の発火を見送る", async () => {
    let started = 0;
    let release: () => void = () => {};
    const scheduler = start({}, async () => {
      started += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(1);

    // 起動時の収集が終わらないうちに cron が 2 回発火する。
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(started).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(started).toBe(2);

    await scheduler.stop();
  });

  it("収集が失敗しても次の発火は止まらない（プロセスを落とさない）", async () => {
    let started = 0;
    const scheduler = start({}, async () => {
      started += 1;
      throw new Error("401 Bad credentials");
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HOUR);

    expect(started).toBe(2);

    await scheduler.stop();
  });

  it("cron 式が不正なら起動時に落とす（黙って既定に落ちない）", () => {
    expect(() => start({ collectCron: "毎時" }, async () => {})).toThrow(/COLLECT_CRON/);
  });
});
