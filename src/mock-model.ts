// A scripted stand-in for Claude so the demo runs offline, for free, and gives the
// same answer every time. Set MODEL_MODE=anthropic to use the real model instead.
import { MockLanguageModelV4 } from "ai/test";

type Part = Record<string, unknown>;

function lastMessage(prompt: Array<{ role: string; content: unknown }>) {
  const last = prompt[prompt.length - 1];
  const text = Array.isArray(last?.content)
    ? (last.content as Part[]).map((p) => (p.type === "text" ? String(p.text) : "")).join(" ")
    : String(last?.content ?? "");
  return { role: last?.role, text };
}

function toolCall(toolName: string, input: unknown): Part[] {
  return [{ type: "tool-call", toolCallId: `call_${crypto.randomUUID()}`, toolName, input: JSON.stringify(input) }];
}

function text(t: string): Part[] {
  return [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: t },
    { type: "text-end", id: "t" }
  ];
}

// Decide one step: the same choices Claude makes in the real run.
function decide(prompt: Array<{ role: string; content: unknown }>): { parts: Part[]; reason: string } {
  const { role, text: msg } = lastMessage(prompt);
  if (role === "tool") return { parts: text("Done."), reason: "stop" };
  const lower = msg.toLowerCase();
  const order = /order\s+#?(\w+)/i.exec(msg)?.[1] ?? "unknown";
  if (lower.includes("timer fired"))
    return { parts: toolCall("send_message", { to: "user", body: `Following up: ${msg.split("Follow up on:")[1]?.trim()}` }), reason: "tool-calls" };
  if (lower.includes("refund"))
    return { parts: toolCall("issue_refund", { orderId: order, amountUsd: 40, reason: msg }), reason: "tool-calls" };
  if (lower.includes("remind"))
    return { parts: toolCall("schedule_follow_up", { seconds: 5, note: msg }), reason: "tool-calls" };
  if (lower.includes("release notes"))
    return { parts: text("Release notes: faster inbox, safer approvals."), reason: "stop" };
  return {
    parts: toolCall("send_message", { to: "user", body: `Got it: ${msg.slice(0, 80)}` }),
    reason: "tool-calls"
  };
}

export function mockModel() {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 }
  };
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "scripted-claude",
    doStream: async ({ prompt }) => {
      const { parts, reason } = decide(prompt as never);
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
    doGenerate: async ({ prompt }) => {
      const { parts, reason } = decide(prompt as never);
      const content = parts
        .filter((p) => p.type === "tool-call" || p.type === "text-delta")
        .map((p) => (p.type === "text-delta" ? { type: "text", text: p.delta } : p));
      return { content, usage, finishReason: { unified: reason, raw: reason }, warnings: [] } as never;
    }
  });
}
