# Always-on agent on Cloudflare

A small, runnable reference for Anthropic's article
[Building always-on agents](https://claude.com/resources/articles/building-always-on-agents),
built on Cloudflare Workers, Durable Objects, Workflows and the
[Think](https://developers.cloudflare.com/agents/harnesses/think/) agent harness.

The article describes the five parts an agent needs once it stops living in a chat
window and starts reacting to events. It is written in prose and diagrams, with no
code and no named platform. This repo shows each part as working code, using the
pieces Cloudflare already ships, and adds only what is missing.

```bash
npm install
npm run dev         # open http://localhost:8787 for the one-page UI
npm run demo        # or: scripted end-to-end run with checks; no API key needed
```

## The five parts, mapped

| Article | Cloudflare | Where |
|---|---|---|
| **Event inbox**: accept events fast, run them one at a time, never twice | Think `submitMessages()` with an `idempotencyKey` (source + event id). Durable, first-in first-out, one turn at a time per user. | `Assistant.ingest()` |
| **Timers**: wake up later without anyone asking | Agent `schedule()`, backed by the Durable Object alarm. A timer firing is just another inbox event. | `schedule_follow_up`, `followUp()` |
| **Memory and task progress** | Think Sessions (the transcript, in the Durable Object's SQLite) plus a `memory` context block the model can rewrite | `configureContext()` |
| **Permissions**: risky actions wait for a human | A `kind: "durable-pause"` action. The run *ends*; nothing waits in memory. `approveExecution()` later runs the action and continues the conversation. | `issue_refund`, `Assistant.decide()` |
| **Outbox**: side effects leave through one door, once | *Not in Think, so it lives here:* an `app_outbox` table keyed by idempotency key, delivered on the alarm with retries (log or webhook) | `enqueueOutbox()`, `dispatchOutbox()` |

![Architecture: event sources reach a Worker, which hands events to one Durable Object per user. Inside it, the inbox feeds runs; runs use memory, pause risky actions for approval, set timers that fire back into the inbox, and send through the outbox. Runs can also start a long Workflow.](public/architecture.svg)

The diagram is plain SVG built by `node docs/build-diagram.mjs` from Cloudflare's product icons
(in `docs/icons`, from the Cloudflare docs, CC BY 4.0).

## Read the code

The code is commented to be read. Every file opens with what it does and which part of
the article it implements, and the comments explain why, not only what. Read it in
this order (about 600 lines for the core):

1. **[`src/index.ts`](src/index.ts)**: the Worker, the front door. Short, and it shows
   the shape of the whole system: accept fast, hand off to that user's agent, reply.
2. **[`src/agent.ts`](src/agent.ts)**: the agent itself. The header maps each of the
   article's five pieces to a method; each piece has its own section below.
3. **[`src/release-workflow.ts`](src/release-workflow.ts)**: deploy safety. Why
   Workflow step names are cache keys, and what goes wrong when you rename one.
4. **[`scripts/demo.mjs`](scripts/demo.mjs)**: the whole story as a test. Each numbered
   section exercises one piece over HTTP and asserts what should happen.
5. **[`wrangler.jsonc`](wrangler.jsonc)**: how it's wired: the Durable Object, the
   Workflow, static assets, the rate limit, and observability.

Optional: [`src/telemetry.ts`](src/telemetry.ts) (PostHog from a Worker with plain
`fetch`), [`src/mock-model.ts`](src/mock-model.ts) (a scripted model so everything runs
without an API key), [`public/index.html`](public/index.html) (the page: how a UI can
follow an agent that works in the background), and
[`docs/build-diagram.mjs`](docs/build-diagram.mjs).

### Lessons learned while building it

Each of these is also explained where it happens in the code.

- **A paused action keeps its original run id.** When an approved `durable-pause` action
  finally runs, `ctx.requestId` is still the id of the run that asked. That's how the
  refund message links back to the letter that requested it.
- **Think's `activeTurn` is only for live chat.** Runs started from the inbox show up as a
  submission with status `running` instead, so "is the agent busy?" checks both.
- **After an approval, Think continues the conversation** with an automatic "continue"
  message. A model, or a scripted stand-in, mustn't treat it as a new request.
- **A "no" is news too.** Rejecting an action runs nothing, so the agent sends a "not
  approved" message through the outbox, or the customer never hears back.
- **The outbox is what makes retries safe.** A retried run only tries to insert the same
  key again, which is ignored, so nothing is sent twice.
- **A paused Workflow can report `running`, not `waiting`.** Check which steps finished
  instead of trusting the status alone.
- **Don't trust the visitor's clock.** Compare server times with server time; the page
  corrects for the device's clock using each response's `Date` header.

## What the demo shows

`npm run demo` starts `wrangler dev`, sends HTTP requests to it, and checks the results:

1. **Inbox.** An email webhook asks for a refund. The Worker returns 202 at once. The
   same webhook delivered again comes back `accepted: false`, the same submission.
2. **Deferred approval.** The run calls `issue_refund`, which needs a human. The run
   ends. A pending approval is stored, and nothing has gone out yet.
3. **Resume.** A person approves (`POST /approvals/...`). That answer resumes the saved
   action. The refund message goes to the outbox and is delivered once.
4. **Timer.** "Remind me to check the shipment" schedules an alarm. When it fires, it
   comes back through the inbox like any other event and sends a follow-up.
5. **Deploy safety.** See below.

With no API key the model is a small scripted stand-in (`src/mock-model.ts`), so the
demo is free, offline and gives the same result every time. Add a key and the same code
runs on **Claude Haiku 5.5** (`claude-haiku-5-5`):

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .dev.vars      # local; git-ignored
npx wrangler secret put ANTHROPIC_API_KEY           # deployed
```

Haiku is the cheapest current Claude model ($0.10 / $0.50 per million input / output
tokens), which keeps a public demo cheap. For real work, change the model id in
`getModel()`. Think is built on the AI SDK, so Claude is reached through
`@ai-sdk/anthropic`.

## Public demo and cost guards

The Worker serves a one-page UI (`public/index.html`). Each browser gets its own agent
(one Durable Object), drawn as a helper's desk: inbox tray, outbox tray, a "needs your
signature" folder, a notebook and alarm clocks, plus a release Workflow you can approve.

Three guided tests send one letter each and tick off the expected steps live:

- **A risky job waits for a person:** the refund pauses for a signature, then goes out once.
- **The same email arrives twice:** the second copy is stamped Duplicate and only one reply goes out.
- **Check back later:** an alarm rings 15 seconds later and drops a new letter in the inbox.

Every letter gets a number, and everything it causes carries that number: the signature
form, the outbox reply, the alarm, and the follow-up letter. The agent stamps each item
with the run (`requestId`) that made it, and hovering any item lights up the rest of
its chain.

A round chat button in the corner holds the whole conversation in time order: your
letters, the helper's replies (from the outbox), signature requests you can answer in
place, and notes when an alarm is set or rings or a duplicate is ignored. Its badge
counts what the helper did while the chat was closed, which is the point of an
always-on agent: work keeps happening when nobody is looking. Each of your messages has
a "Send again" link that resends the same event id, so you can try the duplicate check.

Because anyone can use a public page, every run is kept small:

- **Rate limit:** 10 model-waking requests a minute per IP (Workers Rate Limiting
  binding `EVENT_LIMIT`). Beyond that you get a 429.
- **Input cap:** event text is cut to 500 characters, and session ids must be short and plain.
- **Per-run limits** in `beforeTurn()`: effort `low`, at most 1,024 output tokens, at most 4 tool rounds.
- **No key, no cost:** without the secret, the page runs on the scripted model.

Deploy with `npx wrangler deploy` (live demo: https://always-on-agent.shopdawg.workers.dev). Set a spend limit on the Anthropic key you use for the
demo as a final backstop.

## Deploy safety: add steps, don't rename them

Workflow step names are cache keys. When a paused instance resumes on new code, every
step whose name it has already finished returns its saved result and does not run again.

`ReleaseWorkflow` runs `collect-changes`, then `draft-notes` (a model call), then waits for
approval, then `publish`. The demo starts a run on v1, lets it pause at the approval,
restarts the dev server as a new version, approves, and prints every step that really ran:

```
v2-add:    collect-changes@v1, draft-notes@v1, notify-team@v2-add, publish@v2-add
           ✓ the new step ran; finished steps were not re-run

v2-rename: collect-changes@v1, draft-notes@v1, draft-release-notes@v2-rename, publish@v2-rename
           ✗ the renamed step got a new cache key, so it ran again (a second model call)
```

The version is set with `RELEASE_VERSION` so one file can show all three versions. In
real code, v2 would be a code change and a `wrangler deploy`.

## Watching it

Two views, linked by one id: the browser's session id is also the agent's name and the
PostHog distinct id.

**Cloudflare traces and logs**, in `wrangler.jsonc` (`observability.traces.enabled`,
everything sampled). With no extra code, Think emits an `invoke_agent Assistant` span per
run, `chat <model>` per model call and `execute_tool <name>` per tool. The Durable Object
storage, alarm, Workflow and outbound `fetch` spans sit around them. Deployed runs show
up in the dashboard's Agents view and in Workers Observability. Locally, `wrangler dev`
keeps the same traces in its Local Explorer.

**PostHog**, off until you set a project token (`src/telemetry.ts`, plain `fetch`, no SDK):

| What | Event | Source |
|---|---|---|
| Traffic and session replay | `$pageview`, `$pageleave`, replays | `posthog-js` on the page |
| Every model call | `$ai_generation`: model, tokens, latency, stop reason, tool calls, trace id per run, session id per browser | Think `onStepEnd` hook |
| Errors | `$exception` | page errors, Worker route errors, failed agent turns (`onChatError`), outbox delivery failures |
| Flow steps | `event_received` (with `duplicate`), `approval_decided`, `release_started` | the agent |

```bash
npx wrangler secret put POSTHOG_KEY      # your project token, phc_...
```

EU projects: set `POSTHOG_HOST` in `wrangler.jsonc` to `https://eu.i.posthog.com`. The
page tells visitors that usage is recorded.

## Layout

```
src/index.ts             Worker: HTTP front door, routes to the user's agent
src/agent.ts             Assistant (Think): actions, inbox, outbox, approvals
src/release-workflow.ts  ReleaseWorkflow (ThinkWorkflow): deploy-safety demo
src/mock-model.ts        scripted model for keyless runs
src/telemetry.ts         PostHog capture (LLM generations, errors)
public/index.html        one-page UI
public/architecture.svg  architecture diagram (built by docs/build-diagram.mjs)
scripts/demo.mjs         end-to-end demo and checks
```

## Notes

- **Not production-hardened.** The routes have no auth, only the rate limit. Anyone can
  approve their own (fake) refunds. Real use needs Cloudflare Access or a signed-webhook check.
- Think is marked experimental in Cloudflare's docs, and its API is still moving. The
  package versions are pinned in `package.json`.
- A Workflow paused in `waitForEvent` can report `running` rather than `waiting` (seen
  both locally and deployed), so the demo and page treat "pre-approval steps done" as paused.
- `just-bash` is installed only because the `agents` package imports it when bundling.

## Sources

The idea, and every project this demo is built on.

- [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents), Anthropic: the pattern this repo follows
- [Claude models](https://platform.claude.com/docs/en/about-claude/models/overview): Claude Haiku 5.5 does the thinking
- [cloudflare/agents](https://github.com/cloudflare/agents): the Agents SDK and the [Think](https://developers.cloudflare.com/agents/harnesses/think/) harness
- [cloudflare/computer](https://github.com/cloudflare/computer): the workspace Think uses
- [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk): Wrangler, for local dev and deploys
- Cloudflare docs: [Workers](https://developers.cloudflare.com/workers/), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Workflows](https://developers.cloudflare.com/workflows/), [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [Traces](https://developers.cloudflare.com/workers/observability/traces/)
- [vercel/ai](https://github.com/vercel/ai): the AI SDK and its Anthropic provider
- [colinhacks/zod](https://github.com/colinhacks/zod): tool input schemas
- [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash): required by the Agents SDK bundle
- [PostHog/posthog-js](https://github.com/PostHog/posthog-js) and [PostHog LLM analytics](https://posthog.com/docs/llm-analytics): usage, replays and errors
- Product icons: [cloudflare/cloudflare-docs](https://github.com/cloudflare/cloudflare-docs/tree/production/src/icons), CC BY 4.0
- Type: [Atkinson Hyperlegible Next](https://fonts.google.com/specimen/Atkinson+Hyperlegible+Next) and [Big Shoulders Stencil](https://fonts.google.com/specimen/Big+Shoulders+Stencil)

## License

MIT, see [LICENSE](LICENSE). The Cloudflare product icons in `docs/icons` are from the Cloudflare docs and stay under CC BY 4.0.
