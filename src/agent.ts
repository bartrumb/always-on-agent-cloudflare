// The always-on agent: one Think instance (a SQLite-backed Durable Object) per user.
//
// Think already gives us the article's inbox (durable submissions with idempotency
// keys, run one at a time), memory (Sessions + context blocks), timers (schedules on
// the DO alarm) and deferred approval (durable-pause actions). This file adds the one
// piece Think does not ship, the outbox, plus the HTTP-facing RPC methods.
import { Think, action } from "@cloudflare/think";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { z } from "zod";
import type { TurnContext, StepContext } from "@cloudflare/think";
import { mockModel } from "./mock-model";
import { capture, captureError, generationEvent } from "./telemetry";

const SYSTEM = `You are an always-on operations assistant. You are woken by events
(messages, webhooks, timers), not by a person sitting in a chat window.
- Never answer in plain text alone: reach the user only through send_message.
- Refunds need a human: call issue_refund and stop; a person approves it later.
- When asked to check back later, call schedule_follow_up.
- Save standing instructions from the user in your memory block.`;

// causedBy: the run (request id) that led to this event, e.g. the run that set a timer.
export type InboundEvent = { source: string; id: string; text: string; causedBy?: string };

export class Assistant extends Think<Env> {
  // Claude Haiku 5.5 when a key is set, else the free scripted model.
  // Haiku is the cheapest current Claude ($0.10 / $0.50 per million tokens), which
  // keeps a public demo cheap; swap the id for a bigger model in real use.
  getModel() {
    if (this.env.ANTHROPIC_API_KEY && this.env.MODEL_MODE !== "mock") {
      return createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })("claude-haiku-5-5");
    }
    return mockModel();
  }

  // ---- Observability: PostHog LLM analytics + errors ------------------------
  // (Cloudflare traces cover the same turns automatically; see wrangler.jsonc.)
  private turn = { traceId: "", stepStart: 0, input: undefined as unknown };

  // Fire-and-forget, but kept alive past the response.
  private track(p: Promise<void>) {
    this.ctx.waitUntil(p);
  }

  onStepEnd(step: StepContext) {
    const now = Date.now();
    this.track(capture(this.env, "$ai_generation", this.name, generationEvent(step, {
      traceId: this.turn.traceId,
      sessionId: this.name,
      latencySeconds: (now - this.turn.stepStart) / 1000,
      input: this.turn.input
    })));
    this.turn.stepStart = now;
  }

  onChatError(error: unknown, ctx?: Parameters<Think<Env>["onChatError"]>[1]) {
    this.track(captureError(this.env, this.name, error, { where: "agent-turn", stage: ctx?.stage, $ai_trace_id: this.turn.traceId }));
    return super.onChatError(error, ctx);
  }

  // Cost guards on every run: low effort, short replies, few tool rounds.
  beforeTurn(ctx: TurnContext) {
    this.turn = {
      traceId: ctx.requestId ?? crypto.randomUUID(),
      stepStart: Date.now(),
      input: ctx.messages.slice(-3).map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content.slice(0, 1000) : m.content }))
    };
    return { maxSteps: 4, maxOutputTokens: 1024, providerOptions: { anthropic: { effort: "low" } } };
  }

  getSystemPrompt() {
    return SYSTEM;
  }

  // Memory: a block the model can read and rewrite; it persists across runs.
  configureContext() {
    return [{ label: "memory", description: "Standing user instructions and facts.", maxTokens: 2000 }];
  }

  getActions() {
    return {
      // Outbox: the model never talks to the outside world directly.
      send_message: action({
        description: "Send a message to the user. Queued in the outbox and delivered once.",
        inputSchema: z.object({ to: z.string(), body: z.string() }),
        idempotencyKey: ({ ctx }) => ctx.toolCallId,
        execute: async ({ to, body }, ctx) => {
          this.enqueueOutbox(ctx.toolCallId, to, body, ctx.requestId);
          return { queued: true };
        }
      }),

      // Permissions: the run ends here; a human answer resumes it later.
      issue_refund: action({
        kind: "durable-pause",
        approval: true,
        approvalRisk: "high",
        approvalSummary: "Issue a customer refund",
        description: "Refund an order. Requires human approval.",
        inputSchema: z.object({ orderId: z.string(), amountUsd: z.number(), reason: z.string() }),
        idempotencyKey: ({ input }) => `refund:${input.orderId}`,
        execute: async ({ orderId, amountUsd }, ctx) => {
          this.enqueueOutbox(`refund:${orderId}`, "user", `Refund of $${amountUsd} issued for order ${orderId}.`, ctx.requestId);
          return { refunded: true, orderId, amountUsd };
        }
      }),

      // Timers: a durable schedule on the Durable Object alarm.
      schedule_follow_up: action({
        description: "Wake this agent again after a delay to follow up.",
        inputSchema: z.object({ seconds: z.number().int().min(1), note: z.string() }),
        execute: async ({ seconds, note }, ctx) => {
          const s = await this.schedule(seconds, "followUp", { note, from: ctx.requestId });
          return { scheduled: s.id, inSeconds: seconds };
        }
      })
    };
  }

  // ---- Event inbox ---------------------------------------------------------
  // Fast path: durably accept the event and return. Think runs submissions one at a
  // time, in order; the same source event id is accepted only once.
  async ingest(event: InboundEvent) {
    const r = await this.submitMessages(
      [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: `[${event.source}] ${event.text}` }] }],
      { idempotencyKey: `${event.source}:${event.id}`, metadata: { source: event.source, text: event.text.slice(0, 300), causedBy: event.causedBy } }
    );
    this.track(capture(this.env, "event_received", this.name, { source: event.source, duplicate: !r.accepted }));
    return { submissionId: r.submissionId, accepted: r.accepted, status: r.status };
  }

  // A timer firing is just another inbox event.
  async followUp(payload: { note: string; from?: string }, schedule?: { id: string }) {
    await this.ingest({ source: "timer", id: schedule?.id ?? crypto.randomUUID(), text: `Timer fired. Follow up on: ${payload.note}`, causedBy: payload.from });
  }

  // ---- Human approval -------------------------------------------------------
  async decide(executionId: string, approve: boolean, reason?: string) {
    this.track(capture(this.env, "approval_decided", this.name, { approve }));
    return approve ? this.approveExecution(executionId) : this.rejectExecution(executionId, reason ?? "Rejected");
  }

  // ---- Outbox ---------------------------------------------------------------
  private outboxReady = false;
  private ensureOutbox() {
    if (this.outboxReady) return;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS app_outbox (
      key TEXT PRIMARY KEY, recipient TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, sent_at INTEGER, request_id TEXT)`);
    try { this.ctx.storage.sql.exec("ALTER TABLE app_outbox ADD COLUMN request_id TEXT"); } catch { /* already there */ }
    this.outboxReady = true;
  }

  // Same key twice (a retried run) is ignored, so a message goes out once.
  private enqueueOutbox(key: string, recipient: string, body: string, requestId?: string) {
    this.ensureOutbox();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO app_outbox (key, recipient, body, created_at, request_id) VALUES (?, ?, ?, ?, ?)",
      key, recipient, body, Date.now(), requestId ?? null
    );
    // Deliver outside the model turn, on the alarm.
    void this.schedule(0, "dispatchOutbox", {});
  }

  async dispatchOutbox() {
    this.ensureOutbox();
    const rows = this.ctx.storage.sql
      .exec<{ key: string; recipient: string; body: string; attempts: number }>(
        "SELECT key, recipient, body, attempts FROM app_outbox WHERE status = 'pending' ORDER BY created_at"
      )
      .toArray();
    for (const row of rows) {
      try {
        if (this.env.OUTBOX_WEBHOOK_URL) {
          const res = await fetch(this.env.OUTBOX_WEBHOOK_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": row.key },
            body: JSON.stringify({ to: row.recipient, body: row.body })
          });
          if (!res.ok) throw new Error(`webhook ${res.status}`);
        } else {
          console.log(`[outbox] -> ${row.recipient}: ${row.body}`);
        }
        this.ctx.storage.sql.exec("UPDATE app_outbox SET status = 'sent', sent_at = ? WHERE key = ?", Date.now(), row.key);
      } catch (err) {
        const attempts = row.attempts + 1;
        this.ctx.storage.sql.exec(
          "UPDATE app_outbox SET attempts = ?, status = ? WHERE key = ?",
          attempts, attempts >= 5 ? "failed" : "pending", row.key
        );
        if (attempts < 5) await this.schedule(2 ** attempts, "dispatchOutbox", {});
        this.track(captureError(this.env, this.name, err, { where: "outbox", key: row.key, attempts }));
      }
    }
  }

  // ---- Status for the demo ----------------------------------------------------
  async snapshot() {
    this.ensureOutbox();
    return {
      model: this.env.ANTHROPIC_API_KEY && this.env.MODEL_MODE !== "mock" ? "claude-haiku-5-5" : "scripted (no API key)",
      submissions: (await this.listSubmissions()).map((s) => ({
        id: s.submissionId, key: s.idempotencyKey, status: s.status, requestId: s.requestId, createdAt: s.createdAt,
        source: s.metadata?.source, text: s.metadata?.text, causedBy: s.metadata?.causedBy
      })),
      pendingApprovals: (await this.pendingApprovals()).map((p) => ({
        executionId: p.executionId, action: p.descriptor.action, input: p.descriptor.input, risk: p.descriptor.risk,
        requestId: p.descriptor.requestId
      })),
      outbox: this.ctx.storage.sql.exec("SELECT key, recipient, body, status, request_id AS requestId FROM app_outbox ORDER BY created_at").toArray(),
      // Is a run happening right now, or is the agent asleep (costing nothing)?
      busy: Boolean(this.activeTurn),
      workingOn: this.activeTurn?.requestId ?? null,
      // Memory: the last few things in the conversation it keeps.
      notebook: this.messages.slice(-8).map((m) => ({
        role: m.role,
        text: m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ").slice(0, 300),
        tools: m.parts
          .filter((p) => p.type.startsWith("tool-"))
          .map((p) => ({ name: p.type.slice(5), state: (p as { state?: string }).state }))
      })),
      // Timers waiting to go off.
      alarms: this.getSchedules<{ note: string; from?: string }>()
        .filter((s) => s.callback === "followUp")
        .map((s) => ({ id: s.id, note: s.payload?.note, from: s.payload?.from, at: "time" in s ? s.time : null }))
    };
  }

  // ---- Deploy-safety demo (see release-workflow.ts) ---------------------------
  async startRelease() {
    this.track(capture(this.env, "release_started", this.name));
    return this.runWorkflow("RELEASE_WORKFLOW", { requestedAt: Date.now() });
  }

  async approveRelease(workflowId: string) {
    await this.approveWorkflow(workflowId, { reason: "Looks good" });
  }

  // Called from inside each workflow step, so this log shows which steps really ran.
  async recordStep(workflowId: string, step: string) {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS app_release_log (
      workflow_id TEXT, step TEXT, version TEXT, at INTEGER)`);
    this.ctx.storage.sql.exec(
      "INSERT INTO app_release_log VALUES (?, ?, ?, ?)", workflowId, step, this.env.RELEASE_VERSION, Date.now()
    );
  }

  async draftReleaseNotes(changes: string[]) {
    const { text } = await generateText({
      model: this.resolveModel(),
      prompt: `Write two-sentence release notes for: ${changes.join("; ")}`
    });
    return text;
  }

  async releaseReport(workflowId: string) {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS app_release_log (
      workflow_id TEXT, step TEXT, version TEXT, at INTEGER)`);
    return {
      status: await this.getWorkflowStatus("RELEASE_WORKFLOW", workflowId),
      stepsThatRan: this.ctx.storage.sql
        .exec("SELECT step, version FROM app_release_log WHERE workflow_id = ? ORDER BY at", workflowId)
        .toArray()
    };
  }
}
