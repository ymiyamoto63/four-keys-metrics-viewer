import { describe, expect, it } from "vitest";
import { MIN_SAMPLES, median, percentile, summarizeSamples } from "./statistics.ts";

describe("中央値", () => {
  it("奇数個なら真ん中の値", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("偶数個なら中央 2 件の平均（通常の中央値の定義）", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("p50 と同じ値になる（定義が 1 本の式で揃っている）", () => {
    const values = [5, 1, 9, 3, 7, 2];

    expect(median(values)).toBe(percentile(values, 50));
  });

  it("標本が無ければ値を返さない", () => {
    expect(median([])).toBeUndefined();
  });

  it("標本 1 件ならその値", () => {
    expect(median([42])).toBe(42);
  });

  it("外れ値 1 件では動かない（平均を使わない理由）", () => {
    expect(median([1, 2, 3, 4, 1000])).toBe(3);
  });
});

describe("パーセンタイル", () => {
  it("線形補間で前後 2 件を按分する（R type 7 / numpy・Excel の既定）", () => {
    // 順位 = (4 - 1) * 0.75 = 2.25 → 3 と 4 を 0.25 で按分。
    expect(percentile([1, 2, 3, 4], 75)).toBe(3.25);
  });

  it("小標本でも p75 と p90 が潰れない（nearest-rank を採らなかった理由）", () => {
    // nearest-rank だと標本 3 件では ceil(2.25) も ceil(2.7) も 3 番目で、
    // どちらも最大値になり「裾が伸びているか」が読めなくなる。
    const values = [1, 2, 10];

    expect(percentile(values, 75)).not.toBe(percentile(values, 90));
    expect(percentile(values, 75)).toBe(6);
    expect(percentile(values, 90)).toBe(8.4);
  });

  it("外れ値は裾に残る（中央値だけでは見えない事実を出す）", () => {
    const values = [1, 1, 1, 1, 1, 1, 1, 1, 1, 100];

    expect(median(values)).toBe(1);
    expect(percentile(values, 90)).toBeCloseTo(10.9, 10);
  });

  it("0 と 100 は最小値と最大値", () => {
    expect(percentile([4, 1, 3], 0)).toBe(1);
    expect(percentile([4, 1, 3], 100)).toBe(4);
  });

  it("標本が無ければ値を返さない", () => {
    expect(percentile([], 90)).toBeUndefined();
  });

  it("0〜100 の外なら落ちる", () => {
    expect(() => percentile([1, 2, 3], 101)).toThrow(/0〜100/);
    expect(() => percentile([1, 2, 3], -1)).toThrow(/0〜100/);
    expect(() => percentile([1, 2, 3], Number.NaN)).toThrow(/0〜100/);
  });
});

describe("標本の扱い", () => {
  it("入力が昇順でなくてよい", () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  it("入力配列を並べ替えない（ドリルダウンの並び順を黙って変えない）", () => {
    const values = [9, 1, 5];

    summarizeSamples(values, { minSamples: 1 });
    median(values);
    percentile(values, 90);

    expect(values).toEqual([9, 1, 5]);
  });

  it("NaN が混ざっていたら、黙って捨てずに落ちる", () => {
    // 捨てると代表値が「気付かないうちに減った標本」から計算される。
    expect(() => median([1, Number.NaN, 3])).toThrow(/数値でない値/);
  });

  it("Infinity が混ざっていたら落ちる", () => {
    expect(() => percentile([1, Number.POSITIVE_INFINITY], 90)).toThrow(/数値でない値/);
  });

  it("負の値は落とさない（時計のずれで負のリードタイムが起こりうる）", () => {
    expect(median([-60_000, 0, 60_000])).toBe(0);
  });

  it("同じ値ばかりでも代表値は出る（同一時刻に複数デプロイ → 間隔 0）", () => {
    expect(summarizeSamples([0, 0, 0])).toEqual({ count: 3, median: 0, p75: 0, p90: 0 });
  });
});

describe("代表値の要約とデータ不足のゲート", () => {
  it("標本が閾値以上なら中央値と p75 / p90 を返す", () => {
    expect(summarizeSamples([1, 2, 3, 4])).toEqual({
      count: 4,
      median: 2.5,
      p75: 3.25,
      p90: 3.7,
    });
  });

  it("標本が既定の閾値に満たない週は値を出さない（ADR-0004）", () => {
    // 折れ線を繋がないための undefined。0 ではない。
    expect(summarizeSamples([1, 2])).toBeUndefined();
    expect(summarizeSamples([1, 2, 3])).toMatchObject({ count: 3 });
    expect(MIN_SAMPLES).toBe(3);
  });

  it("標本が無ければ値を出さない", () => {
    expect(summarizeSamples([])).toBeUndefined();
  });

  it("ゲートの閾値は呼び出し側が選べる", () => {
    // リードタイム（#18）と副指標のデプロイ間隔中央値（#17）にだけ適用する決定なので、
    // 関数の中に埋め込まない。裾を重く読みたい側は閾値を上げられる。
    expect(summarizeSamples([1, 2, 3, 4], { minSamples: 10 })).toBeUndefined();
    expect(summarizeSamples([1, 2], { minSamples: 1 })).toMatchObject({ count: 2, median: 1.5 });
  });

  it("閾値が 1 未満や整数でなければ落ちる", () => {
    expect(() => summarizeSamples([1, 2, 3], { minSamples: 0 })).toThrow(/1 以上の整数/);
    expect(() => summarizeSamples([1, 2, 3], { minSamples: 1.5 })).toThrow(/1 以上の整数/);
  });

  it("要約の中央値と p75 / p90 は、個別に呼んだ結果と一致する", () => {
    const values = [8, 1, 5, 3, 13, 2];
    const summary = summarizeSamples(values);

    expect(summary).toEqual({
      count: values.length,
      median: median(values),
      p75: percentile(values, 75),
      p90: percentile(values, 90),
    });
  });
});
