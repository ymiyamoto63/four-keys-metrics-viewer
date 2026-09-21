/**
 * 週次の折れ線チャート。サーバー側で SVG をそのまま組み立てる（クライアント JS を使わない）。
 *
 * チャートライブラリを入れずに自前で SVG を書く判断と、その理由・却下した候補は
 * `docs/adr/0008-chart-library.md`（#19）に記録した。
 *
 * このコンポーネントの最重要の要件は **欠損週で線を繋がないこと**（ADR-0004）。
 * ADR-0001 で `merge_only` を既定にした結果、欠損週は例外ではなく通常の表示状態になるため、
 * 「たまたま補間されない」ではなく「補間する経路が存在しない」状態を保つ。
 */

/**
 * 週次の 1 点。
 *
 * `value` が `null` の週は「データ点が少なく、値を出さない週」（ADR-0004）。
 * `weeks` に含まれるのに系列側に現れない週も同じ扱い（＝欠損）にする。
 */
export type WeeklyPoint = {
  /** 週の開始日。JST 月曜始まりの `YYYY-MM-DD`（ADR-0004） */
  week: string;
  value: number | null;
};

export type WeeklySeries = {
  /** 凡例に出す名前（"中央値" / "p75" / "p90" など） */
  name: string;
  points: WeeklyPoint[];
  /**
   * `primary` は中央値の主線、`secondary` は p75 / p90 の補助線（ADR-0004）。
   * 既定は `primary`。補助線は細く・淡い色で描く。
   */
  role?: "primary" | "secondary";
};

export type WeeklyLineChartProps = {
  /** 図のタイトル（`figcaption` と SVG の `aria-label` に使う） */
  title: string;
  /** x 軸に並べる週（JST 月曜始まりの週開始日、昇順）。ここに無い週は描かない */
  weeks: string[];
  /** 重ね描きする系列。中央値を先頭に、p75 / p90 と続ける想定（最大 4 系列） */
  series: WeeklySeries[];
  /** y 軸に添える単位（"回 / 週"、"時間" など） */
  unitLabel?: string;
  /**
   * 点のリンク先を返す（#20 のサマリから #21 の指標詳細へ遷移するために使う）。
   * `undefined` を返した週の点はリンクにしない。
   */
  pointHref?: (week: string) => string | undefined;
  /**
   * 欠損週（どの系列にも値が無い週）に添える説明文を、**呼び出し側が指定する**（#21）。
   *
   * ## なぜ固定文言をやめたのか
   *
   * ここは以前「データ点が少ない n 週は値を出さず…」という固定文言を出していた（#20 時点）。
   * だが空白の理由は指標ごとに違う。
   *
   * - **デプロイ頻度**の空白は ADR-0007 由来の**収集の穴**である。標本不足ではない
   *   （収集済みでデプロイ 0 件の週は、欠損ではなく `0` として点が打たれる。#17）
   * - **リードタイム**の空白は ADR-0004 の**標本数ゲート**と収集の穴の両方がありうる
   *
   * 両方を「データ点が少ない」の一語で説明すると、#20 が画面全体で避けたはずの
   * 「収集が壊れている期間と本当にデプロイが無かった期間の区別」がここで潰れる。
   * 既定は**指標に依らない中立文**にし、理由を言えるチャートだけが言う形にした。
   */
  missingWeekNote?: (missingWeekCount: number) => string;
  /** 目盛りとツールチップの数値整形。既定は小数 1 桁まで */
  formatValue?: (value: number) => string;
  width?: number;
  height?: number;
};

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 260;
const PADDING = { top: 16, right: 16, bottom: 36, left: 52 } as const;
/** y 軸の目盛りの区間数 */
const Y_TICK_COUNT = 4;
/** x 軸のラベルはこの枚数を超えないよう間引く（週が 52 個並ぶため） */
const MAX_X_LABELS = 9;
/** 点の半径。ダークでもライトでも掴みやすいよう直径 8px 以上にする */
const POINT_RADIUS = 4;
/** 系列に割り当てられる色のスロット数。超えた分は最後のスロットを使い回す */
const SERIES_SLOTS = 4;

