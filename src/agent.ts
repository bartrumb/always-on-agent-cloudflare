// =====================================================================================
// agent.ts: the always-on agent itself.
//
// READ THIS FILE SECOND (after index.ts). It is the heart of the demo.
//
// What it is
//   `Assistant` is one Cloudflare Think agent. Think is an agent harness from the
//   Cloudflare Agents SDK: it runs the model, calls tools, keeps the conversation, and
//   survives restarts. Every Think agent is a Durable Object: a small, single-threaded
//   server with its own SQLite database. index.ts gives each visitor their own
//   instance (one per user), so one person's agent never sees another's data.
//
// How it maps to Anthropic's "Building always-on agents" (the five pieces)
//   1. Event inbox   -> ingest(): Think's submitMessages() with an idempotency key.
//                        Durable, first-in first-out, one run at a time.
//   2. Timers        -> schedule_follow_up + followUp(): an agent schedule on the
//                        Durable Object alarm. A ringing timer is just another event.
//   3. Memory        -> Think's Sessions (the transcript, in SQLite) plus a `memory`
//                        context block the model can rewrite (configureContext()).
//   4. Permissions   -> issue_refund: a "durable-pause" action. The run ENDS while it
//                        waits; decide() resumes it hours or days later.
//   5. Outbox        -> enqueueOutbox() + dispatchOutbox(): Think doesn't ship one,
//                        so this file adds it. The only way a message leaves.
//
// Everything below "Status for the demo" exists for the demo page, not the pattern.
// =====================================================================================
import { Think, action } from "@cloudflare/think";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { z } from "zod";
import type { TurnContext, StepContext } from "@cloudflare/think";
import { mockModel } from "./mock-model";
import { capture, captureError, generationEvent } from "./telemetry";

// The system prompt is written for an agent that is woken by events, not chatted with.
// The key rule is the first one: the model may only reach the user through the outbox
// (send_message), so every outgoing message is recorded, deduplicated and retried.
const SYSTEM = `You are an always-on operations assistant. You are woken by events
(messages, webhooks, timers), not by a person sitting in a chat window.
- Never answer in plain text alone: reach the user only through send_message.
- Refunds need a human: call issue_refund and stop; a person approves it later.
- When asked to check back later, call schedule_follow_up.
- Save standing instructions from the user in your memory block.`;

// One incoming event, as the Worker hands it over.
//   source + id : together they identify the event. The same pair twice = a duplicate.
//   causedBy    : the run (Think request id) that led to this event, for example the
//                 run that set a timer. The demo page uses it to draw "letter 3 came
//                 from the alarm set by letter 2". Only the server sets it, never a
//                 public caller (index.ts builds the event itself).
export type InboundEvent = { source: string; id: string; text: string; causedBy?: string };

