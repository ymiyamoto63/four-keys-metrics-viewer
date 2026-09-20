import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { ChartPreview } from "./views/chart-preview.tsx";
import { Placeholder } from "./views/placeholder.tsx";

export function createApp(config: Config, db: Db): Hono {
  const app = new Hono();

  app.get("/", (c) =>
    c.html(
      <Placeholder
        databasePath={config.databasePath}
        collectCron={config.collectCron}
        githubTokenPresent={config.githubToken !== undefined}
      />,
    ),
  );

  // 合成データでチャートの描画を確認するための経路（#19）。本番の画面は #20 / #21 で作る。
  app.get("/_preview/chart", (c) => c.html(<ChartPreview />));

  app.get("/healthz", (c) => {
    const row = db.prepare("select 1 as ok").get() as { ok: number } | undefined;
    return c.json({ status: row?.ok === 1 ? "ok" : "degraded" });
  });

  return app;
}
