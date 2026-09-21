/**
 * 「その URL では表示できない」ことを伝えるだけのページ（#20）。
 *
 * 404（知らないスコープ / 知らない指標）と 400（選べない期間）で共用する。
 * 空のサマリを返して「データが無い」ように見せるより、**なぜ出せないかを書いて止める**。
 * 本アプリでは空白＝収集の穴の可能性があり（ADR-0004 / ADR-0007）、
 * URL の誤りを空白として見せると、その 2 つが混ざる。
 */

import { Layout } from "./layout.tsx";

export type NoticePageProps = {
  title: string;
  message: string;
  /** 戻り先。スコープが 1 つも解決できない場合は省略する。 */
  backHref?: string;
  backLabel?: string;
};

export function NoticePage({ title, message, backHref, backLabel }: NoticePageProps) {
  return (
    <Layout title={title}>
      <h1>{title}</h1>
      <p class="fk-alert" data-testid="notice-message">
        {message}
      </p>
      {backHref === undefined ? null : (
        <p>
          <a href={backHref}>← {backLabel ?? "戻る"}</a>
        </p>
      )}
    </Layout>
  );
}
