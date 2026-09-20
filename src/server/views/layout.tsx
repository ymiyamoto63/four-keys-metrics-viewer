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
`;
