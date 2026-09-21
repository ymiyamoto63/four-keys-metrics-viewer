import type { PropsWithChildren } from "hono/jsx";

export function Layout({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style>{CSS}</style>
      </head>
      <body>
        <header>
          <a href="/">Four Keys Metrics Viewer</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

const CSS = `
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    line-height: 1.7;
  }
  header {
    padding: 0.75rem 1.5rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  }
  header a { color: inherit; text-decoration: none; font-weight: 600; }
  main { padding: 1.5rem; max-width: 60rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1.5rem; }
  dt { font-weight: 600; }
  dd { margin: 0; }
  code { font-family: ui-monospace, monospace; }

  /* 常時表示の説明ブロック（デプロイ検出ルール・収集状態・カバレッジ）。#20 */
  .fk-notice {
    margin: 1.5rem 0;
    padding: 0.75rem 1rem;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-radius: 6px;
  }
  .fk-notice h2 { font-size: 1rem; margin: 0 0 0.5rem; }
  /* 収集状態は指標の正しさの一部なので、他の節より目立たせる（ADR-0007）。 */
  .fk-notice--status { border-left: 4px solid color-mix(in srgb, currentColor 45%, transparent); }
  .fk-hint { font-size: 0.85rem; opacity: 0.8; margin: 0.5rem 0 0; }
  .fk-alert {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    background: color-mix(in srgb, crimson 18%, transparent);
  }

  /* 根拠イベント一覧（#21）。1 デプロイ = 1 ブロック、その下にコミットの表を置く。 */
  .fk-evidence { list-style: none; margin: 1rem 0; padding: 0; }
  .fk-evidence__deployment {
    margin: 0 0 1.25rem;
    padding: 0.75rem 1rem;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-radius: 6px;
  }
  .fk-evidence__deployment h3 { font-size: 1rem; margin: 0 0 0.5rem; }
  .fk-evidence__table {
    width: 100%;
    margin-top: 0.75rem;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .fk-evidence__table th, .fk-evidence__table td {
    padding: 0.35rem 0.5rem;
    text-align: left;
    vertical-align: top;
    border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  }
  .fk-evidence__table th { font-weight: 600; white-space: nowrap; }
  /* 表は横に広い。狭い画面では表だけ横スクロールさせ、ページ全体は横に溢れさせない。 */
  @media (max-width: 45rem) {
    .fk-evidence__deployment { overflow-x: auto; }
  }

  /* スコープ・期間の切り替え。並べるのはリンクだけで、数値は添えない（#20） */
  .fk-switcher { margin: 1rem 0; }
  .fk-switcher__label { font-weight: 600; margin-right: 0.5rem; }
  .fk-switcher ul {
    display: inline-flex; flex-wrap: wrap; gap: 0.75rem;
    list-style: none; margin: 0; padding: 0;
  }
  .fk-switcher__current { font-weight: 600; text-decoration: underline; }
`;
