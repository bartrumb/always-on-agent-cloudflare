// =====================================================================================
// telemetry.ts: PostHog events from the server, with plain fetch.
//
// Optional reading. The pattern works without it; it's how you watch an agent that
// works while nobody is looking.
//
// Two views of the same activity
//   Cloudflare traces (wrangler.jsonc, `observability`): where each request went, and
//     how long each stop took. On automatically; Think adds spans for runs and tools.
//   PostHog (this file + the page): what the agent did and why. One $ai_generation
//     event per model call (model, tokens, latency, tool calls), $exception for errors,
//     and a few named events (event_received, approval_decided, release_started).
//
// Why fetch and not an SDK: PostHog's Node SDK and OpenTelemetry's Node SDK expect
// Node.js; plain fetch to the capture API works anywhere, including inside Workers
// and Durable Objects. Everything here is a no-op until POSTHOG_KEY is set.
//
// One id everywhere: the page uses its session id as PostHog's distinct id, and the
// agent's name is that same id, so a visitor's pageviews, replay, model calls and
// errors all line up in PostHog.
// =====================================================================================

export type Props = Record<string, unknown>;

// Sends one event to PostHog's capture endpoint. Never throws: analytics failing must
// not break the agent, so errors are logged and swallowed.
// Lesson learned: fetch() only rejects when the network fails. A 400 or 401 from
// PostHog (a bad key, a malformed event) is a normal response, so without checking
// res.ok it vanished silently. Now it's a line in Workers Logs, next to its trace.
// Note: PostHog may still answer 200 for a key it drops later, so the PostHog
// Activity view remains the final check that events arrive.
export function capture(env: Env, event: string, distinctId: string, properties: Props = {}): Promise<void> {
  if (!env.POSTHOG_KEY) return Promise.resolve();
  return fetch(`${env.POSTHOG_HOST}/i/v0/e/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: env.POSTHOG_KEY,
      event,
      distinct_id: distinctId,
      properties: { ...properties, $lib: "always-on-agent-worker" },
      timestamp: new Date().toISOString()
    })
  })
    .then(async (res) => {
      if (!res.ok) console.error(`[posthog] capture rejected: ${event} -> HTTP ${res.status}`, (await res.text()).slice(0, 200));
    })
    .catch((err) => console.error("[posthog] capture failed", err));
}

// PostHog error tracking reads the $exception event with an $exception_list. The
// console.error also puts the error in Workers Logs, next to its trace.
export function captureError(env: Env, distinctId: string, err: unknown, props: Props = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`[error] ${e.message}`, props);
  return capture(env, "$exception", distinctId, {
    $exception_list: [{ type: e.name, value: e.message, stacktrace: { type: "raw", frames: [] }, mechanism: { handled: true } }],
    $exception_message: e.message,
    stack: e.stack?.slice(0, 2000),
    ...props
  });
}

// Long strings are cut so one event stays small.
const clip = (s: unknown, n = 2000) => (typeof s === "string" ? s.slice(0, n) : s);

// Turns one AI SDK "step" (one model call, as Think reports it to onStepEnd) into the
// properties PostHog LLM analytics expects. The $ai_* names come from PostHog's
// manual-capture docs:
//   $ai_trace_id   groups the calls of one run (Think's requestId)
//   $ai_session_id groups runs into a conversation (the visitor / agent id)
//   tokens, latency, stop reason and tool calls for cost and debugging
export function generationEvent(step: {
  model: { provider: string; modelId: string };
  usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } };
  text: string;
  toolCalls: Array<{ toolName: string; input: unknown }>;
  finishReason: string;
  stepNumber: number;
}, ids: { traceId: string; sessionId: string; latencySeconds: number; input: unknown }): Props {
  return {
    $ai_trace_id: ids.traceId,
    $ai_session_id: ids.sessionId,
    $ai_span_name: `step-${step.stepNumber}`,
    $ai_model: step.model.modelId,
    // The AI SDK reports providers like "anthropic.messages"; PostHog wants "anthropic".
    $ai_provider: step.model.provider.split(".")[0],
    $ai_input: ids.input,
    $ai_input_tokens: step.usage.inputTokens ?? 0,
    $ai_output_tokens: step.usage.outputTokens ?? 0,
    $ai_cache_read_input_tokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
    $ai_cache_creation_input_tokens: step.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    $ai_output_choices: [{
      role: "assistant",
      content: clip(step.text),
      tool_calls: step.toolCalls.map((t) => ({ name: t.toolName, input: t.input }))
    }],
    $ai_latency: ids.latencySeconds,
    $ai_stream: true,
    $ai_stop_reason: step.finishReason,
    $ai_is_error: step.finishReason === "error"
  };
}
