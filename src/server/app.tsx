import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
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

  app.get("/healthz", (c) => {
    const row = db.prepare("select 1 as ok").get() as { ok: number } | undefined;
    return c.json({ status: row?.ok === 1 ? "ok" : "degraded" });
  });

  return app;
}
