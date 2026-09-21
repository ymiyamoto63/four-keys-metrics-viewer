/**
 * 生成の統合テスト（#22）。**実際に git を回す。**
 *
 * `plan.test.ts` が計画の中身を守るのに対し、ここが守るのは
 * 「計画どおりの git 履歴が本当に出来るか」である。両方要るのは、合成履歴の肝が
 * **git 側の都合**（`GIT_COMMITTER_DATE` が効くか、`--no-ff` で merge commit が残るか、
 * 放置ブランチの merge が競合しないか）にあり、そこは純粋関数では確かめられないため。
 *
 * 検証は `src/deploy/default-branch.ts` の検出ルールをそのまま通す。生成側で
 * 「merge commit を数え直す」コードを書くと、検出ルールの定義が 2 つになる。
 *
 * 週数は既定（53）ではなく小さくして回す。git を数百回呼ぶと遅く、ここで確かめたいのは
 * 「git 側の都合」であって週数ではない。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DeployCandidateCommit,
  detectDefaultBranchDeployments,
} from "../deploy/default-branch.ts";
import { parseInstant, weekOf } from "../metrics/week.ts";
import { DEPLOY_WORKFLOW_FILENAME } from "./files.ts";
import { generate, parseArgs } from "./generate.ts";
import { type PlannedMerge, planSampleHistory } from "./plan.ts";

const NOW = "2026-09-20T04:00:00.000Z";
const WEEKS = 10;
const SEED = 20260920;

let repo: string;

/**
 * 読み出したコミット。検出ルールの入力（`DeployCandidateCommit`）に author date を足したもの。
 * author date は検出には使わないが、「両方の日付を固定できているか」の検証に要る。
 */
type LoggedCommit = DeployCandidateCommit & { authoredAt: string };

/** デフォルトブランチのコミットを古い順に読む。検出ルールの入力そのもの。 */
function defaultBranchCommits(): LoggedCommit[] {
  const log = execFileSync("git", ["log", "--reverse", "--format=%H|%cI|%aI|%P"], {
    cwd: repo,
    encoding: "utf8",
  });
  return log
    .trim()
    .split("\n")
    .map((line) => {
      const [sha, committedAt, authoredAt, parents] = line.split("|");
      return {
        sha: sha ?? "",
        committedAt: new Date(committedAt ?? "").toISOString(),
        authoredAt: new Date(authoredAt ?? "").toISOString(),
        parentShas: (parents ?? "").split(" ").filter((value) => value.length > 0),
      };
    });
}

beforeAll(() => {
  repo = join(mkdtempSync(join(tmpdir(), "sample-repo-")), "repo");
  generate({
    ...parseArgs(["--out", repo]),
    now: NOW,
    weeks: WEEKS,
    seed: SEED,
  });
}, 120_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("generate", () => {
  it("最小アプリと CD ワークフローを置く", () => {
    expect(readFileSync(join(repo, "package.json"), "utf8")).toContain("four-keys-sample-service");
    // ワークフロー名は scopes.toml の workflow_run.workflow と一致していないと検出されない。
    const workflow = readFileSync(
      join(repo, ".github/workflows", DEPLOY_WORKFLOW_FILENAME),
      "utf8",
    );
    expect(workflow).toContain("on:\n  push:\n    branches: [main]");
  });

  it("CD が走らせるコマンドがそのまま通る（実行してみる）", () => {
    // ここを机上で済ませない理由: `npm test` のコマンドを 1 つ間違えるだけで CD が
    // 毎回赤くなり、`workflow_run` ルールは成功実行だけを数える（`isDeployRun`）ので
    // デプロイ 0 件になる。サンプルリポジトリが #23 の半分を検証できなくなるが、
    // 症状は「グラフが空」なので、収集側のバグと区別が付かない。
    const run = (script: string) =>
      execFileSync("npm", ["run", "--silent", script], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
      });

    // deploy.yml の test ジョブ / deploy ジョブが叩くのと同じスクリプト。
    expect(() => run("test")).not.toThrow();
    expect(run("build")).toContain("built dist/index.html");
  }, 120_000);

  it("生成先が空でなければ中断する", () => {
    // 既存の履歴の上に 500 件を重ねると、どこまでが生成物か分からなくなる。
    expect(() =>
      generate({ ...parseArgs(["--out", repo]), now: NOW, weeks: WEEKS, seed: SEED }),
    ).toThrow(/生成先が空ではありません/);
  });

  it("--out を省略したら落とす", () => {
    expect(() => parseArgs([])).toThrow(/--out は必須です/);
  });
});

describe("生成された git 履歴", () => {
  it("committer date が過去日付になっている（合成履歴の前提）", () => {
    const commits = defaultBranchCommits();
    const oldest = commits[0];
    expect(oldest).toBeDefined();
    // 10 週分なので、最古のコミットは基準時刻より 9 週以上前にあるはず。
    const weeksBack =
      (parseInstant(NOW) - parseInstant(oldest?.committedAt ?? NOW)) / (7 * 24 * 60 * 60 * 1000);
    expect(weeksBack).toBeGreaterThan(WEEKS - 2);
  });

  it("author date と committer date が一致する", () => {
    // 片方だけ生成時刻のまま残ると「author date は使わない」という決定を確かめられない。
    for (const commit of defaultBranchCommits()) {
      expect(commit.authoredAt).toBe(commit.committedAt);
    }
  });

  it("merge commit が残っている（--no-ff が効いている）", () => {
    // fast-forward されると merge commit が消え、merge_only のデプロイが 0 件になる。
    const deployments = detectDefaultBranchDeployments(defaultBranchCommits(), "merge_only");
    expect(deployments.length).toBeGreaterThan(0);
  });

  it("検出されるデプロイが計画の merge 件数と一致する", () => {
    const planned = planSampleHistory({ now: NOW, weeks: WEEKS, seed: SEED });
    const plannedMerges = planned.changes.filter(
      (change): change is PlannedMerge => change.kind === "merge",
    );
    const detected = detectDefaultBranchDeployments(defaultBranchCommits(), "merge_only");
    expect(detected).toHaveLength(plannedMerges.length);
    expect(detected.map((deployment) => deployment.deployedAt).sort()).toEqual(
      plannedMerges.map((merge) => merge.merge.committedAt).sort(),
    );
  });

  it("計画した欠損週には本当にデプロイが無い", () => {
    const planned = planSampleHistory({ now: NOW, weeks: WEEKS, seed: SEED });
    const detected = detectDefaultBranchDeployments(defaultBranchCommits(), "merge_only");
    const deployedWeeks = new Set(detected.map((deployment) => weekOf(deployment.deployedAt).key));

    const plannedEmpty = planned.weeks.filter((week) => week.mergeCount === 0);
    expect(plannedEmpty.length).toBeGreaterThan(0);
    for (const week of plannedEmpty) {
      expect(deployedWeeks.has(week.week.key)).toBe(false);
    }
  });

  it("放置ブランチの merge が競合せずに積まれる", () => {
    // 1 コミット = 1 新規ファイル（files.ts）にしてある理由がここ。競合すると生成が止まる。
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(status.trim()).toBe("");
    const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], {
      cwd: repo,
      encoding: "utf8",
    });
    // feature ブランチは merge 後に削除してある。main だけが残る。
    expect(branches.trim()).toBe("main");
  });
});
