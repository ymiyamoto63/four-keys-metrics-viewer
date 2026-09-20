/**
 * 週バケット（**JST 月曜 00:00 始まり**）。指標計算の共通土台（#16 / ADR-0004）。
 *
 * ここは純粋関数だけに保つ。DB も GitHub も触らない（`collector/window.ts` と同じ方針）。
 * デプロイ頻度（#17）も変更のリードタイム（#18）も、週への割り当てはここだけを通す。
 * 週の定義が 2 箇所にあると、2 つの指標が別の週境界で集計されても誰も気付けない。
 *
 * ## なぜ JST 月曜始まりか
 *
 * ADR-0004。利用者が日本チームであり、UTC 週境界だと月曜午前のデプロイが前週に落ちて
 * 直感に反する。
 *
 * ## なぜ `Intl` ではなく固定オフセット (+09:00) か
 *
 * 日本には現行のサマータイムが無く、JST は 1948〜1951 年の夏時刻を除いて常に UTC+09:00 である。
 * 本アプリが扱うのはバックフィル範囲（既定 1 年・ADR-0003）の GitHub 履歴なので、
 * オフセットが動く時期には決して触れない。
 *
 * 固定オフセットを選ぶ理由は「速いから」ではなく **テストできるから**である。
 * `Intl.DateTimeFormat` 経由にすると、週境界の計算結果が実行環境の ICU データと
 * タイムゾーン DB のバージョンに依存する。境界そのものを検証したい（#16）のに、
 * 検証対象が環境ごとに変わるのでは意味がない。ここは算術だけで閉じる。
 *
 * 将来、複数タイムゾーンを扱う必要が出たら、オフセットを引数に取る形へ広げる。
 * そのときも「固定オフセット 1 つ」という前提がここに閉じていることが効く。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** JST = UTC+09:00。上のコメントの理由で定数として持つ。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 1970-01-01（エポック日 0）は**木曜**。月曜始まりの週に直すため、
 * 「月曜から何日目か」を求めるときにこの分だけずらす。
 */
const EPOCH_DAY_OFFSET_TO_MONDAY = 3;

/**
 * 週バケット 1 つ。範囲は **`[startedAt, endedAt)` の半開区間**として扱う。
 *
 * 閉区間にすると JST 月曜 00:00 ちょうどのデプロイが 2 つの週の両方に入り、
 * 週あたり回数（#17）が二重計上される。境界の帰属は「その週の始まり」に倒す。
 */
export type Week = {
  /** 週の開始時刻（JST 月曜 00:00）を UTC の ISO8601 で表したもの。 */
  startedAt: string;
  /** 次の週の開始時刻。この時刻自身はこの週に**含まない**。 */
  endedAt: string;
  /** 週の識別子。**JST での月曜の日付** `YYYY-MM-DD`。画面のラベルと返り値のキーに使う。 */
  key: string;
};

/** 集計の対象期間。両端とも ISO8601。 */
export type Period = {
  from: string;
  to: string;
};

/**
 * その時刻が属する週の開始時刻（JST 月曜 00:00）を UTC の ISO8601 で返す。
 *
 * 入力は **UTC で保存された ISO8601**（`commits.committed_at` などストアの値）を想定する。
 * オフセット付きの文字列でも `Date.parse` が同じ瞬間に解決するので結果は変わらない。
 */
export function weekStartOf(instant: string | Date): string {
  return new Date(weekStartMsOf(instant)).toISOString();
}

/** その時刻が属する週バケットを返す。 */
export function weekOf(instant: string | Date): Week {
  return weekFromStartMs(weekStartMsOf(instant));
}

/**
 * 期間に重なる週を、古い順に並べて返す。
 *
 * 両端の時刻が属する週を**含む**。デプロイが 1 件も無い週（#17 の「本物の値 0」）は
 * 生イベント側からは決して現れないため、週の並びは必ず期間から作る。
 */
export function weeksBetween(period: Period): Week[] {
  const fromMs = weekStartMsOf(period.from);
  const toMs = weekStartMsOf(period.to);
  if (toMs < fromMs) {
    // 逆順の期間を黙って空配列にすると、画面には「収集できていない」と区別の付かない
    // 空のグラフが出る。呼び出し側のバグとして落とす。
    throw new Error(`集計期間の終端が始端より前です: ${period.from} 〜 ${period.to}`);
  }

  const weeks: Week[] = [];
  for (let startMs = fromMs; startMs <= toMs; startMs += 7 * MS_PER_DAY) {
    weeks.push(weekFromStartMs(startMs));
  }
  return weeks;
}

/**
 * 標本を週バケットへ振り分ける。キーは `Week.key`。
 *
 * 週の並び自体は返さない（`weeksBetween` の担当）。**ここに現れない週は「0 件」であって
 * 「データなし」ではない**という区別は #17 が収集カバレッジ（`coverage.ts`）と
 * 突き合わせて決める。
 */
export function bucketByWeek<T>(
  items: Iterable<T>,
  instantOf: (item: T) => string | Date,
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = weekOf(instantOf(item)).key;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }
  return buckets;
}

/**
 * ISO8601 をミリ秒に直す。
 *
 * 壊れた時刻を黙って 1970 年に落とすと、その標本だけが遠い過去の週へ移動し、
 * グラフ上は「そういう週があった」ようにしか見えない。必ず落とす。
 */
export function parseInstant(value: string | Date, label = "時刻"): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${label}が ISO8601 として読めません: ${String(value)}`);
  }
  return ms;
}

function weekStartMsOf(instant: string | Date): number {
  const utcMs = parseInstant(instant);
  // JST の壁時計を「UTC 上の数値」として扱い、算術だけで日付の切り出しをする。
  const jstMs = utcMs + JST_OFFSET_MS;
  const jstDay = Math.floor(jstMs / MS_PER_DAY);
  // 1970 年より前は剰余が負になりうる。扱う範囲ではないが、静かに壊れるより揃えておく。
  const daysSinceMonday = (((jstDay + EPOCH_DAY_OFFSET_TO_MONDAY) % 7) + 7) % 7;
  const weekStartJstMs = (jstDay - daysSinceMonday) * MS_PER_DAY;
  return weekStartJstMs - JST_OFFSET_MS;
}

function weekFromStartMs(startMs: number): Week {
  return {
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(startMs + 7 * MS_PER_DAY).toISOString(),
    // 週開始時刻は JST 月曜 00:00 なので、JST へ寄せた値の日付部分がそのまま週のラベルになる。
    key: new Date(startMs + JST_OFFSET_MS).toISOString().slice(0, 10),
  };
}
