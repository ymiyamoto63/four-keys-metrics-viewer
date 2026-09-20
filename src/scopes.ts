/**
 * スコープ設定ファイル（`scopes.toml`）の読み込みとバリデーション（ADR-0005）。
 *
 * スコープはテーブルではなくリポジトリ内の設定ファイルで管理する。狙いは運用の楽さではなく
 * **定義変更の履歴が PR に残ること**である（ADR-0005）。したがってここは
 * 「設定ファイルを唯一の正とし、起動時に読み、不正なら起動させない」だけを担う。
 * 書き込み経路も編集 UI も持たない。
 *
 * ## バリデーションを厳しくしている理由
 *
 * デプロイ検出ルールの指定を 1 つに強制するのは、ADR-0001 の「OR 合成禁止」を
 * **設定レベルで表現できないようにする**ためである。実行時に「2 つあったら先頭を使う」と
 * 黙って解決すると、二重計上こそ起きないものの「どのルールで数えたのか」が設定から読めなくなり、
 * `README.md` 柱 4（算出ロジックの開示）が崩れる。
 *
 * 未知のキーも同様に落とす。`backfil_days` のような綴り間違いを既定値で吸収すると、
 * 利用者は 1 年分を集めたつもりで別の範囲の指標を見ることになる。
 * 指標の定義に関わる設定は、黙って既定に落ちるより起動に失敗するほうが安全である。
 */

import { readFileSync } from "node:fs";
import { parse, TomlError } from "smol-toml";
import { ConfigError } from "./config.ts";

/** MVP で実装するデプロイ検出ルール（ADR-0001 決定 2）。 */
const DEPLOY_RULE_NAMES = ["default_branch", "workflow_run"] as const;

/** ADR-0001 決定 3 により保留。設定に書かれたら「未実装」と明示して落とす。 */
const DEFERRED_DEPLOY_RULE_NAMES = ["deployments_api"];

const GRANULARITIES = ["merge_only", "all_pushes"] as const;

export type DefaultBranchGranularity = (typeof GRANULARITIES)[number];

export type DeployRule =
  | { name: "default_branch"; granularity: DefaultBranchGranularity }
  | { name: "workflow_run"; workflow: string };

export type Scope = {
  /** スコープの識別子。DB の `scope_id` と画面の URL に使う。 */
  id: string;
  owner: string;
  repo: string;
  deployRule: DeployRule;
  /** バックフィル範囲（日数）。既定 1 年（ADR-0003 決定 5）。 */
  backfillDays: number;
};

/** 既定のバックフィル範囲（1 年）。 */
export const DEFAULT_BACKFILL_DAYS = 365;

/**
 * 設定不正。`ConfigError` を継承しているため、環境変数の不正と同じ経路で起動を止められる。
 */
export class ScopeConfigError extends ConfigError {}

const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

const SCOPE_KEYS = ["id", "owner", "repo", "backfill_days", "deploy_rule"];

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(" / ");
}

/**
 * バリデーションエラーを 1 件ずつ投げると、利用者は直しては再起動を繰り返すことになる。
 * まとめて集めて一度に見せる。
 */
class Errors {
  private readonly messages: string[] = [];

  add(message: string): void {
    this.messages.push(message);
  }

  get isEmpty(): boolean {
    return this.messages.length === 0;
  }

  throwIfAny(sourcePath: string): void {
    if (this.isEmpty) {
      return;
    }
    throw new ScopeConfigError(
      `スコープ設定 ${sourcePath} が不正です:\n${this.messages.map((m) => `  - ${m}`).join("\n")}`,
    );
  }
}

function readRequiredString(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: Errors,
): string | undefined {
  const value = table[key];
  if (value === undefined) {
    errors.add(`${label}: \`${key}\` がありません`);
    return undefined;
  }
  if (typeof value !== "string" || value === "") {
    errors.add(`${label}: \`${key}\` は空でない文字列である必要があります`);
    return undefined;
  }
  return value;
}

function readBackfillDays(
  table: Record<string, unknown>,
  label: string,
  errors: Errors,
): number | undefined {
  const value = table.backfill_days;
  if (value === undefined) {
    return DEFAULT_BACKFILL_DAYS;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    errors.add(
      `${label}: \`backfill_days\` は 1 以上の整数である必要があります（既定 ${DEFAULT_BACKFILL_DAYS}）`,
    );
    return undefined;
  }
  return value;
}

