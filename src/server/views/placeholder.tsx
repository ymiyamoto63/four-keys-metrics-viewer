import { Layout } from "./layout.tsx";

export type PlaceholderProps = {
  databasePath: string;
  collectCron: string;
  githubTokenPresent: boolean;
};

export function Placeholder({ databasePath, collectCron, githubTokenPresent }: PlaceholderProps) {
  return (
    <Layout title="Four Keys Metrics Viewer">
      <h1>起動しています</h1>
      <p>
        雛形のみの状態です。スコープの一覧と指標の画面は、収集とスキーマが入った後に実装されます
        （#8, #13 以降）。
      </p>
      <dl>
        <dt>DB ファイル</dt>
        <dd>
          <code>{databasePath}</code>
        </dd>
        <dt>収集スケジュール</dt>
        <dd>
          <code>{collectCron}</code>
        </dd>
        <dt>GitHub トークン</dt>
        <dd>{githubTokenPresent ? "設定済み" : "未設定（収集は動きません）"}</dd>
      </dl>
    </Layout>
  );
}
