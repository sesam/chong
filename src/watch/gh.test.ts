import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { checkState, checkStatesBatch, observedGitHubQuota, resetGhCacheForTest } from "./gh";

const origToken = process.env.GH_TOKEN;

afterEach(() => {
  resetGhCacheForTest();
  process.env.GH_TOKEN = origToken ?? "";
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("GitHub API CI polling optimizations", () => {
  test("caches terminal pass verdict and only re-fetches on force: true", async () => {
    process.env.GH_TOKEN = "ghp_test";
    let calls = 0;
    spyOn(globalThis, "fetch").mockImplementation((async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success" }] }),
        {
          status: 200,
          headers: {
            etag: '"etag-1"',
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4990",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      );
    }) as unknown as typeof fetch);

    expect(await checkState("org/repo", "aaaaaaa1111111", "/tmp")).toBe("pass");
    expect(await checkState("org/repo", "aaaaaaa1111111", "/tmp")).toBe("pass");
    expect(calls).toBe(1);

    // Explicit force bypasses cache.
    expect(await checkState("org/repo", "aaaaaaa1111111", "/tmp", { force: true })).toBe("pass");
    expect(calls).toBe(2);
  });

  test("batches 2+ cold SHAs into one aliased GraphQL query and records rateLimit", async () => {
    process.env.GH_TOKEN = "ghp_test";
    const urls: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          data: {
            rateLimit: {
              limit: 5000,
              remaining: 4800,
              resetAt: new Date(Date.now() + 3600_000).toISOString(),
            },
            repository: {
              c0: {
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: { nodes: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
                },
              },
              c1: {
                statusCheckRollup: {
                  state: "PENDING",
                  contexts: { nodes: [{ status: "IN_PROGRESS", conclusion: null }] },
                },
              },
              c2: {
                statusCheckRollup: {
                  state: "FAILURE",
                  contexts: { nodes: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
                },
              },
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch);

    const shaA = "1111111111111111111111111111111111111111";
    const shaB = "2222222222222222222222222222222222222222";
    const shaC = "3333333333333333333333333333333333333333";
    const res = await checkStatesBatch("org/repo", [shaA, shaB, shaC], "/tmp");

    expect(urls).toEqual(["https://api.github.com/graphql"]);
    expect(res.get(shaA)).toBe("pass");
    expect(res.get(shaB)).toBe("pending");
    expect(res.get(shaC)).toBe("fail");
    expect(observedGitHubQuota().graphql?.remaining).toBe(4800);
  });

  test("coalesces concurrent in-flight lookups for the same SHA", async () => {
    process.env.GH_TOKEN = "ghp_test";
    let calls = 0;
    spyOn(globalThis, "fetch").mockImplementation((async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return new Response(
        JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch);

    const [a, b] = await Promise.all([
      checkState("org/repo", "bbbbbbb2222222", "/tmp"),
      checkState("org/repo", "bbbbbbb2222222", "/tmp"),
    ]);
    expect(a).toBe("pass");
    expect(b).toBe("pass");
    expect(calls).toBe(1);
  });

  test("respects 10% REST quota reserve and switches/pauses cleanly", async () => {
    process.env.GH_TOKEN = "ghp_test";
    let restCalls = 0;
    let gqlCalls = 0;
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/graphql")) {
        gqlCalls += 1;
        return new Response(
          JSON.stringify({
            data: {
              rateLimit: {
                limit: 5000,
                remaining: 4500,
                resetAt: new Date(Date.now() + 3600_000).toISOString(),
              },
              repository: {
                c0: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } } },
              },
            },
          }),
          { status: 200 },
        );
      }
      restCalls += 1;
      return new Response(
        JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success" }] }),
        {
          status: 200,
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "100", // below 10% (500) reserve
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      );
    }) as unknown as typeof fetch);

    // First call observes low REST quota.
    expect(await checkState("org/repo", "ccccccc3333333", "/tmp")).toBe("pass");
    expect(restCalls).toBe(1);
    // Next cold SHA routes to GraphQL instead of exhausting REST!
    expect(await checkState("org/repo", "ddddddd4444444", "/tmp")).toBe("pass");
    expect(restCalls).toBe(1);
    expect(gqlCalls).toBe(1);
  });
});