/**
 * デプロイ検出ルールを 1 つだけ読む（ADR-0001 決定 1）。
 *
 * 設定の形は `[scopes.deploy_rule.<ルール名>]`。ルール名をキーにすることで、
 * 「2 つ書いた」が構文として表現でき、明示的に落とせる。
 */
function readDeployRule(
  scopeTable: Record<string, unknown>,
  label: string,
  errors: Errors,
): DeployRule | undefined {
  const raw = scopeTable.deploy_rule;
  if (raw === undefined) {
    errors.add(
      `${label}: \`deploy_rule\` がありません。${quoteList(DEPLOY_RULE_NAMES)} のいずれか 1 つを ` +
        "`[scopes.deploy_rule.default_branch]` の形で指定してください",
    );
    return undefined;
  }
  if (!isTable(raw)) {
    errors.add(`${label}: \`deploy_rule\` はテーブルである必要があります`);
    return undefined;
  }

  const names = Object.keys(raw);
  if (names.length === 0) {
    errors.add(
      `${label}: \`deploy_rule\` にルールがありません。${quoteList(DEPLOY_RULE_NAMES)} のいずれか 1 つを指定してください`,
    );
    return undefined;
  }
  if (names.length > 1) {
    errors.add(
      `${label}: デプロイ検出ルールが ${names.length} つ指定されています（${quoteList(names)}）。` +
        "1 スコープにつき 1 ルールだけです。複数ルールの OR 合成は同一デプロイの二重計上を生み、" +
        "どのルールで数えたのかを辿れなくするため禁止しています（ADR-0001）",
    );
    return undefined;
  }

  const [name] = names;
  if (name === undefined) {
    return undefined;
  }
  const body = raw[name];
  if (!isTable(body)) {
    errors.add(`${label}: \`deploy_rule.${name}\` はテーブルである必要があります`);
    return undefined;
  }
  const ruleLabel = `${label} の \`deploy_rule.${name}\``;

  if (name === "default_branch") {
    rejectUnknownKeys(body, ["granularity"], ruleLabel, errors);
    const granularity = body.granularity;
    if (granularity === undefined) {
      // ADR-0001 は `merge_only` を既定と呼ぶが、設定ファイル上は必須にしている。
      // 粒度は指標の値をそのまま変える（`all_pushes` ではリードタイムがほぼ全件ゼロになる）。
      // 黙って既定に落ちると、その選択が PR にもファイルにも残らない。
      errors.add(
        `${ruleLabel}: \`granularity\` がありません。${quoteList(GRANULARITIES)} から選んでください` +
          "（推奨は `merge_only`。`all_pushes` は全コミットを 1 デプロイとして数えます）",
      );
      return undefined;
    }
    if (!isGranularity(granularity)) {
      errors.add(
        `${ruleLabel}: \`granularity\` が不正です: ${JSON.stringify(granularity)}。` +
          `${quoteList(GRANULARITIES)} から選んでください`,
      );
      return undefined;
    }
    return { name: "default_branch", granularity };
  }

  if (name === "workflow_run") {
    rejectUnknownKeys(body, ["workflow"], ruleLabel, errors);
    const workflow = readRequiredString(body, "workflow", ruleLabel, errors);
    if (workflow === undefined) {
      return undefined;
    }
    return { name: "workflow_run", workflow };
  }

  if (DEFERRED_DEPLOY_RULE_NAMES.includes(name)) {
    errors.add(
      `${label}: デプロイ検出ルール \`${name}\` は MVP では未実装です（ADR-0001 決定 3 で保留）。` +
        `${quoteList(DEPLOY_RULE_NAMES)} のいずれかを指定してください`,
    );
    return undefined;
  }

  errors.add(
    `${label}: 未知のデプロイ検出ルール \`${name}\`。指定できるのは ${quoteList(DEPLOY_RULE_NAMES)} です`,
  );
  return undefined;
}

function isGranularity(value: unknown): value is DefaultBranchGranularity {
  return typeof value === "string" && (GRANULARITIES as readonly string[]).includes(value);
}

function rejectUnknownKeys(
  table: Record<string, unknown>,
  known: readonly string[],
  label: string,
  errors: Errors,
): void {
  const unknown = Object.keys(table).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    errors.add(
      `${label}: 未知のキー ${quoteList(unknown)}。指定できるのは ${quoteList(known)} です`,
    );
  }
}

