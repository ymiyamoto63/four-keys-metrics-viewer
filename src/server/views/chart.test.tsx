import { describe, expect, it } from "vitest";
import { WeeklyLineChart, type WeeklySeries } from "./chart.tsx";

/**
 * 描画結果の SVG 文字列そのものを検査する。
 *
 * #19 の要点は「欠損週を補間しない」こと（ADR-0004）で、これは目視では簡単に見落とす。
 * 週ごとの目盛り（`<line data-week>`）から各週の x 座標を読み取り、
 * **欠損週の x をまたぐ線分が 1 本も存在しないこと**を座標レベルで固定する。
 */

const WEEKS = ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03"];
const MISSING_WEEK = "2026-07-20";

function render(node: unknown): string {
  return String(node);
}

/** 単純なタグ抽出。属性を名前で引けるようにする。 */
function tagsOf(html: string, tagName: string): Record<string, string>[] {
  const tagPattern = new RegExp(`<${tagName}\\b([^>]*)>`, "g");
  return [...html.matchAll(tagPattern)].map((match) => {
    const attrs: Record<string, string> = {};
    for (const attr of (match[1] ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)) {
      const [, name, value] = attr;
      if (name !== undefined && value !== undefined) attrs[name] = value;
    }
    return attrs;
  });
}

/** 週ごとの目盛りから「週 → x 座標」を復元する。 */
function weekXs(html: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const attrs of tagsOf(html, "line")) {
    const week = attrs["data-week"];
    const x1 = attrs.x1;
    if (week !== undefined && x1 !== undefined) map.set(week, Number(x1));
  }
  return map;
}

