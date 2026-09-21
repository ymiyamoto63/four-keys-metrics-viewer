/**
 * 画面用の整形（#20）。#21 も同じ表記を使うこと。
 *
 * 時刻は **JST の固定オフセット（+09:00）で組み立てる**。理由は `metrics/week.ts` と同じで、
 * `Intl.DateTimeFormat` に任せると表示が実行環境の ICU / タイムゾーン DB に依存し、
 * 週境界（JST 月曜始まり）と画面の表記がずれても気付けないため。
 * 週の定義と表示の定義を同じ前提の上に置く。
 */

const MS_PER_HOUR = 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * MS_PER_HOUR;

/** ISO8601 を `2026-09-21 08:00 JST` の形にする。 */
export function formatJst(iso: string): string {
  const shifted = new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)} JST`;
}

/** 日付だけ（`2026-09-21`）。JST での日付。 */
export function formatJstDate(iso: string): string {
  return new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 経過時間を「どれくらい古いか」の日本語にする。
 *
 * ADR-0007 の構成ではデータが古いことが通常状態なので、**古さは絶対時刻だけでなく
 * 相対表現でも出す**。「2026-08-01 12:00 JST」だけだと、それが 1 日前なのか
 * 2 ヶ月前なのかを読み手が暗算することになる。
 */
export function formatAge(hours: number): string {
  if (hours < 1) {
    return "1 時間以内";
  }
  if (hours < 48) {
    return `約 ${Math.floor(hours)} 時間前`;
  }
  return `約 ${Math.floor(hours / 24)} 日前`;
}
