/**
 * 環境変数から設定を読む。
 *
 * バインド先の既定は `127.0.0.1`（ADR-0006 改訂）。
 * ループバック以外へバインドする場合は `ALLOW_NON_LOOPBACK_BIND=1` を明示的に要求する。
 * これは Docker コンテナ内での実行を成立させるための例外で、詳細は `readHost` のコメントを参照。
 */

export type Config = {
  host: string;
  port: number;
  databasePath: string;
  /** スコープ設定ファイル（ADR-0005）の場所。 */
  scopesPath: string;
  githubToken: string | undefined;
  collectCron: string;
  collectOnStartup: boolean;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class ConfigError extends Error {}

function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT ?? "3000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT が不正です: ${raw}`);
  }
  return port;
}

/**
 * ADR-0006 の改訂で「`0.0.0.0` にバインドしてはならない」と決めたが、これはホスト上で
 * 直接プロセスを動かす場合の話である。Docker コンテナ内でループバックにバインドすると、
 * コンテナのネットワーク名前空間の外——つまりホスト——からは一切到達できなくなり、
 * ポート公開しても画面が開かない。
 *
 * コンテナ内での露出範囲を決めるのはアプリのバインド先ではなく、
 * `docker-compose.yml` のポート公開先（`127.0.0.1:3000:3000`）である。
 * そのため「ループバック以外は既定で拒否し、明示的なオプトインを要求する」形にしている。
 */
function readHost(env: NodeJS.ProcessEnv): string {
  const host = env.HOST ?? "127.0.0.1";
  if (LOOPBACK_HOSTS.has(host)) {
    return host;
  }
  if (env.ALLOW_NON_LOOPBACK_BIND !== "1") {
    throw new ConfigError(
      `HOST=${host} はループバックではありません。` +
        "ループバック以外にバインドすると、同一ネットワーク上の他の端末から認証なしで閲覧可能になります" +
        "（ADR-0006）。Docker コンテナ内のように、露出範囲を外側で制御している場合に限り " +
        "ALLOW_NON_LOOPBACK_BIND=1 を設定してください。",
    );
  }
  return host;
}

function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: readHost(env),
    port: readPort(env),
    databasePath: env.DATABASE_PATH ?? "./data/four-keys.sqlite",
    scopesPath: env.SCOPES_PATH ?? "./scopes.toml",
    githubToken: env.GITHUB_TOKEN || undefined,
    collectCron: env.COLLECT_CRON ?? "0 * * * *",
    collectOnStartup: readBoolean(env.COLLECT_ON_STARTUP, true),
  };
}

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}