/** `d` 属性を `[x, y]` の列に戻す。 */
function pointsOf(d: string): [number, number][] {
  return [...d.matchAll(/[ML]\s*(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

function pathsOf(html: string, seriesName: string): string[] {
  return tagsOf(html, "path")
    .filter((attrs) => attrs["data-series"] === seriesName)
    .map((attrs) => attrs.d ?? "");
}

const MEDIAN: WeeklySeries = {
  name: "中央値",
  points: [
    { week: "2026-07-06", value: 10 },
    { week: "2026-07-13", value: 8 },
    { week: "2026-07-20", value: null },
    { week: "2026-07-27", value: 15 },
    { week: "2026-08-03", value: 11 },
  ],
};

describe("欠損週を補間しない", () => {
  it("欠損週をまたぐ線分を 1 本も描かない", () => {
    const html = render(
      <WeeklyLineChart title="変更のリードタイム" weeks={WEEKS} series={[MEDIAN]} />,
    );

    const missingX = weekXs(html).get(MISSING_WEEK);
    expect(missingX).toBeDefined();

    const paths = pathsOf(html, "中央値");
    expect(paths.length).toBeGreaterThan(0);

    // 欠損週の x を内側に含む線分が 1 本でもあれば、それは補間された線。
    for (const d of paths) {
      const points = pointsOf(d);
      for (let i = 1; i < points.length; i += 1) {
        const [x1] = points[i - 1] ?? [0, 0];
        const [x2] = points[i] ?? [0, 0];
        expect(
          Math.min(x1, x2) < (missingX ?? 0) && (missingX ?? 0) < Math.max(x1, x2),
          `欠損週 ${MISSING_WEEK} をまたぐ線分が描かれている: ${d}`,
        ).toBe(false);
      }
    }
  });

  it("欠損週で区間が分かれ、区間ごとに別々の path になる", () => {
    const html = render(
      <WeeklyLineChart title="変更のリードタイム" weeks={WEEKS} series={[MEDIAN]} />,
    );

    const paths = pathsOf(html, "中央値");
    expect(paths).toHaveLength(2);
    expect(pointsOf(paths[0] ?? "")).toHaveLength(2);
    expect(pointsOf(paths[1] ?? "")).toHaveLength(2);
  });

  it("欠損週には点を打たない", () => {
    const html = render(
      <WeeklyLineChart title="変更のリードタイム" weeks={WEEKS} series={[MEDIAN]} />,
    );

    const dotWeeks = tagsOf(html, "circle").map((attrs) => attrs["data-week"]);
    expect(dotWeeks).toEqual(["2026-07-06", "2026-07-13", "2026-07-27", "2026-08-03"]);
    expect(dotWeeks).not.toContain(MISSING_WEEK);
  });

  it("系列に現れない週も欠損として扱う（値 null と同じ）", () => {
    // 呼び出し側が「データ不足の週を配列から落とす」実装でも補間されないことを固定する。
    const sparse: WeeklySeries = {
      name: "中央値",
      points: MEDIAN.points.filter((p) => p.value !== null),
    };
    const html = render(
      <WeeklyLineChart title="変更のリードタイム" weeks={WEEKS} series={[sparse]} />,
    );

    expect(pathsOf(html, "中央値")).toHaveLength(2);
    expect(tagsOf(html, "circle").map((a) => a["data-week"])).not.toContain(MISSING_WEEK);
  });

  it("前後が欠損した孤立した週は、点だけ描いて線を引かない", () => {
    const isolated: WeeklySeries = {
      name: "中央値",
      points: [
        { week: "2026-07-06", value: null },
        { week: "2026-07-13", value: 8 },
        { week: "2026-07-20", value: null },
        { week: "2026-07-27", value: null },
        { week: "2026-08-03", value: 11 },
      ],
    };
    const html = render(<WeeklyLineChart title="デプロイ頻度" weeks={WEEKS} series={[isolated]} />);

    expect(pathsOf(html, "中央値")).toHaveLength(0);
    expect(tagsOf(html, "circle").map((a) => a["data-week"])).toEqual(["2026-07-13", "2026-08-03"]);
  });

  it("全週が欠損している系列は線も点も描かない", () => {
    const html = render(
      <WeeklyLineChart
        title="デプロイ頻度"
        weeks={WEEKS}
        series={[
          { name: "中央値", points: WEEKS.map((week) => ({ week, value: null })) },
          { name: "p75", points: [{ week: "2026-07-13", value: 3 }] },
        ]}
      />,
    );

    expect(pathsOf(html, "中央値")).toHaveLength(0);
    expect(tagsOf(html, "circle").map((a) => a["data-series"])).toEqual(["p75"]);
  });

  it("欠損週は目盛りの上で「値のない週」として印が付く", () => {
    const html = render(
      <WeeklyLineChart title="変更のリードタイム" weeks={WEEKS} series={[MEDIAN]} />,
    );

    const ticks = tagsOf(html, "line").filter((a) => a["data-week"] !== undefined);
    expect(ticks).toHaveLength(WEEKS.length);
    const missing = ticks.filter((a) => a["data-has-value"] === "false");
    expect(missing.map((a) => a["data-week"])).toEqual([MISSING_WEEK]);
    expect(html).toContain("線も繋いでいません");
  });
});

describe("複数系列の重ね描き", () => {
  const series: WeeklySeries[] = [
    { ...MEDIAN, role: "primary" },
    {
      name: "p75",
      role: "secondary",
      points: WEEKS.map((week, i) => ({ week, value: week === MISSING_WEEK ? null : 14 + i })),
    },
    {
      name: "p90",
      role: "secondary",
      points: WEEKS.map((week, i) => ({ week, value: week === MISSING_WEEK ? null : 20 + i })),
    },
  ];

  it("中央値の主線に p75 / p90 を重ね、いずれも欠損週で切れる", () => {
    const html = render(
      <WeeklyLineChart title="変更のリードタイム" weeks={WEEKS} series={series} unitLabel="時間" />,
    );

    for (const name of ["中央値", "p75", "p90"]) {
      expect(pathsOf(html, name), `${name} が欠損週で切れていない`).toHaveLength(2);
    }
  });

  it("補助線は主線と別のクラス・別の色スロットで描く", () => {
    const html = render(
      <WeeklyLineChart title="変更のリードタイム" weeks={WEEKS} series={series} />,
    );

    const primary = tagsOf(html, "path").filter((a) => a["data-series"] === "中央値");
    const secondary = tagsOf(html, "path").filter((a) => a["data-series"] === "p90");
    expect(primary.every((a) => a.class === "fk-chart__line")).toBe(true);
    expect(secondary.every((a) => a.class?.includes("fk-chart__line--secondary"))).toBe(true);
    expect(html).toContain("fk-chart__series--0");
    expect(html).toContain("fk-chart__series--2");
  });

  it("2 系列以上では凡例を出す（色だけで識別させない）", () => {
    const html = render(
      <WeeklyLineChart title="変更のリードタイム" weeks={WEEKS} series={series} />,
    );

    expect(html).toContain('<ul class="fk-chart__legend">');
    for (const name of ["中央値", "p75", "p90"]) {
      expect(html).toContain(`</span>${name}</li>`);
    }
  });

  it("1 系列のときは凡例を出さない", () => {
    const html = render(<WeeklyLineChart title="デプロイ頻度" weeks={WEEKS} series={[MEDIAN]} />);

    expect(html).not.toContain('<ul class="fk-chart__legend">');
  });
});

describe("点からの遷移", () => {
  it("値のある週の点が指標詳細へのリンクになる（#20 → #21）", () => {
    const html = render(
      <WeeklyLineChart
        title="デプロイ頻度"
        weeks={WEEKS}
        series={[MEDIAN]}
        pointHref={(week) => `/scopes/acme%2Fweb/metrics/lead-time?week=${week}`}
      />,
    );

    const links = tagsOf(html, "a");
    expect(links.map((a) => a.href)).toEqual([
      "/scopes/acme%2Fweb/metrics/lead-time?week=2026-07-06",
      "/scopes/acme%2Fweb/metrics/lead-time?week=2026-07-13",
      "/scopes/acme%2Fweb/metrics/lead-time?week=2026-07-27",
      "/scopes/acme%2Fweb/metrics/lead-time?week=2026-08-03",
    ]);
    // 欠損週の点は存在しないので、リンクも生まれない。
    expect(html).not.toContain(`week=${MISSING_WEEK}`);
  });

  it("pointHref が undefined を返した週はリンクにしない", () => {
    const html = render(
      <WeeklyLineChart
        title="デプロイ頻度"
        weeks={WEEKS}
        series={[MEDIAN]}
        pointHref={(week) => (week === "2026-07-06" ? "/detail" : undefined)}
      />,
    );

    expect(tagsOf(html, "a")).toHaveLength(1);
  });

  it("pointHref が渡されなければリンクを作らない", () => {
    const html = render(<WeeklyLineChart title="デプロイ頻度" weeks={WEEKS} series={[MEDIAN]} />);

    expect(tagsOf(html, "a")).toHaveLength(0);
  });

  it("リンクと系列名はエスケープされる", () => {
    const html = render(
      <WeeklyLineChart
        title="デプロイ頻度"
        weeks={WEEKS}
        series={[{ name: '<script>"x"', points: MEDIAN.points }]}
        pointHref={() => "/detail?a=1&b=2"}
      />,
    );

    expect(html).toContain("/detail?a=1&amp;b=2");
    expect(html).not.toContain("<script>");
  });
});

describe("軸と空データ", () => {
  it("y 軸は 0 起点で、目盛りが切りの良い値になる", () => {
    const html = render(<WeeklyLineChart title="デプロイ頻度" weeks={WEEKS} series={[MEDIAN]} />);

    // 最大値 15 に対し、目盛りは 5 刻みの 0〜20 に丸められる。
    const labels = [...html.matchAll(/<text class="fk-chart__tick"[^>]*>([^<]*)</g)].map(
      (m) => m[1],
    );
    expect(labels).toEqual(["0", "5", "10", "15", "20"]);
  });

  it("週が 1 つも無ければ、線ではなく説明を出す", () => {
    const html = render(<WeeklyLineChart title="デプロイ頻度" weeks={[]} series={[]} />);

    expect(html).toContain("表示できるデータがありません");
    expect(tagsOf(html, "path")).toHaveLength(0);
  });

  it("全系列が欠損だけなら、線ではなく説明を出す", () => {
    const html = render(
      <WeeklyLineChart
        title="デプロイ頻度"
        weeks={WEEKS}
        series={[{ name: "中央値", points: WEEKS.map((week) => ({ week, value: null })) }]}
      />,
    );

    expect(html).toContain("表示できるデータがありません");
  });
});