export class Assistant extends Think<Env> {
  // ---- The model ------------------------------------------------------------------
  // Think asks for the model once per turn. With an ANTHROPIC_API_KEY secret set, it's
  // Claude Haiku 5.5 through the AI SDK's Anthropic provider (Think is built on the
  // Vercel AI SDK). Haiku is the cheapest current Claude, which keeps a public demo
  // cheap; swap the id for a bigger model in real use.
  // Without a key, a scripted stand-in (mock-model.ts) makes the same decisions for
  // free, so the demo and the end-to-end script run with no account at all.
  getModel() {
    if (this.env.ANTHROPIC_API_KEY && this.env.MODEL_MODE !== "mock") {
      return createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })("claude-haiku-5-5");
    }
    return mockModel();
  }

  // ---- Observability: PostHog LLM analytics + errors --------------------------------
  // Cloudflare traces already cover every turn, tool call and alarm with no code (see
  // `observability` in wrangler.jsonc). These hooks add PostHog events on top:
  // one $ai_generation per model call (tokens, latency, tools) and $exception on errors.
  // `turn` holds per-run details between Think's hooks: beforeTurn fills it in,
  // onStepEnd reads it after each model call.
  private turn = { traceId: "", stepStart: 0, input: undefined as unknown };

  // Analytics must never slow down or break a run, so captures are fire-and-forget.
  // ctx.waitUntil() keeps the Durable Object alive until the request finishes, even if
  // the run itself is already done.
  private track(p: Promise<void>) {
    this.ctx.waitUntil(p);
  }

  // Think calls this after every model call ("step"). A run can have several steps:
  // the model calls a tool, reads the result, then answers.
  onStepEnd(step: StepContext) {
    const now = Date.now();
    this.track(capture(this.env, "$ai_generation", this.name, generationEvent(step, {
      traceId: this.turn.traceId,
      sessionId: this.name, // this.name = the agent's id = the visitor's session id
      latencySeconds: (now - this.turn.stepStart) / 1000,
      input: this.turn.input
    })));
    this.turn.stepStart = now;
  }

  // Think calls this when a turn fails. Report it, then let Think handle it as usual.
  onChatError(error: unknown, ctx?: Parameters<Think<Env>["onChatError"]>[1]) {
    this.track(captureError(this.env, this.name, error, { where: "agent-turn", stage: ctx?.stage, $ai_trace_id: this.turn.traceId }));
    return super.onChatError(error, ctx);
  }

  // Think calls this before every run. Two jobs here:
  //  1. Remember the run's id (requestId) and input for the analytics above.
  //  2. Return per-run limits. These are the cost guards for a public demo:
  //     low effort, at most 1,024 output tokens, at most 4 model/tool rounds.
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

  // ---- Memory (piece 3) ---------------------------------------------------------------
  // Think already keeps the whole conversation in this Durable Object's SQLite, so the
  // agent remembers past letters after it sleeps, restarts or is redeployed.
  // A context block adds a small, named note ("memory") that Think puts in the prompt
  // every run and lets the model rewrite: the place for standing rules such as
  // "keep replies short".
  configureContext() {
    return [{ label: "memory", description: "Standing user instructions and facts.", maxTokens: 2000 }];
  }

  // ---- Tools ---------------------------------------------------------------------------
  // Think "actions" are tools with extra rules: an idempotency key (a finished action
  // isn't run twice when a run is retried), optional approval, and a kind.
  // Inside execute(), ctx.requestId is the id of the run that called the tool. It's
  // stamped on everything the action creates, so the page can trace each outbox
  // message or alarm back to the letter that caused it.
  getActions() {
    return {
      // Outbox (piece 5): the model never talks to the outside world directly. It asks
      // for a message; the message is written to the outbox table and delivered later.
      // The tool call id is a stable key, so a retried run can't queue it twice.
      send_message: action({
        description: "Send a message to the user. Queued in the outbox and delivered once.",
        inputSchema: z.object({ to: z.string(), body: z.string() }),
        idempotencyKey: ({ ctx }) => ctx.toolCallId,
        execute: async ({ to, body }, ctx) => {
          this.enqueueOutbox(ctx.toolCallId, to, body, ctx.requestId);
          return { queued: true };
        }
      }),

      // Permissions (piece 4): `kind: "durable-pause"` with `approval: true` means:
      //   - when the model calls this tool, execute() does NOT run yet;
      //   - Think saves the request (pendingApprovals()) and the run ENDS. Nothing waits
      //     in memory, so the agent can sleep for days and survive deploys;
      //   - a person's answer arrives later as a new request: decide() below calls
      //     approveExecution(), which runs execute() once and continues the conversation.
      // The idempotency key is per order, so the same order can't be refunded twice.
      // Note: ctx.requestId here is still the ORIGINAL run's id even though execute()
      // runs later, which is how the refund message links back to the letter.
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

      // Timers (piece 2): this.schedule() comes from the Agents SDK. It stores the
      // schedule in SQLite and sets the Durable Object's alarm, so it survives restarts.
      // When it fires, Think calls this.followUp(payload). We pass along the current
      // run's id (`from`) so the new letter can say which letter set the alarm.
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

  // ---- Event inbox (piece 1) -------------------------------------------------------------
  // Called by the Worker for every incoming event. It must be fast: it only RECORDS the
  // event and returns, and Think runs it later, on this Durable Object's alarm.
  //
  // submitMessages() gives the article's inbox for free:
  //   - durable: the submission is in SQLite before we return, so a crash loses nothing;
  //   - first in, first out, one run at a time: two events never trip over each other;
  //   - idempotent: the same idempotencyKey returns the EXISTING submission with
  //     accepted: false. Webhook senders retry, so this is what makes "the same email
  //     twice only counts once" true.
  // The metadata (source, original text, causedBy) is for the demo page to display.
  async ingest(event: InboundEvent) {
    const r = await this.submitMessages(
      [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: `[${event.source}] ${event.text}` }] }],
      { idempotencyKey: `${event.source}:${event.id}`, metadata: { source: event.source, text: event.text.slice(0, 300), causedBy: event.causedBy } }
    );
    this.track(capture(this.env, "event_received", this.name, { source: event.source, duplicate: !r.accepted }));
    return { submissionId: r.submissionId, accepted: r.accepted, status: r.status };
  }

  // The timer callback named in schedule_follow_up. It doesn't think; it just drops a
  // new event in the inbox. That's the article's point: a timer is one more event, so
  // it gets the same ordering, deduplication (keyed by the schedule id) and memory.
  async followUp(payload: { note: string; from?: string }, schedule?: { id: string }) {
    await this.ingest({ source: "timer", id: schedule?.id ?? crypto.randomUUID(), text: `Timer fired. Follow up on: ${payload.note}`, causedBy: payload.from });
  }

  // ---- Human approval (piece 4, the answer) -----------------------------------------------
  // The person's yes or no arrives as a new request, possibly days after the run ended.
  //   yes -> approveExecution(): Think runs the saved action's execute() exactly once
  //          and continues the conversation, with no browser connected.
  //   no  -> rejectExecution(): execute() never runs. A "no" is news too, so we also
  //          tell the user through the outbox, tied to the run that asked (d.requestId).
  // pendingApprovals(id) is read BEFORE rejecting, because rejecting removes the entry.
  async decide(executionId: string, approve: boolean, reason?: string) {
    this.track(capture(this.env, "approval_decided", this.name, { approve }));
    if (approve) return this.approveExecution(executionId);
    const [pending] = await this.pendingApprovals(executionId);
    const result = await this.rejectExecution(executionId, reason ?? "Rejected");
    if (pending) {
      const d = pending.descriptor;
      const input = d.input as { orderId?: string } | undefined;
      const body = d.action === "issue_refund" && input?.orderId
        ? `Your refund for order ${input.orderId} was not approved, so I haven't issued it.`
        : `"${d.summary}" was not approved, so I didn't do it.`;
      this.enqueueOutbox(`declined:${executionId}`, "user", body, d.requestId);
    }
    return result;
  }

  // ---- Outbox (piece 5) ---------------------------------------------------------------------
  // Think doesn't include an outbox, so this is a plain table in the agent's own SQLite.
  // Why an outbox at all? A run can be retried (a crash, a deploy, a model error). If
  // the model sent emails directly, a retry could send them twice. Here, a retry only
  // tries to INSERT the same key again, which is ignored. Delivery happens separately,
  // and a delivery that fails is retried without running the model again.
  //
  // Table columns: key (dedup key), recipient, body, status (pending/sent/failed),
  // attempts, created_at, sent_at, request_id (the run that queued it, for tracing).
  private outboxReady = false;
  private ensureOutbox() {
    if (this.outboxReady) return;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS app_outbox (
      key TEXT PRIMARY KEY, recipient TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, sent_at INTEGER, request_id TEXT)`);
    // request_id was added after the first deploy. Agents created before that already
    // have the table without it; this adds the column once and is a no-op afterwards.
    try { this.ctx.storage.sql.exec("ALTER TABLE app_outbox ADD COLUMN request_id TEXT"); } catch { /* already there */ }
    this.outboxReady = true;
  }

  // INSERT OR IGNORE + the primary key = "same key twice is ignored", so a message
  // goes out once no matter how often a run is retried.
  private enqueueOutbox(key: string, recipient: string, body: string, requestId?: string) {
    this.ensureOutbox();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO app_outbox (key, recipient, body, created_at, request_id) VALUES (?, ?, ?, ?, ?)",
      key, recipient, body, Date.now(), requestId ?? null
    );
    // Deliver outside the model run: schedule(0, ...) means "as soon as possible, on
    // the alarm". The run finishes quickly; delivery has its own retries.
    void this.schedule(0, "dispatchOutbox", {});
  }

  // The dispatcher: sends every pending row, then marks it sent. On failure it backs
  // off (2, 4, 8, 16 seconds) and gives up after 5 attempts, marking the row "failed".
  // With OUTBOX_WEBHOOK_URL set it POSTs to that URL with an Idempotency-Key header, so
  // the receiver can drop repeats too; otherwise it just logs (visible in Workers Logs).
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

  // ---- Status for the demo -------------------------------------------------------------------
  // Everything the page draws, in one call (GET /status/:user). Not part of the pattern.
  async snapshot() {
    this.ensureOutbox();
    const subs = await this.listSubmissions();
    // Lesson learned: Think's activeTurn is only set for live chat turns (a browser on a
    // WebSocket). Runs started from the inbox show up as a submission with status
    // "running" instead, so "is the agent busy?" checks both.
    const running = subs.find((s) => s.status === "running");
    return {
      model: this.env.ANTHROPIC_API_KEY && this.env.MODEL_MODE !== "mock" ? "claude-haiku-5-5" : "scripted (no API key)",
      // The inbox: every event, its status, the run that handled it (requestId) and,
      // from metadata, the original text and what caused it.
      submissions: subs.map((s) => ({
        id: s.submissionId, key: s.idempotencyKey, status: s.status, requestId: s.requestId, createdAt: s.createdAt,
        source: s.metadata?.source, text: s.metadata?.text, causedBy: s.metadata?.causedBy
      })),
      // Paused actions waiting for a person. executionId is what decide() needs.
      pendingApprovals: (await this.pendingApprovals()).map((p) => ({
        executionId: p.executionId, action: p.descriptor.action, input: p.descriptor.input, risk: p.descriptor.risk,
        requestId: p.descriptor.requestId
      })),
      outbox: this.ctx.storage.sql.exec("SELECT key, recipient, body, status, request_id AS requestId, created_at AS createdAt, sent_at AS sentAt FROM app_outbox ORDER BY created_at").toArray(),
      // Is a run happening right now, or is the agent asleep (costing nothing)?
      busy: Boolean(this.activeTurn || running),
      workingOn: this.activeTurn?.requestId ?? running?.requestId ?? null,
      // Memory: the last few messages of the conversation Think keeps for this agent.
      // UIMessage parts are either text or "tool-<name>" entries.
      notebook: this.messages.slice(-8).map((m) => ({
        role: m.role,
        text: m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ").slice(0, 300),
        tools: m.parts
          .filter((p) => p.type.startsWith("tool-"))
          .map((p) => ({ name: p.type.slice(5), state: (p as { state?: string }).state }))
      })),
      // Timers waiting to go off. `time` is in Unix SECONDS (the page converts it).
      alarms: this.getSchedules<{ note: string; from?: string }>()
        .filter((s) => s.callback === "followUp")
        .map((s) => ({ id: s.id, note: s.payload?.note, from: s.payload?.from, at: "time" in s ? s.time : null }))
    };
  }

  // ---- Deploy-safety demo (see release-workflow.ts) ------------------------------------------
  // runWorkflow() (Agents SDK) starts a Cloudflare Workflow that knows which agent
  // started it, so the workflow can call back into this agent (this.agent there).
  async startRelease() {
    this.track(capture(this.env, "release_started", this.name));
    return this.runWorkflow("RELEASE_WORKFLOW", { requestedAt: Date.now() });
  }

  // Sends the approval event that the workflow's waitForApproval() is sleeping on.
  async approveRelease(workflowId: string) {
    await this.approveWorkflow(workflowId, { reason: "Looks good" });
  }

  // Called from INSIDE each workflow step. Because finished steps are never re-run on
  // resume, this log shows exactly which steps really executed, and on which version.
  async recordStep(workflowId: string, step: string) {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS app_release_log (
      workflow_id TEXT, step TEXT, version TEXT, at INTEGER)`);
    this.ctx.storage.sql.exec(
      "INSERT INTO app_release_log VALUES (?, ?, ?, ?)", workflowId, step, this.env.RELEASE_VERSION, Date.now()
    );
  }

  // The one model call in the workflow. resolveModel() returns the same model as
  // getModel() (Claude or the scripted stand-in) for use outside a chat turn.
  async draftReleaseNotes(changes: string[]) {
    const { text } = await generateText({
      model: this.resolveModel(),
      prompt: `Write two-sentence release notes for: ${changes.join("; ")}`
    });
    return text;
  }

  // For GET /releases/:user/:id: the workflow's status plus the steps that really ran.
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