function parseScope(raw: unknown, index: number, errors: Errors): Scope | undefined {
  const position = `[[scopes]] の ${index + 1} 番目`;
  if (!isTable(raw)) {
    errors.add(`${position}: テーブルである必要があります`);
    return undefined;
  }

  const id = readRequiredString(raw, "id", position, errors);
  const label = id === undefined ? position : `${position}（id=${id}）`;
  if (id !== undefined && !SCOPE_ID_PATTERN.test(id)) {
    // scope_id は DB の主キーと画面の URL に出る。使える文字を絞っておく。
    errors.add(
      `${label}: \`id\` は英数字で始まり、英数字と \`.\` \`_\` \`-\` だけを含む必要があります`,
    );
  }

  rejectUnknownKeys(raw, SCOPE_KEYS, label, errors);

  const owner = readRequiredString(raw, "owner", label, errors);
  if (owner !== undefined && !OWNER_PATTERN.test(owner)) {
    errors.add(
      `${label}: \`owner\` が GitHub のアカウント名として不正です: ${JSON.stringify(owner)}`,
    );
  }
  const repo = readRequiredString(raw, "repo", label, errors);
  if (repo !== undefined && !REPO_PATTERN.test(repo)) {
    errors.add(
      `${label}: \`repo\` が GitHub のリポジトリ名として不正です: ${JSON.stringify(repo)}` +
        "（`owner/repo` ではなくリポジトリ名だけを書きます）",
    );
  }

  const backfillDays = readBackfillDays(raw, label, errors);
  const deployRule = readDeployRule(raw, label, errors);

  if (
    id === undefined ||
    owner === undefined ||
    repo === undefined ||
    backfillDays === undefined ||
    deployRule === undefined
  ) {
    return undefined;
  }
  return { id, owner, repo, deployRule, backfillDays };
}

/**
 * TOML 文字列をスコープ一覧に変換する。不正なら `ScopeConfigError` を投げる。
 */
export function parseScopes(text: string, sourcePath: string): Scope[] {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    const detail = error instanceof TomlError ? error.message : String(error);
    throw new ScopeConfigError(
      `スコープ設定 ${sourcePath} を TOML として解析できません: ${detail}`,
    );
  }
  if (!isTable(document)) {
    throw new ScopeConfigError(`スコープ設定 ${sourcePath} がテーブルではありません`);
  }

  const errors = new Errors();
  rejectUnknownKeys(document, ["scopes"], "トップレベル", errors);

  const rawScopes = document.scopes ?? [];
  if (!Array.isArray(rawScopes)) {
    errors.add("`scopes` は `[[scopes]]` の配列である必要があります");
    errors.throwIfAny(sourcePath);
  }
  const entries: unknown[] = Array.isArray(rawScopes) ? rawScopes : [];
  if (entries.length === 0) {
    errors.add(
      "スコープが 1 つも定義されていません。`[[scopes]]` を 1 つ以上書いてください" +
        "（指標はスコープ単位でしか計算しません。ADR-0005）",
    );
  }

  const scopes: Scope[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of entries.entries()) {
    const scope = parseScope(raw, index, errors);
    if (scope === undefined) {
      continue;
    }
    if (seen.has(scope.id)) {
      // scope_id は保存済みイベントの所属先そのもの。重複すると別スコープのデータが混ざる。
      errors.add(`[[scopes]] の ${index + 1} 番目: \`id\` が重複しています: ${scope.id}`);
      continue;
    }
    seen.add(scope.id);
    scopes.push(scope);
  }

  errors.throwIfAny(sourcePath);
  return scopes;
}

/**
 * スコープ設定ファイルを読み込む。起動時に 1 回だけ呼ぶ。
 */
export function loadScopes(sourcePath: string): Scope[] {
  let text: string;
  try {
    text = readFileSync(sourcePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      throw new ScopeConfigError(
        `スコープ設定ファイルがありません: ${sourcePath}。` +
          "`scopes.example.toml` をコピーして作成してください（場所は SCOPES_PATH で変更できます）",
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScopeConfigError(`スコープ設定ファイルを読めません: ${sourcePath} / ${detail}`);
  }
  return parseScopes(text, sourcePath);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * ログ用の 1 行表現。画面に出す文言（ADR-0001 決定 5）は別物で、#20 の担当。
 */
export function describeDeployRule(rule: DeployRule): string {
  return rule.name === "default_branch"
    ? `default_branch (${rule.granularity})`
    : `workflow_run (${rule.workflow})`;
}
