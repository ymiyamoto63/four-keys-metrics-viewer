import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError } from "./config.ts";
import { DEFAULT_BACKFILL_DAYS, loadScopes, parseScopes, ScopeConfigError } from "./scopes.ts";

/** スコープのキーは、ルールのテーブルより前に書く必要がある（TOML の構造上）。 */
const SCOPE_HEAD = `
[[scopes]]
id = "viewer"
owner = "ymiyamoto63"
repo = "four-keys-metrics-viewer"
`;

const DEFAULT_BRANCH_RULE = `
[scopes.deploy_rule.default_branch]
granularity = "merge_only"
`;

const MINIMAL = SCOPE_HEAD + DEFAULT_BRANCH_RULE;

function parse(text: string) {
  return parseScopes(text, "scopes.toml");
}

/** バリデーションエラーのメッセージを取り出す。落ちなかった場合はテストを失敗させる。 */
function errorOf(text: string): string {
  try {
    parse(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ScopeConfigError);
    return (error as Error).message;
  }
  throw new Error("エラーにならなかった");
}

const tempDirs: string[] = [];

function writeTempConfig(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scopes-"));
  tempDirs.push(dir);
  const path = join(dir, "scopes.toml");
  writeFileSync(path, text);
  return path;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("スコープ設定の読み込み", () => {
  it("最小の設定を読める", () => {
    expect(parse(MINIMAL)).toEqual([
      {
        id: "viewer",
        owner: "ymiyamoto63",
        repo: "four-keys-metrics-viewer",
        deployRule: { name: "default_branch", granularity: "merge_only" },
        backfillDays: DEFAULT_BACKFILL_DAYS,
      },
    ]);
  });

  it("バックフィル範囲の既定は 1 年", () => {
    expect(DEFAULT_BACKFILL_DAYS).toBe(365);
    expect(parse(MINIMAL)[0]?.backfillDays).toBe(365);
  });

  it("バックフィル範囲をスコープごとに指定できる", () => {
    const scopes = parse(`${SCOPE_HEAD}backfill_days = 90\n${DEFAULT_BRANCH_RULE}`);
    expect(scopes[0]?.backfillDays).toBe(90);
  });

  it("workflow_run ルールを読める", () => {
    const scopes = parse(`
[[scopes]]
id = "viewer"
owner = "ymiyamoto63"
repo = "four-keys-metrics-viewer"

[scopes.deploy_rule.workflow_run]
workflow = "deploy.yml"
`);
    expect(scopes[0]?.deployRule).toEqual({ name: "workflow_run", workflow: "deploy.yml" });
  });

  it("スコープを複数定義できる", () => {
    const scopes = parse(`${MINIMAL}
[[scopes]]
id = "another"
owner = "ymiyamoto63"
repo = "another-service"

[scopes.deploy_rule.workflow_run]
workflow = "deploy.yml"
`);
    expect(scopes.map((scope) => scope.id)).toEqual(["viewer", "another"]);
  });

  it("サンプル設定ファイルはそのまま読める", () => {
    expect(loadScopes("scopes.example.toml")).toHaveLength(1);
  });
});

describe("デプロイ検出ルールのバリデーション（ADR-0001）", () => {
  it("ルールを 2 つ指定すると落ちる", () => {
    const message = errorOf(`${MINIMAL}
[scopes.deploy_rule.workflow_run]
workflow = "deploy.yml"
`);
    expect(message).toContain("2 つ指定されています");
    expect(message).toContain("default_branch");
    expect(message).toContain("workflow_run");
    expect(message).toContain("ADR-0001");
  });

  it("ルールが 1 つも無いと落ちる", () => {
    expect(
      errorOf(`
[[scopes]]
id = "viewer"
owner = "ymiyamoto63"
repo = "four-keys-metrics-viewer"
`),
    ).toContain("`deploy_rule` がありません");
  });

  it("未知のルール名は、指定できるルールを添えて落ちる", () => {
    const message = errorOf(`
[[scopes]]
id = "viewer"
owner = "ymiyamoto63"
repo = "four-keys-metrics-viewer"

[scopes.deploy_rule.release_published]
tag = "v*"
`);
    expect(message).toContain("未知のデプロイ検出ルール");
    expect(message).toContain("release_published");
    expect(message).toContain("default_branch");
  });

  it("保留中の deployments_api は「未実装」と分かる形で落ちる", () => {
    const message = errorOf(`
[[scopes]]
id = "viewer"
owner = "ymiyamoto63"
repo = "four-keys-metrics-viewer"

[scopes.deploy_rule.deployments_api]
environment = "production"
`);
    expect(message).toContain("未実装");
    expect(message).toContain("deployments_api");
  });

  it("default_branch の粒度が無いと落ちる", () => {
    const message = errorOf(`
[[scopes]]
id = "viewer"
owner = "ymiyamoto63"
repo = "four-keys-metrics-viewer"

[scopes.deploy_rule.default_branch]
`);
    expect(message).toContain("`granularity` がありません");
    expect(message).toContain("merge_only");
    expect(message).toContain("all_pushes");
  });

  it("未知の粒度は落ちる", () => {
    expect(errorOf(MINIMAL.replace("merge_only", "squash_only"))).toContain(
      "`granularity` が不正です",
    );
  });

  it("all_pushes も選べる", () => {
    const scopes = parse(MINIMAL.replace("merge_only", "all_pushes"));
    expect(scopes[0]?.deployRule).toEqual({
      name: "default_branch",
      granularity: "all_pushes",
    });
  });

  it("workflow_run のワークフロー指定が無いと落ちる", () => {
    expect(
      errorOf(`
[[scopes]]
id = "viewer"
owner = "ymiyamoto63"
repo = "four-keys-metrics-viewer"

[scopes.deploy_rule.workflow_run]
`),
    ).toContain("`workflow` がありません");
  });

  it("ルールの中の未知のキーは落ちる", () => {
    expect(errorOf(`${MINIMAL}\n[scopes.deploy_rule.default_branch.extra]\nfoo = 1\n`)).toContain(
      "未知のキー",
    );
  });
});

describe("スコープ自体のバリデーション", () => {
  it("スコープが 1 つも無いと落ちる", () => {
    expect(errorOf("")).toContain("スコープが 1 つも定義されていません");
    expect(errorOf("scopes = []")).toContain("スコープが 1 つも定義されていません");
  });

  it("id が無いと落ちる", () => {
    expect(errorOf(MINIMAL.replace('id = "viewer"', ""))).toContain("`id` がありません");
  });

  it("id に使えない文字があると落ちる", () => {
    expect(errorOf(MINIMAL.replace('id = "viewer"', 'id = "ymiyamoto63/viewer"'))).toContain(
      "`id` は英数字で始まり",
    );
  });

  it("id が重複すると落ちる", () => {
    const message = errorOf(`${MINIMAL}
[[scopes]]
id = "viewer"
owner = "ymiyamoto63"
repo = "another-service"

[scopes.deploy_rule.default_branch]
granularity = "merge_only"
`);
    expect(message).toContain("`id` が重複しています");
  });

  it("owner / repo が無いと落ちる", () => {
    const message = errorOf(`
[[scopes]]
id = "viewer"

[scopes.deploy_rule.default_branch]
granularity = "merge_only"
`);
    expect(message).toContain("`owner` がありません");
    expect(message).toContain("`repo` がありません");
  });

  it("repo に owner/repo 形式を書くと落ちる", () => {
    expect(errorOf(MINIMAL.replace('repo = "four-keys-metrics-viewer"', 'repo = "a/b"'))).toContain(
      "`repo` が GitHub のリポジトリ名として不正です",
    );
  });

  it("backfill_days が 1 以上の整数でないと落ちる", () => {
    expect(errorOf(`${SCOPE_HEAD}backfill_days = 0\n${DEFAULT_BRANCH_RULE}`)).toContain(
      "`backfill_days` は 1 以上の整数",
    );
    expect(errorOf(`${SCOPE_HEAD}backfill_days = "1 year"\n${DEFAULT_BRANCH_RULE}`)).toContain(
      "`backfill_days` は 1 以上の整数",
    );
  });

  it("綴りを間違えたキーは、既定値に吸収させず落とす", () => {
    const message = errorOf(`${SCOPE_HEAD}backfil_days = 90\n${DEFAULT_BRANCH_RULE}`);
    expect(message).toContain("未知のキー");
    expect(message).toContain("backfil_days");
  });

  it("未知のトップレベルキーは落ちる", () => {
    expect(errorOf(`${MINIMAL}\n[settings]\nfoo = 1\n`)).toContain("トップレベル");
  });

  it("複数の誤りを 1 回のエラーでまとめて報告する", () => {
    const message = errorOf(`
[[scopes]]
id = "viewer"

[scopes.deploy_rule.default_branch]
`);
    expect(message.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(3);
  });

  it("TOML として壊れていれば、その旨を添えて落ちる", () => {
    expect(errorOf("[[scopes]\nid = ")).toContain("TOML として解析できません");
  });
});

describe("設定ファイルの所在", () => {
  it("ファイルから読める", () => {
    const path = writeTempConfig(MINIMAL);
    expect(loadScopes(path).map((scope) => scope.id)).toEqual(["viewer"]);
  });

  it("ファイルが無ければ、サンプルの複製を促して落ちる", () => {
    const message = (() => {
      try {
        loadScopes(join(tmpdir(), "does-not-exist-scopes.toml"));
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("エラーにならなかった");
    })();
    expect(message).toContain("scopes.example.toml");
  });

  it("設定不正は ConfigError として扱える（起動を止めるため）", () => {
    const path = writeTempConfig("");
    expect(() => loadScopes(path)).toThrow(ConfigError);
  });

  it("エラーメッセージにファイルの場所が出る", () => {
    const path = writeTempConfig("");
    expect(() => loadScopes(path)).toThrow(path);
  });
});
