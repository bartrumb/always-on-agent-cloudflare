// The Worker: a thin, fast HTTP front door. It routes each request to that user's
// agent and returns; the work happens later inside the agent.
//
// NOTE: no auth. This is a reference demo; put Access or a signed-webhook check in
// front of it before exposing it.
import { getAgentByName, routeAgentRequest } from "agents";
import type { InboundEvent } from "./agent";
import { captureError } from "./telemetry";

export { Assistant } from "./agent";
export { ReleaseWorkflow } from "./release-workflow";

const json = (body: unknown, status = 200) => Response.json(body, { status });

export default {
  // Every unhandled error goes to Workers Logs/traces and to PostHog error tracking.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      const sid = new URL(request.url).pathname.split("/")[2] || "anonymous";
      ctx.waitUntil(captureError(env, sid, err, { where: "worker", path: new URL(request.url).pathname, method: request.method }));
      return json({ error: "Something went wrong. It has been logged." }, 500);
    }
  }
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Public PostHog settings for the page (the project token is a public key).
  if (url.pathname === "/config") return json({ posthogKey: env.POSTHOG_KEY ?? null, posthogHost: env.POSTHOG_HOST });
  const [, kind, user, a, b] = url.pathname.split("/");
  if (!user) return (await routeAgentRequest(request, env)) ?? json({ error: "not found" }, 404);
  // Each browser gets its own agent; keep ids short and plain.
  if (!/^[\w-]{1,40}$/.test(user)) return json({ error: "bad user id" }, 400);
  const agent = await getAgentByName(env.Assistant, user);

  // Anything that wakes the model is rate-limited per IP (public demo, real money).
  if (request.method === "POST" && (kind === "events" || (kind === "releases" && !a))) {
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    const { success } = await env.EVENT_LIMIT.limit({ key: ip });
    if (!success) return json({ error: "Slow down: 10 events a minute per visitor." }, 429);
  }

  // Event inbox: POST /events/:user  {source, id, text}  -> 202 once accepted
  if (kind === "events" && request.method === "POST") {
    const e = (await request.json()) as InboundEvent;
    if (typeof e?.text !== "string" || !e.text.trim()) return json({ error: "text required" }, 400);
    const event = { source: String(e.source ?? "web").slice(0, 20), id: String(e.id ?? crypto.randomUUID()).slice(0, 80), text: e.text.slice(0, 500) };
    return json(await agent.ingest(event), 202);
  }
  // Everything the agent is holding: submissions, pending approvals, outbox
  if (kind === "status") return json(await agent.snapshot());

  // Human answer: POST /approvals/:user/:executionId  {approve, reason?}
  if (kind === "approvals" && a && request.method === "POST") {
      const { approve, reason } = (await request.json()) as { approve: boolean; reason?: string };
      return json(await agent.decide(a, approve, reason));
    }

    // Deploy-safety demo
    if (kind === "releases") {
      if (!a && request.method === "POST") return json({ workflowId: await agent.startRelease() }, 201);
      if (a && b === "approve" && request.method === "POST") {
        await agent.approveRelease(a);
        return json({ approved: a });
      }
      if (a) return json(await agent.releaseReport(a));
    }

    return (await routeAgentRequest(request, env)) ?? json({ error: "not found" }, 404);
}
