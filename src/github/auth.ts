/**
 * GitHub への認証。
 *
 * ADR-0006（改訂）は単一の fine-grained PAT（read-only・対象リポジトリのみ選択）を
 * 環境変数 / `.env` から読むと決めた。同時に「GitHub App へ移行できる形で実装する」ことも
 * 求めている。**このファイルがその継ぎ目である。**
 *
 * App のインストールトークンは 1 時間で失効し、都度取り直す必要がある。そのため
 * Authorization ヘッダの値は非同期で取り出す形にしてある。PAT では定数を返すだけになるが、
 * 移行時に差し替えるのがこのファイルだけで済む。
 */

export type GitHubAuth = {
  /** 認証方式の名前。ログに出すのはこちらだけで、credential 本体は決して出さない。 */
  readonly kind: string;
  /** `Authorization` ヘッダに載せる値。 */
  authorization(): Promise<string>;
};

export class AuthError extends Error {}

export function patAuth(token: string): GitHubAuth {
  if (token.trim() === "") {
    throw new AuthError(
      "GITHUB_TOKEN が空です（.env に read-only の fine-grained PAT を設定してください）",
    );
  }
  const header = `Bearer ${token}`;
  return {
    kind: "pat",
    authorization: async () => header,
  };
}
