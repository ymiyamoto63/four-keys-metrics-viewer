/**
 * サンプルリポジトリを生成する（#22）。
 *
 *     npm run sample:generate -- --out ../four-keys-sample-service
 *
 * `plan.ts` の計画（純粋関数）を、実際の git 履歴として書き出す。ここは副作用だけを持つ:
 * ファイルを書き、`git` を呼ぶ。**何を積むかの判断は一切しない。**
 *
 * ## 過去日付の作り方
 *
 * `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` を環境変数で渡す。committer date は
 * git オブジェクトの一部なので過去日付で作れる（ADR-0001 / #22 の表）。両方に同じ値を
 * 入れるのは `plan.ts` の `PlannedCommit.committedAt` のコメントに書いた理由による。
 *
 * ## リモートへは push しない
 *
 * このスクリプトはローカルにリポジトリを作るところまでで止める。GitHub 上にリポジトリを
 * 作って push するのは外向きの不可逆な操作なので、人が明示的に行う
 * （手順は `docs/sample-repo.md`）。生成を何度でもやり直せることのほうが、
 * ここで自動化して得られる手間の削減より価値が大きい。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../logger.ts";
import { featureFile, SAMPLE_FILES, type SampleFile } from "./files.ts";
import { DEFAULT_WEEKS, type PlannedCommit, planSampleHistory } from "./plan.ts";

export type Options = {
  /** 生成先ディレクトリ。空でなければ中断する。 */
  out: string;
  /** 基準時刻。既定は現在時刻。 */
  now: string;
  weeks: number;
  seed: number;
  /** デフォルトブランチ名。 */
  branch: string;
  /** git に渡す author / committer。 */
  authorName: string;
  authorEmail: string;
};

export function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`引数 ${arg} に値がありません`);
    }
    values.set(arg.slice(2), next);
    index += 1;
  }

  const out = values.get("out");
  if (out === undefined) {
    throw new Error(
      "--out は必須です（例: npm run sample:generate -- --out ../four-keys-sample-service）",
    );
  }

  return {
    out: resolve(out),
    now: values.get("now") ?? new Date().toISOString(),
    weeks: Number(values.get("weeks") ?? DEFAULT_WEEKS),
    seed: Number(values.get("seed") ?? 20260920),
    branch: values.get("branch") ?? "main",
    authorName: values.get("author-name") ?? "four-keys-sample-bot",
    authorEmail: values.get("author-email") ?? "sample@example.invalid",
  };
}

/** リポジトリを生成する。戻り値は積んだコミット数。 */
export function generate(options: Options): { commits: number; deployments: number } {
  prepareDirectory(options.out);

  const plan = planSampleHistory({ now: options.now, weeks: options.weeks, seed: options.seed });
  const git = gitRunner(options);

  git(["init", "-b", options.branch, "--quiet"]);
  // 生成の再現性のため、実行環境の git 設定に依存させない。
  git(["config", "user.name", options.authorName]);
  git(["config", "user.email", options.authorEmail]);
  git(["config", "commit.gpgsign", "false"]);

  // 初期コミットは履歴の最古の週の直前に置く。ここが compare の底になる。
  const initialAt = new Date(Date.parse(plan.period.from) - 60 * 60 * 1000).toISOString();
  writeFiles(options.out, SAMPLE_FILES);
  git(["add", "--all"]);
  commit(git, {
    id: "init",
    message: "chore: 最小アプリと CD ワークフローを置く",
    committedAt: initialAt,
  });

  let commits = 1;
  let deployments = 0;
  // 週ごとのデフォルトブランチ先端。放置ブランチを「本当に古い地点」から生やすために持つ。
  const tipByWeekIndex: string[] = [];
  const weekIndexByKey = new Map(plan.weeks.map((week, index) => [week.week.key, index]));

  let currentWeekIndex = 0;
  for (const change of plan.changes) {
    const weekIndex = weekIndexByKey.get(change.weekKey) ?? 0;
    // 週が進んだら、その手前までの先端を記録しておく。
    while (currentWeekIndex < weekIndex) {
      tipByWeekIndex[currentWeekIndex] = git(["rev-parse", "HEAD"]).trim();
      currentWeekIndex += 1;
    }

    if (change.kind === "direct_push") {
      writeFiles(options.out, [featureFile(change.commit.id, change.commit.message)]);
      git(["add", "--all"]);
      commit(git, change.commit);
      commits += 1;
      continue;
    }

    const baseIndex = weekIndex - change.branchFromWeeksAgo;
    const base = change.branchFromWeeksAgo > 0 ? tipByWeekIndex[baseIndex] : undefined;
    git(["switch", "--quiet", "--create", change.branch, ...(base ? [base] : [])]);
    for (const branchCommit of change.commits) {
      writeFiles(options.out, [featureFile(branchCommit.id, branchCommit.message)]);
      git(["add", "--all"]);
      commit(git, branchCommit);
      commits += 1;
    }
    git(["switch", "--quiet", options.branch]);
    // `--no-ff` を外すと fast-forward して merge commit が消え、merge_only のデプロイが 0 件になる。
    git(
      ["merge", "--no-ff", "--no-edit", "-m", change.merge.message, change.branch],
      dateEnv(change.merge.committedAt),
    );
    git(["branch", "--quiet", "--delete", change.branch]);
    commits += 1;
    deployments += 1;
  }

  logger.info("サンプルリポジトリを生成した", {
    out: options.out,
    branch: options.branch,
    weeks: plan.weeks.length,
    period: plan.period,
    commits,
    deployments,
    anomalies: plan.weeks
      .filter((week) => week.anomalies.length > 0)
      .map((week) => ({ week: week.week.key, anomalies: week.anomalies, notes: week.notes })),
  });

  return { commits, deployments };
}

/**
 * 生成先を用意する。**既存の中身がある場合は中断する。**
 *
 * 生成は 500 件規模のコミットを積む。既存リポジトリの上に重ねると、どこまでが生成物で
 * どこからが元の履歴か分からなくなる。上書きの判断は人に委ねる。
 */
function prepareDirectory(out: string): void {
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(
      `生成先が空ではありません: ${out}（既存の履歴を壊さないため中断します。` +
        "別のディレクトリを指定するか、中身を削除してください)",
    );
  }
  mkdirSync(out, { recursive: true });
}

function writeFiles(out: string, files: readonly SampleFile[]): void {
  for (const file of files) {
    const path = join(out, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents);
  }
}

type Git = (args: readonly string[], env?: NodeJS.ProcessEnv) => string;

function gitRunner(options: Options): Git {
  return (args, env) =>
    execFileSync("git", args, {
      cwd: options.out,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
}

function commit(git: Git, planned: PlannedCommit): void {
  git(["commit", "--quiet", "-m", planned.message], dateEnv(planned.committedAt));
}

/** author date と committer date の両方を固定する。ここが合成履歴の肝（冒頭コメント）。 */
function dateEnv(committedAt: string): NodeJS.ProcessEnv {
  return { GIT_AUTHOR_DATE: committedAt, GIT_COMMITTER_DATE: committedAt };
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = generate(options);
    logger.info("完了", {
      next: "docs/sample-repo.md の「GitHub へ push する」へ進む",
      ...result,
    });
  } catch (error) {
    logger.error("サンプルリポジトリの生成に失敗した", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
