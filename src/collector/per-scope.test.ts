import { describe, expect, it } from "vitest";
import { findCollectionCursor, saveCollectionCursor } from "../db/store.ts";
import { openTestDatabase } from "../db/testing.ts";
import { GitHubRateLimitError, GitHubRequestError } from "../github/client.ts";
import { collectPerScope } from "./per-scope.ts";

describe("スコープ単位の失敗分離", () => {
  it("1 スコープが 403 で落ちても、残りのスコープは最後まで収集する", async () => {
    const db = openTestDatabase();
    const collected: string[] = [];

    const outcome = await collectPerScope(
      db,
      ["scope-a", "scope-b", "scope-c"],
      async (scopeId) => {
        collected.push(scopeId);
        if (scopeId === "scope-b") {
          throw new GitHubRequestError(403, "https://api.github.com/repos/o/b/commits", "");
        }
      },
    );

    expect(collected).toEqual(["scope-a", "scope-b", "scope-c"]);
    expect(outcome.succeeded).toEqual(["scope-a", "scope-c"]);
    expect(outcome.failed).toEqual(["scope-b"]);
    expect(outcome.rateLimited).toBe(false);
  });

  it("404 でも同じく他スコープを巻き込まない", async () => {
    const db = openTestDatabase();

    const outcome = await collectPerScope(db, ["scope-a", "scope-b"], async (scopeId) => {
      if (scopeId === "scope-a") {
        throw new GitHubRequestError(404, "https://api.github.com/repos/o/a/commits", "Not Found");
      }
    });

    expect(outcome.failed).toEqual(["scope-a"]);
    expect(outcome.succeeded).toEqual(["scope-b"]);
  });

  it("成功したスコープには最終収集成功時刻が入り、直前の失敗が消える", async () => {
    const db = openTestDatabase();
    saveCollectionCursor(db, {
      scopeId: "scope-a",
      backfilledUntil: "2025-09-20T00:00:00Z",
      backfillComplete: true,
      followedUntil: null,
      lastSuccessAt: null,
      lastError: "401 Bad credentials",
    });

    await collectPerScope(db, ["scope-a"], async () => {});

    const cursor = findCollectionCursor(db, "scope-a");
    expect(cursor?.lastSuccessAt).not.toBeNull();
    expect(cursor?.lastError).toBeNull();
    // バックフィルの進捗は収集サイクルの成否とは別に進む（#12）。
    expect(cursor?.backfilledUntil).toBe("2025-09-20T00:00:00Z");
    expect(cursor?.backfillComplete).toBe(true);
  });

  it("失敗したスコープは、最終収集成功時刻を保ったまま理由を残す", async () => {
    const db = openTestDatabase();
    saveCollectionCursor(db, {
      scopeId: "scope-a",
      backfilledUntil: null,
      backfillComplete: false,
      followedUntil: null,
      lastSuccessAt: "2026-09-19T05:00:00Z",
      lastError: null,
    });

    await collectPerScope(db, ["scope-a"], async () => {
      throw new GitHubRequestError(
        401,
        "https://api.github.com/repos/o/a/commits",
        "Bad credentials",
      );
    });

    const cursor = findCollectionCursor(db, "scope-a");
    // 画面（#20）が「いつから古いか」と「なぜ止まったか」を同時に出せる状態。
    expect(cursor?.lastSuccessAt).toBe("2026-09-19T05:00:00Z");
    expect(cursor?.lastError).toContain("401");
  });

  it("GitHub 由来でない例外でも、他スコープを止めない", async () => {
    const db = openTestDatabase();

    const outcome = await collectPerScope(db, ["scope-a", "scope-b"], async (scopeId) => {
      if (scopeId === "scope-a") {
        throw new TypeError("fetch failed");
      }
    });

    expect(outcome.failed).toEqual(["scope-a"]);
    expect(outcome.succeeded).toEqual(["scope-b"]);
    expect(findCollectionCursor(db, "scope-a")?.lastError).toContain("fetch failed");
  });
});

describe("レート制限のときだけ収集サイクル全体を中断する", () => {
  it("以降のスコープには着手せず、次の収集サイクルに委ねる", async () => {
    const db = openTestDatabase();
    const collected: string[] = [];

    const outcome = await collectPerScope(
      db,
      ["scope-a", "scope-b", "scope-c"],
      async (scopeId) => {
        collected.push(scopeId);
        if (scopeId === "scope-b") {
          throw new GitHubRateLimitError(
            "https://api.github.com/repos/o/b/commits",
            "2026-09-20T07:00:00Z",
            null,
          );
        }
      },
    );

    expect(collected).toEqual(["scope-a", "scope-b"]);
    expect(outcome.rateLimited).toBe(true);
    expect(outcome.skipped).toEqual(["scope-c"]);
    // 着手しなかったスコープの状態は壊さない（次回そのまま再開できる）。
    expect(findCollectionCursor(db, "scope-c")).toBeUndefined();
  });

  it("中断したスコープにも理由を残す", async () => {
    const db = openTestDatabase();

    await collectPerScope(db, ["scope-a"], async () => {
      throw new GitHubRateLimitError("https://api.github.com/repos/o/a/commits", null, 60);
    });

    expect(findCollectionCursor(db, "scope-a")?.lastError).toContain("レート制限");
  });
});
