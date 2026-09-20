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
