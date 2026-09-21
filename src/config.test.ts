import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("既定ではループバックにバインドする", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
  });

  it("ループバック以外へのバインドは既定で拒否する", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(ConfigError);
  });

  it("明示的なオプトインがある場合に限りループバック以外を許す", () => {
    const config = loadConfig({ HOST: "0.0.0.0", ALLOW_NON_LOOPBACK_BIND: "1" });
    expect(config.host).toBe("0.0.0.0");
  });

  it("PORT が数値でなければ起動を止める", () => {
    expect(() => loadConfig({ PORT: "http" })).toThrow(ConfigError);
  });

  it("空文字の GITHUB_TOKEN は未設定として扱う", () => {
    expect(loadConfig({ GITHUB_TOKEN: "" }).githubToken).toBeUndefined();
  });

  it("COLLECT_ON_STARTUP の既定は有効", () => {
    expect(loadConfig({}).collectOnStartup).toBe(true);
    expect(loadConfig({ COLLECT_ON_STARTUP: "false" }).collectOnStartup).toBe(false);
  });
});

/**
 * `.env` をアプリまで届ける経路のテスト（#52）。
 *
 * `loadConfig` は `process.env` を読むだけなので、**`.env` を `process.env` に載せるのは
 * 起動スクリプトの仕事**である。かつてそれが `docker-compose.yml` の `env_file` にしか
 * 無く、ホストで `npm run dev` すると `.env` が丸ごと無視されていた。
 *
 * この壊れ方は静かである。`GITHUB_TOKEN` が無くても画面は開く（ADR-0006）ので、
 * 症状は「グラフが空」になり、設定ミスなのかデータが無いのか画面から区別できない。
 * コードではなく `package.json` 側の設定なので、ここで押さえないと誰も気付けない。
 */
describe("起動スクリプトが .env を読み込む（#52）", () => {
  const scripts: Record<string, string> = JSON.parse(readFileSync("package.json", "utf8")).scripts;

  /**
   * `--env-file-if-exists` であって `--env-file` ではない。Docker 運用では `.env` を
   * イメージに入れず `env_file` から環境変数として渡すため、ファイルが無くても落ちてはいけない。
   *
   * なお Node は**既に `process.env` にある値をファイルで上書きしない**ので、
   * Docker 側で渡した値が勝つ（実機で確認済み）。
   */
  it.each([
    ["dev", "ホストでの開発起動"],
    ["start", "ホストでの本番起動"],
    ["record:fixtures", "GITHUB_TOKEN を使う記録スクリプト"],
  ])("%s が .env を読む（%s）", (name) => {
    expect(scripts[name]).toContain("--env-file-if-exists=.env");
  });

  it("sample:generate は .env を要らない（GitHub に触らない）", () => {
    // 生成はローカルで完結し、リモートへは push しない（src/sample-repo/generate.ts）。
    expect(scripts["sample:generate"]).not.toContain("--env-file");
  });
});
