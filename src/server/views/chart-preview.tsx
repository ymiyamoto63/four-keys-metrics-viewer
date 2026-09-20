import { WeeklyLineChart, type WeeklySeries } from "./chart.tsx";
import { Layout } from "./layout.tsx";

/**
 * チャートの動作確認用のプレビュー（#19）。
 *
 * 本番の画面は #20（サマリ）と #21（指標詳細）で作る。ここは
 * 「欠損週で線が切れること」を実際のブラウザでも見られるようにするための最小の経路で、
 * 合成データしか使わない。#20 / #21 が入ったら削ってよい。
 */

/** 2026-07-06（月）から 16 週。JST 月曜始まり（ADR-0004）。 */
const WEEKS = Array.from({ length: 16 }, (_, i) => {
  const monday = new Date(Date.UTC(2026, 6, 6) + i * 7 * 24 * 60 * 60 * 1000);
  return monday.toISOString().slice(0, 10);
});

/** 欠損週（デプロイが少なく、値を出さない週）。 */
const MISSING = new Set([WEEKS[3], WEEKS[4], WEEKS[9], WEEKS[13]]);

function synth(base: number, amplitude: number): WeeklySeries["points"] {
  return WEEKS.map((week, i) => ({
    week,
    value: MISSING.has(week) ? null : Math.round((base + amplitude * Math.sin(i / 2)) * 10) / 10,
  }));
}

export function ChartPreview() {
  return (
    <Layout title="チャートのプレビュー">
      <h1>チャートのプレビュー</h1>
      <p>
        合成データによる確認用の画面です（#19）。網掛けの目盛りが、値を出さない＝線を繋がない週です。
      </p>

      <WeeklyLineChart
        title="デプロイ頻度（回 / 週）"
        weeks={WEEKS}
        unitLabel=" 回"
        series={[{ name: "デプロイ数", points: synth(4, 2.5) }]}
        pointHref={(week) => `/_preview/chart?week=${week}`}
      />

      <WeeklyLineChart
        title="変更のリードタイム（時間）"
        weeks={WEEKS}
        unitLabel=" 時間"
        series={[
          { name: "中央値", role: "primary", points: synth(28, 8) },
          { name: "p75", role: "secondary", points: synth(52, 14) },
          { name: "p90", role: "secondary", points: synth(96, 26) },
        ]}
        pointHref={(week) => `/_preview/chart?week=${week}`}
      />
    </Layout>
  );
}
