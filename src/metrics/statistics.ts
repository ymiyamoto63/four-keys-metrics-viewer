/**
 * 指標の代表値（中央値・p75・p90）と、「データ点が少ない週は値を出さない」ゲート（#16 / ADR-0004）。
 *
 * デプロイ頻度（#17）の副指標「デプロイ間隔の中央値」と、変更のリードタイム（#18）の
 * 「中央値を主線、p75 / p90 も返す」が同じ式を使うため、共有の場所に置く。
 * 2 箇所で書くと、片方だけが分位の定義を変えても誰も気付けない。
 *
 * ここも純粋関数だけ。DB も GitHub も触らない。
 *
 * ## 平均は置かない
 *
 * ADR-0004 の決定。リードタイムは右に長い裾を引く分布で、平均は外れ値 1 件で跳ねる。
 * 「平均も一応あると便利」で置くと必ず使われるので、関数自体を用意しない。
 */

/**
 * 代表値を出すのに最低限必要な標本数。**ADR-0004「データ点が少ない週は値を出さず、
 * 線も繋がない」の実装上の唯一の数値。**
 *
 * ## なぜ 3 か
 *
 * 少数サンプルの中央値が嘘をつくのは、**外れ値 1 件が中央値を直接動かす**ためである。
 * 標本 1 件では中央値は外れ値そのもの、2 件では外れ値とその相方の平均になる。
 * 3 件以上あれば中央値は必ず「真ん中の観測値」になり、両端のどちらが跳ねても動かない。
 * ここが「中央値が意味を持ち始める」境目なので、既定をここに置く。
 *
 * ## なぜもっと上げないか
 *
 * ADR-0001 が `merge_only` を既定にした結果、週あたりのデプロイは少数になる
 * （ADR-0004 は「データ不足週を繋がないのは例外処理ではなく通常の表示状態になる」と書いている）。
 * 閾値を 5 や 10 にすると、副指標のデプロイ間隔中央値はほぼ全週で空白になる。
 * ADR-0004 が求めているのは「嘘の線を繋がないこと」であって「何も出ない画面」ではない。
 *
 * 裾（p75 / p90）を重く読みたい呼び出し側は `minSamples` で上書きできる。
 * 3 件の p90 は裾の形をほとんど語らないので、そこは呼び出し側の判断に開けてある。
 */
export const MIN_SAMPLES = 3;

/**
 * 中央値。標本が無ければ `undefined`。
 *
 * **ゲートはここに入れない。** ADR-0004 の「データ点が少ない週は値を出さない」は
 * リードタイム（#18）と副指標のデプロイ間隔中央値に適用され、**デプロイ頻度の
 * 週あたり回数には適用しない**（0 件は欠損ではなく本物の値 0。#17）。
 * 関数に埋め込むと、適用してはいけない側からも外せなくなる。
 */
export function median(values: readonly number[]): number | undefined {
  return percentile(values, 50);
}

/**
 * パーセンタイル。`p` は 0〜100。標本が無ければ `undefined`。
 *
 * ## 補間方法: 線形補間（R type 7 / numpy・pandas の既定 / Excel の `PERCENTILE.INC`）
 *
 * 順位 `(n - 1) * p / 100` を実数で求め、前後 2 件を線形に按分する。
 *
 * この方法を選んだ理由は 2 つ。
 *
 * 1. **中央値と分位の定義が 1 本の式で揃う。** `median(x)` は `percentile(x, 50)` そのもので、
 *    標本が偶数個のときは中央 2 件の平均という通常の中央値に一致する。定義が 2 本あると、
 *    「中央値は中央 2 件の平均なのに p50 は違う値」という説明不能な状態が生まれる。
 * 2. **利用者が手元で検算して同じ数字になる。** numpy / pandas / Excel の既定と同じなので、
 *    表計算に貼って確かめられる。柱 4（算出ロジックの開示）は「画面で辿れる」だけでなく
 *    「手で数えても合う」ことまで含む。ここがズレると数値そのものへの信頼が消える。
 *
 * ## nearest-rank を採らなかった理由
 *
 * `ceil(n * p / 100)` 番目の観測値を返す方法（R type 1）には「返る値が必ず実在の標本になる」
 * という利点があり、ドリルダウンとの相性は良い。それでも採らなかったのは、
 * **小標本で p75 と p90 が同じ値に潰れる**ためである（標本 3 件では
 * `ceil(2.25) = 3`、`ceil(2.7) = 3` でどちらも最大値）。
 * ADR-0004 が p75 / p90 を重ねる目的は「裾が伸びているかどうか」を見せることなので、
 * 少ない週ほど裾が潰れるのでは目的を果たせない。
 *
 * なお線形補間でも外れ値は消えない。1 件だけ極端に大きい標本があれば p90 は中央値から
 * 大きく離れる（`statistics.test.ts` で固定している）。
 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error(`パーセンタイルは 0〜100 の数値である必要があります: ${p}`);
  }
  const sorted = toSortedSamples(values);
  return sorted === undefined ? undefined : percentileOfSorted(sorted, p);
}

/** 代表値の組。**平均は持たない**（ADR-0004）。 */
export type SampleSummary = {
  /** 標本数。値を出した根拠として画面に添える（柱 4）。 */
  count: number;
  /** 主線。 */
  median: number;
  /** 裾。ADR-0004 は「p75 / p90 を薄く重ねる」と決めている。 */
  p75: number;
  p90: number;
};

