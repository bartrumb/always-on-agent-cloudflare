// =====================================================================================
// mock-model.ts: a scripted stand-in for Claude.
//
// Optional reading. It exists so the demo runs with no API key: free, offline, and the
// same answer every time (which is what makes scripts/demo.mjs a reliable test).
// With an ANTHROPIC_API_KEY secret set, agent.ts uses Claude instead, and this file
// isn't used.
//
// How it works
//   The AI SDK talks to every model through one interface. MockLanguageModelV4 (from
//   the AI SDK's test helpers) implements that interface with functions we supply, so
//   Think can't tell it from a real model. For each step, decide() reads the last
//   message and returns either a tool call or some text, the same choices Claude makes
//   with this agent's system prompt.
// =====================================================================================
import { MockLanguageModelV4 } from "ai/test";

type Part = Record<string, unknown>;

// The prompt arrives as AI SDK messages; content is either a string or a list of parts.
// We only need the text of the last message and who sent it.
function lastMessage(prompt: Array<{ role: string; content: unknown }>) {
  const last = prompt[prompt.length - 1];
  const text = Array.isArray(last?.content)
    ? (last.content as Part[]).map((p) => (p.type === "text" ? String(p.text) : "")).join(" ")
    : String(last?.content ?? "");
  return { role: last?.role, text };
}

// A model's reply is a stream of "parts". A tool call is a single part whose input is
// a JSON string, exactly as a real provider would send it.
function toolCall(toolName: string, input: unknown): Part[] {
  return [{ type: "tool-call", toolCallId: `call_${crypto.randomUUID()}`, toolName, input: JSON.stringify(input) }];
}

// Plain text comes as start, delta(s), end.
function text(t: string): Part[] {
  return [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: t },
    { type: "text-end", id: "t" }
  ];
}

// Decides one step. Order matters: the most specific checks come first.
function decide(prompt: Array<{ role: string; content: unknown }>): { parts: Part[]; reason: string } {
  const { role, text: msg } = lastMessage(prompt);
  // After a tool ran, the last message is the tool's result: the job is done.
  if (role === "tool") return { parts: text("Done."), reason: "stop" };
  // Lesson learned: after an approval, Think continues the conversation with an
  // automatic "Continue your previous response..." message. Without this check the
  // script would treat it as a new request and send a stray reply.
  if (/^continue your previous response/i.test(msg.trim())) return { parts: text("Done."), reason: "stop" };
  const lower = msg.toLowerCase();
  const order = /order\s+#?(\w+)/i.exec(msg)?.[1] ?? "unknown";
  // "timer fired" must be checked before "remind": the timer's text quotes the
  // original reminder, which would otherwise set another alarm forever.
  if (lower.includes("timer fired"))
    return { parts: toolCall("send_message", { to: "user", body: `Following up: ${msg.split("Follow up on:")[1]?.trim()}` }), reason: "tool-calls" };
  if (lower.includes("refund"))
    return { parts: toolCall("issue_refund", { orderId: order, amountUsd: 40, reason: msg }), reason: "tool-calls" };
  // "Remind me ... in 15 seconds" sets a 15-second alarm; with no number, 5 seconds.
  if (lower.includes("remind"))
    return { parts: toolCall("schedule_follow_up", { seconds: Number(/(\d+)\s*sec/i.exec(msg)?.[1] ?? 5), note: msg }), reason: "tool-calls" };
  // The release Workflow asks for notes with generateText(); answer with text.
  if (lower.includes("release notes"))
    return { parts: text("Release notes: faster inbox, safer approvals."), reason: "stop" };
  // Anything else gets a short acknowledgement, through the outbox like every reply.
  return {
    parts: toolCall("send_message", { to: "user", body: `Got it: ${msg.slice(0, 80)}` }),
    reason: "tool-calls"
  };
}

// A real model takes a moment. Without a pause the run finishes before the page can
// show the helper "working", so the script waits 1.5 s per step.
const THINK_MS = 1500;

export function mockModel() {
  // Made-up token counts, so analytics events have the same shape as real ones.
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 }
  };
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "scripted-claude",
    // Think streams replies, so doStream is the path normally used.
    doStream: async ({ prompt }) => {
      const { parts, reason } = decide(prompt as never);
      await new Promise((r) => setTimeout(r, THINK_MS));
      const all = [
        { type: "stream-start", warnings: [] },
        ...parts,
        { type: "finish", usage, finishReason: { unified: reason, raw: reason } }
      ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of all) c.enqueue(p);
            c.close();
          }
        })
      } as never;
    },
    // generateText() (used by the Workflow) takes the non-streaming path.
    doGenerate: async ({ prompt }) => {
      const { parts, reason } = decide(prompt as never);
      const content = parts
        .filter((p) => p.type === "tool-call" || p.type === "text-delta")
        .map((p) => (p.type === "text-delta" ? { type: "text", text: p.delta } : p));
      return { content, usage, finishReason: { unified: reason, raw: reason }, warnings: [] } as never;
    }
  });
}