export function WeeklyLineChart({
  title,
  weeks,
  series,
  unitLabel,
  pointHref,
  missingWeekNote = defaultMissingWeekNote,
  formatValue = defaultFormatValue,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}: WeeklyLineChartProps) {
  const rows = series.map((s) => ({
    ...s,
    values: alignToWeeks(s.points, weeks),
  }));
  const maxValue = Math.max(
    ...rows.flatMap((row) => row.values.filter((v): v is number => v !== null)),
    Number.NEGATIVE_INFINITY,
  );

  if (weeks.length === 0 || maxValue === Number.NEGATIVE_INFINITY) {
    return (
      <figure class="fk-chart">
        <style>{CHART_CSS}</style>
        <figcaption>{title}</figcaption>
        <p class="fk-chart__empty">この期間に表示できるデータがありません。</p>
      </figure>
    );
  }

  const tickStep = niceStep(maxValue / Y_TICK_COUNT);
  const maxY = tickStep * Y_TICK_COUNT;
  const plotLeft = PADDING.left;
  const plotRight = width - PADDING.right;
  const plotTop = PADDING.top;
  const plotBottom = height - PADDING.bottom;

  const xAt = (index: number): number => {
    // 週は等間隔に並べる（週次バケットなので日付の実距離は意味を持たない）。
    if (weeks.length === 1) return (plotLeft + plotRight) / 2;
    return plotLeft + ((plotRight - plotLeft) * index) / (weeks.length - 1);
  };
  const yAt = (value: number): number => plotBottom - (plotBottom - plotTop) * (value / maxY);

  const yTicks = Array.from({ length: Y_TICK_COUNT + 1 }, (_, i) => tickStep * i);
  const xLabelEvery = Math.ceil(weeks.length / MAX_X_LABELS);
  const missingWeeks = weeks.filter((_, i) =>
    rows.every((row) => row.values[i] === null || row.values[i] === undefined),
  );

  return (
    <figure class="fk-chart">
      <style>{CHART_CSS}</style>
      <figcaption>{title}</figcaption>
      <svg
        class="fk-chart__svg"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={`${title}（週次${unitLabel === undefined ? "" : `・${unitLabel}`}）`}
      >
        <g class="fk-chart__grid">
          {yTicks.map((tick) => (
            <g key={`y-${tick}`}>
              <line x1={plotLeft} x2={plotRight} y1={round(yAt(tick))} y2={round(yAt(tick))} />
              <text class="fk-chart__tick" x={plotLeft - 8} y={round(yAt(tick)) + 4}>
                {formatValue(tick)}
              </text>
            </g>
          ))}
        </g>

        {/*
          週ごとの目盛り。値のある週とない週で濃さを変え、「デプロイが 0 だった週」ではなく
          「データ不足で値を出していない週」であることを見て取れるようにする（ADR-0004）。
        */}
        <g class="fk-chart__weeks">
          {weeks.map((week, index) => {
            const hasValue = rows.some(
              (row) => row.values[index] !== null && row.values[index] !== undefined,
            );
            return (
              <line
                key={`w-${week}`}
                data-week={week}
                data-has-value={hasValue ? "true" : "false"}
                class={hasValue ? "fk-chart__week" : "fk-chart__week fk-chart__week--missing"}
                x1={round(xAt(index))}
                x2={round(xAt(index))}
                y1={plotBottom}
                y2={plotBottom + 4}
              />
            );
          })}
          {weeks.map((week, index) =>
            index % xLabelEvery === 0 ? (
              <text
                key={`xl-${week}`}
                class="fk-chart__tick fk-chart__tick--x"
                x={round(xAt(index))}
                y={plotBottom + 20}
              >
                {formatWeekLabel(week)}
              </text>
            ) : null,
          )}
        </g>

        {rows.map((row, seriesIndex) => {
          const slot = Math.min(seriesIndex, SERIES_SLOTS - 1);
          const secondary = row.role === "secondary";
          return (
            <g
              key={`s-${row.name}`}
              class={`fk-chart__series fk-chart__series--${slot}`}
              data-series={row.name}
            >
              {/*
                欠損で区切られた連続区間ごとに別々の <path> を出す。
                区間をまたぐ線分はそもそも生成されないので、補間は起こり得ない（#19）。
              */}
              {toSegments(row.values).map((segment, segmentIndex) => {
                if (segment.length < 2) return null;
                const d = segment
                  .map(
                    (p, i) =>
                      `${i === 0 ? "M" : "L"} ${round(xAt(p.index))},${round(yAt(p.value))}`,
                  )
                  .join(" ");
                return (
                  <path
                    key={`p-${segmentIndex}-${segment[0]?.index}`}
                    class={
                      secondary ? "fk-chart__line fk-chart__line--secondary" : "fk-chart__line"
                    }
                    data-series={row.name}
                    d={d}
                  />
                );
              })}
              {row.values.map((value, index) => {
                if (value === null) return null;
                const week = weeks[index];
                if (week === undefined) return null;
                const href = pointHref?.(week);
                const dot = (
                  <circle
                    class="fk-chart__dot"
                    data-series={row.name}
                    data-week={week}
                    cx={round(xAt(index))}
                    cy={round(yAt(value))}
                    r={POINT_RADIUS}
                  >
                    <title>{`${week} ${row.name} ${formatValue(value)}${unitLabel ?? ""}`}</title>
                  </circle>
                );
                return href === undefined ? (
                  dot
                ) : (
                  <a key={`a-${row.name}-${week}`} href={href}>
                    {dot}
                  </a>
                );
              })}
            </g>
          );
        })}
      </svg>

      {series.length > 1 ? (
        <ul class="fk-chart__legend">
          {series.map((s, i) => (
            <li key={`lg-${s.name}`}>
              <span
                class={`fk-chart__swatch fk-chart__swatch--${Math.min(i, SERIES_SLOTS - 1)}`}
                aria-hidden="true"
              />
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}

      {missingWeeks.length > 0 ? (
        <p class="fk-chart__note" data-testid="chart-missing-note">
          {missingWeekNote(missingWeeks.length)}
        </p>
      ) : null}
    </figure>
  );
}

/** `weeks` の並びに合わせて値を取り出す。系列に存在しない週は欠損（null）として扱う。 */
function alignToWeeks(points: WeeklyPoint[], weeks: string[]): (number | null)[] {
  const byWeek = new Map(points.map((p) => [p.week, p.value]));
  return weeks.map((week) => byWeek.get(week) ?? null);
}

/**
 * 値の並びを「欠損で区切られた連続区間」に分割する。
 * 補間しないという決定（ADR-0004）を、描画より前のこの一箇所で表現する。
 */
function toSegments(values: (number | null)[]): { index: number; value: number }[][] {
  const segments: { index: number; value: number }[][] = [];
  let current: { index: number; value: number }[] = [];
  for (const [index, value] of values.entries()) {
    if (value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push({ index, value });
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** 目盛り幅を 1 / 2 / 2.5 / 5 / 10 × 10^n に丸める。 */
function niceStep(rawStep: number): number {
  if (!(rawStep > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  for (const multiplier of [1, 2, 2.5, 5]) {
    if (rawStep <= multiplier * magnitude) return multiplier * magnitude;
  }
  return 10 * magnitude;
}

/**
 * 欠損週の既定の説明。**理由を断定しない**（#21）。
 *
 * 標本不足（ADR-0004）なのか収集の穴（ADR-0007）なのかはこのコンポーネントからは分からない。
 * 分からないものを片方の理由で書くと、もう片方の週の読み方が必ず狂う。
 */
function defaultMissingWeekNote(missingWeekCount: number): string {
  return (
    `値を出していない週が ${missingWeekCount} 週あります（線も繋いでいません）。` +
    "空白が収集の穴なのか標本不足なのかは、同じページの収集状態とカバレッジの説明で確かめられます。"
  );
}

function defaultFormatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** "2026-07-20" → "7/20"。週が 52 個並ぶので軸では短く出す。 */
function formatWeekLabel(week: string): string {
  const [, month, day] = week.split("-");
  if (month === undefined || day === undefined) return week;
  return `${Number(month)}/${Number(day)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/*
 * 系列色は 1 色相（青）の順序尺度。中央値 → p75 → p90 と淡くなり、
 * 「同じ指標の別の分位点」であることが色でも伝わる（ADR-0004: 中央値の主線に p75 / p90 を薄く重ねる）。
 * ライト / ダークそれぞれの背景に対して検証済みの段を選んでいる。
 * 色だけに頼らないよう、主線と補助線は太さも変え、2 系列以上では必ず凡例を出す。
 */
const CHART_CSS = `
  .fk-chart {
    margin: 0 0 2rem;
    --fk-ink-muted: color-mix(in srgb, currentColor 65%, transparent);
    --fk-axis: color-mix(in srgb, currentColor 18%, transparent);
    --fk-series-0: #1c5cab;
    --fk-series-1: #2a78d6;
    --fk-series-2: #5598e7;
    --fk-series-3: #86b6ef;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .fk-chart {
      --fk-series-0: #9ec5f4;
      --fk-series-1: #6da7ec;
      --fk-series-2: #3987e5;
      --fk-series-3: #256abf;
    }
  }
  :root[data-theme="dark"] .fk-chart {
    --fk-series-0: #9ec5f4;
    --fk-series-1: #6da7ec;
    --fk-series-2: #3987e5;
    --fk-series-3: #256abf;
  }
  .fk-chart figcaption { font-weight: 600; margin-bottom: 0.25rem; }
  .fk-chart__svg { max-width: 100%; height: auto; overflow: visible; }
  .fk-chart__grid line { stroke: var(--fk-axis); stroke-width: 1; }
  .fk-chart__tick { fill: var(--fk-ink-muted); font-size: 11px; text-anchor: end; }
  .fk-chart__tick--x { text-anchor: middle; }
  .fk-chart__week { stroke: var(--fk-axis); stroke-width: 1; }
  .fk-chart__week--missing { stroke-dasharray: 1 2; }
  .fk-chart__line { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .fk-chart__line--secondary { stroke-width: 1.5; }
  .fk-chart__dot { stroke: Canvas; stroke-width: 2; }
  .fk-chart__series--0 .fk-chart__line { stroke: var(--fk-series-0); }
  .fk-chart__series--0 .fk-chart__dot { fill: var(--fk-series-0); }
  .fk-chart__series--1 .fk-chart__line { stroke: var(--fk-series-1); }
  .fk-chart__series--1 .fk-chart__dot { fill: var(--fk-series-1); }
  .fk-chart__series--2 .fk-chart__line { stroke: var(--fk-series-2); }
  .fk-chart__series--2 .fk-chart__dot { fill: var(--fk-series-2); }
  .fk-chart__series--3 .fk-chart__line { stroke: var(--fk-series-3); }
  .fk-chart__series--3 .fk-chart__dot { fill: var(--fk-series-3); }
  .fk-chart__legend {
    display: flex; flex-wrap: wrap; gap: 0.25rem 1rem;
    list-style: none; margin: 0.25rem 0 0; padding: 0; font-size: 0.875rem;
  }
  .fk-chart__legend li { display: flex; align-items: center; gap: 0.35rem; }
  .fk-chart__swatch { display: inline-block; width: 0.75rem; height: 0.75rem; border-radius: 50%; }
  .fk-chart__swatch--0 { background: var(--fk-series-0); }
  .fk-chart__swatch--1 { background: var(--fk-series-1); }
  .fk-chart__swatch--2 { background: var(--fk-series-2); }
  .fk-chart__swatch--3 { background: var(--fk-series-3); }
  .fk-chart__note, .fk-chart__empty { color: var(--fk-ink-muted); font-size: 0.875rem; margin: 0.25rem 0 0; }
`;
