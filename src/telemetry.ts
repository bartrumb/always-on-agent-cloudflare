// PostHog capture over plain fetch: no SDK, nothing that needs Node, safe on Workers
// and inside Durable Objects. A no-op until POSTHOG_KEY is set.
//
// The browser page uses its session id as the PostHog distinct id, and the server
// uses the same id, so a person's pageviews, replay, LLM generations and errors join up.

export type Props = Record<string, unknown>;

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
    .then(() => undefined)
    .catch((err) => console.error("[posthog] capture failed", err)); // never break the app
}

// PostHog error tracking event.
export function captureError(env: Env, distinctId: string, err: unknown, props: Props = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`[error] ${e.message}`, props); // also lands in Workers Logs
  return capture(env, "$exception", distinctId, {
    $exception_list: [{ type: e.name, value: e.message, stacktrace: { type: "raw", frames: [] }, mechanism: { handled: true } }],
    $exception_message: e.message,
    stack: e.stack?.slice(0, 2000),
    ...props
  });
}

const clip = (s: unknown, n = 2000) => (typeof s === "string" ? s.slice(0, n) : s);

// One model call -> one $ai_generation event (PostHog LLM analytics).
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
