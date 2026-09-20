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

  /* スコープ・期間の切り替え。並べるのはリンクだけで、数値は添えない（#20） */
  .fk-switcher { margin: 1rem 0; }
  .fk-switcher__label { font-weight: 600; margin-right: 0.5rem; }
  .fk-switcher ul {
    display: inline-flex; flex-wrap: wrap; gap: 0.75rem;
    list-style: none; margin: 0; padding: 0;
  }
  .fk-switcher__current { font-weight: 600; text-decoration: underline; }
`;
