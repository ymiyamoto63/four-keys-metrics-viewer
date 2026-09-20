/**
 * ストア → `MetricsInput` の詰め替え（#20）。
 *
 * ここが守るのは「指標計算へ渡してよいものだけを渡す」こと。取りこぼすと標本が黙って欠け、
 * 画面上は正常な数値に見えてしまう（ADR-0004 が時刻順近似を却下した理由と同じ壊れ方）。
 */

import { describe, expect, it } from "vitest";
import { saveDeployment } from "../db/store.ts";
import { openTestDatabase } from "../db/testing.ts";
import { buildMetricsInput, loadScopeMetrics } from "./scope-metrics.ts";
import { seedScope, testScope } from "./testing.ts";

const PERIOD = { from: "2026-08-01T00:00:00Z", to: "2026-09-17T09:00:00Z" };
const NOW = new Date("2026-09-17T09:00:00Z");
const SCOPE = testScope();

describe("buildMetricsInput", () => {
  it("現在のデプロイ検出ルールのキーで読む", () => {
    const db = openTestDatabase();
    seedScope(db, {
      scope: SCOPE,
      deployments: [{ sha: "d1", deployedAt: "2026-08-12T02:00:00Z" }],
    });
    // 別のルールで検出した行が残っていても、混ぜて数えない（CONTEXT.md「デプロイは
    // 検出ルールに対して相対的」）。
    saveDeployment(db, {
      scopeId: SCOPE.id,
      detectionRule: "workflow_run:deploy.yml",
      commitSha: "w1",
      deployedAt: "2026-08-12T03:00:00Z",
      raw: {},
    });

    const input = buildMetricsInput(db, SCOPE, PERIOD);

    expect(input.detectionRule).toBe("default_branch:merge_only");
    expect(input.deployments.map((d) => d.commitSha)).toEqual(["d1"]);
  });

  it("compare 未取得（pending）と最古のデプロイ（oldest）は標本にしない", () => {
    const db = openTestDatabase();
    seedScope(db, {
      scope: SCOPE,
      deployments: [
        // 最古 = base が決められない（oldest）
        { sha: "d0", deployedAt: "2026-08-05T02:00:00Z" },
        // compare 済み（assigned）
        { sha: "d1", deployedAt: "2026-08-12T02:00:00Z", commitShas: ["c1"] },
        // compare 未取得（pending）
        { sha: "d2", deployedAt: "2026-08-19T02:00:00Z" },
      ],
      commits: [{ sha: "c1", committedAt: "2026-08-10T02:00:00Z" }],
    });

    const input = buildMetricsInput(db, SCOPE, PERIOD);

    expect(input.deployments).toHaveLength(3);
    expect(input.deployCommits).toEqual([
      { deploymentCommitSha: "d1", baseSha: "d0", commitShas: ["c1"], truncated: false },
    ]);
  });

  it("収集カーソルが無ければカバレッジは「どの週も未収集」", () => {
    const db = openTestDatabase();
    seedScope(db, { scope: SCOPE, deployments: [] });

    const input = buildMetricsInput(db, SCOPE, PERIOD);

    expect(input.coverage).toEqual({
      backfilledUntil: null,
      backfillComplete: false,
      lastSuccessAt: null,
    });
  });

  it("収集カーソルをそのままカバレッジへ渡す", () => {
    const db = openTestDatabase();
    seedScope(db, {
      scope: SCOPE,
      deployments: [],
      cursor: {
        backfilledUntil: "2026-06-01T00:00:00Z",
        backfillComplete: true,
        lastSuccessAt: "2026-09-17T06:00:00Z",
      },
    });

    const input = buildMetricsInput(db, SCOPE, PERIOD);

    expect(input.coverage).toEqual({
      backfilledUntil: "2026-06-01T00:00:00Z",
      backfillComplete: true,
      lastSuccessAt: "2026-09-17T06:00:00Z",
    });
  });
});

describe("loadScopeMetrics", () => {
  it("2 指標と収集状態を同じスコープ・同じ期間で返す", () => {
    const db = openTestDatabase();
    seedScope(db, {
      scope: SCOPE,
      deployments: [
        { sha: "d0", deployedAt: "2026-08-05T02:00:00Z" },
        { sha: "d1", deployedAt: "2026-08-12T02:00:00Z", commitShas: ["c1"] },
      ],
      commits: [{ sha: "c1", committedAt: "2026-08-10T02:00:00Z" }],
      cursor: { backfilledUntil: "2026-06-01T00:00:00Z", lastSuccessAt: "2026-09-17T06:00:00Z" },
    });

    const metrics = loadScopeMetrics(db, SCOPE, PERIOD, NOW);

    expect(metrics.deployFrequency.scopeId).toBe(SCOPE.id);
    expect(metrics.leadTime.scopeId).toBe(SCOPE.id);
    expect(metrics.deployFrequency.detectionRule).toBe("default_branch:merge_only");
    expect(metrics.leadTime.detectionRule).toBe("default_branch:merge_only");
    // 週の並びは両指標で揃っている（同じ `period` から作られる）。
    expect(metrics.deployFrequency.weeks.map((w) => w.week.key)).toEqual(
      metrics.leadTime.weeks.map((w) => w.week),
    );
    expect(metrics.collection.lastSuccessAt).toBe("2026-09-17T06:00:00Z");
  });
});
