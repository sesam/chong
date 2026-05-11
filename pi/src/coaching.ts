import Anthropic from "@anthropic-ai/sdk";

const SYSTEM = `You are a senior code reviewer giving brief, specific coaching on a single commit.
Output exactly these sections, terse, single short paragraph each:
  1. What it does
  2. What's good
  3. Issues — reference file:line where possible
  4. Open questions for the author
  5. Complexity (1-5) — one digit, then a half-sentence justification
No filler, no preamble, no closing remarks.`;

export async function generateCoaching(
  apiKey: string,
  opts: { sha: string; repo: string; message: string; diff: string },
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const truncated =
    opts.diff.length > 60_000 ? `${opts.diff.slice(0, 60_000)}\n…(truncated)` : opts.diff;
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Repo: ${opts.repo}\nSHA: ${opts.sha}\n\nCommit message:\n${opts.message}\n\n--- diff ---\n${truncated}`,
      },
    ],
  });
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
