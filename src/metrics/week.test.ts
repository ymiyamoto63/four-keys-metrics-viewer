import { describe, expect, it } from "vitest";
import { bucketByWeek, weekOf, weekStartOf, weeksBetween } from "./week.ts";

describe("週の開始時刻（JST 月曜 00:00 始まり）", () => {
  it("JST 月曜 00:00 は UTC 日曜 15:00 である", () => {
    // ここが JST 集計の全体を支える等式。UTC 保存のまま週に割るとここが崩れる。
    expect(weekStartOf("2026-09-14T00:00:00+09:00")).toBe("2026-09-13T15:00:00.000Z");
  });

  it("週の境目ちょうどは新しい週に属する（半開区間）", () => {
    expect(weekOf("2026-09-13T15:00:00.000Z").key).toBe("2026-09-14");
  });

  it("境目の 1 ミリ秒前は前の週に属する", () => {
    expect(weekOf("2026-09-13T14:59:59.999Z").key).toBe("2026-09-07");
  });

  it("境目の 1 ミリ秒後は新しい週に属する", () => {
    expect(weekOf("2026-09-13T15:00:00.001Z").key).toBe("2026-09-14");
  });

  it("週の終端時刻は、その週ではなく次の週に属する", () => {
    const week = weekOf("2026-09-15T02:00:00Z");

    expect(week.endedAt).toBe("2026-09-20T15:00:00.000Z");
    expect(weekOf(week.endedAt).key).not.toBe(week.key);
  });

  it("週の識別子は JST での月曜の日付になる", () => {
    // UTC の日付（2026-09-13）ではなく JST の日付（2026-09-14）。画面のラベルに直結する。
    expect(weekOf("2026-09-20T04:30:00Z")).toEqual({
      startedAt: "2026-09-13T15:00:00.000Z",
      endedAt: "2026-09-20T15:00:00.000Z",
      key: "2026-09-14",
    });
  });

  it("UTC の同じ日曜でも、15:00 をまたぐと別の週になる", () => {
    expect(weekOf("2026-09-13T14:00:00Z").key).toBe("2026-09-07");
    expect(weekOf("2026-09-13T15:00:00Z").key).toBe("2026-09-14");
  });

  it("Date でも ISO8601 文字列でも同じ週になる", () => {
    expect(weekOf(new Date("2026-09-15T02:00:00Z"))).toEqual(weekOf("2026-09-15T02:00:00Z"));
  });

  it("時刻として読めない値は黙って 1970 年へ落とさずに落ちる", () => {
    expect(() => weekOf("きのう")).toThrow(/ISO8601/);
  });

  it("1 年分どの週も 7 日ちょうどで、サマータイムによるずれが無い", () => {
    // 固定オフセット (+09:00) を選んだ根拠そのもの。JST には現行のサマータイムが無いため、
    // 週の長さは年間を通して一定でよい（week.ts のコメント）。
    const weeks = weeksBetween({ from: "2025-09-20T00:00:00Z", to: "2026-09-20T00:00:00Z" });

    for (const [index, week] of weeks.entries()) {
      expect(Date.parse(week.endedAt) - Date.parse(week.startedAt), `${index} 番目の週の長さ`).toBe(
        7 * 24 * 60 * 60 * 1000,
      );
    }
    expect(weeks.length).toBe(53);
  });
});

describe("期間から週の並びを作る", () => {
  it("両端の時刻が属する週を含めて、古い順に並べる", () => {
    const weeks = weeksBetween({ from: "2026-08-31T00:00:00Z", to: "2026-09-20T00:00:00Z" });

    expect(weeks.map((week) => week.key)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
  });

  it("週をまたがない期間でも 1 週を返す（デプロイ 0 件の週を消さない）", () => {
    const weeks = weeksBetween({ from: "2026-09-15T00:00:00Z", to: "2026-09-15T23:59:59Z" });

    expect(weeks.map((week) => week.key)).toEqual(["2026-09-14"]);
  });

  it("終端が始端より前なら、空のグラフを返さずに落ちる", () => {
    expect(() =>
      weeksBetween({ from: "2026-09-20T00:00:00Z", to: "2026-08-31T00:00:00Z" }),
    ).toThrow(/集計期間/);
  });
});

describe("標本を週へ振り分ける", () => {
  it("週の識別子ごとにまとめる", () => {
    const samples = [
      { at: "2026-09-13T14:59:59.999Z" },
      { at: "2026-09-13T15:00:00.000Z" },
      { at: "2026-09-15T02:00:00.000Z" },
    ];

    const buckets = bucketByWeek(samples, (sample) => sample.at);

    expect(buckets.get("2026-09-07")).toHaveLength(1);
    expect(buckets.get("2026-09-14")).toHaveLength(2);
  });

  it("同一時刻の標本を 1 件に潰さない", () => {
    // 同一時刻の複数デプロイ（#16 の境界条件）。時刻で重複排除すると回数が減る。
    const buckets = bucketByWeek(
      [
        { sha: "a", at: "2026-09-15T02:00:00Z" },
        { sha: "b", at: "2026-09-15T02:00:00Z" },
      ],
      (sample) => sample.at,
    );

    expect(buckets.get("2026-09-14")).toHaveLength(2);
  });

  it("標本が無い週は現れない（週の並びは期間から作る）", () => {
    expect(bucketByWeek([], () => "2026-09-15T02:00:00Z").size).toBe(0);
  });
});