export type SummarizeOptions = {
  /**
   * 値を出すのに必要な最小標本数。既定は `MIN_SAMPLES`。
   *
   * **ゲートを呼び出し側が選べるようにしてある。** リードタイム（#18）と
   * デプロイ間隔の中央値（#17 の副指標）には適用し、デプロイ頻度の週あたり回数には
   * 適用しない。回数はそもそもこの関数を通さない（0 件は本物の 0 であり、
   * 代表値ではないため）。`1` を渡せばゲートは実質無効になる。
   */
  minSamples?: number;
};

/**
 * 標本から代表値を出す。**標本が `minSamples` 未満なら `undefined`**
 * （ADR-0004「データ点が少ない週は値を出さず、線も繋がない」）。
 *
 * 週ごとに呼ぶことを想定している。`undefined` は「その週は値なし」であり、
 * **0 ではない。** 折れ線は繋がず、欠損として描く。
 */
export function summarizeSamples(
  values: readonly number[],
  options: SummarizeOptions = {},
): SampleSummary | undefined {
  const minSamples = options.minSamples ?? MIN_SAMPLES;
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    throw new Error(`最小標本数は 1 以上の整数である必要があります: ${minSamples}`);
  }

  const sorted = toSortedSamples(values);
  if (sorted === undefined || sorted.length < minSamples) {
    return undefined;
  }
  return {
    count: sorted.length,
    median: percentileOfSorted(sorted, 50),
    p75: percentileOfSorted(sorted, 75),
    p90: percentileOfSorted(sorted, 90),
  };
}

/**
 * 昇順にそろえた標本。空なら `undefined`。
 *
 * **入力配列は破壊しない**（呼び出し側が同じ配列から回数も数えるため。
 * 週の標本を並べ替えられると、ドリルダウンの並び順が黙って変わる）。
 */
function toSortedSamples(values: readonly number[]): number[] | undefined {
  if (values.length === 0) {
    return undefined;
  }
  for (const value of values) {
    // NaN / Infinity を黙って捨てると、代表値が「気付かないうちに減った標本」から計算される。
    // リードタイムに非有限値が来るのは上流（時刻の引き算）のバグなので、その場で落とす。
    // 負の値は落とさない: committer date は別の端末の時計なので、デプロイ時刻より
    // 後になること（＝負のリードタイム）が現実に起こりうる。扱いは呼び出し側が決める。
    if (!Number.isFinite(value)) {
      throw new Error(`標本に数値でない値が混ざっています: ${value}`);
    }
  }
  return [...values].sort((left, right) => left - right);
}

/** 昇順の標本に対する線形補間のパーセンタイル（上のコメントの定義）。 */
function percentileOfSorted(sorted: readonly number[], p: number): number {
  const rank = ((sorted.length - 1) * p) / 100;
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    // 空配列は `toSortedSamples` で弾いてあるので、ここには来ない。
    throw new Error(`パーセンタイルの順位が標本の範囲外です: ${rank}`);
  }
  return lower + (upper - lower) * (rank - lowerIndex);
}
