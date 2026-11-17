// =====================================================================================
// index.ts: the Worker, the HTTP front door.
//
// READ THIS FILE FIRST. It's short, and it shows the shape of the whole system.
//
// What it does
//   Every request lands here first. The Worker does as little as possible: it checks
//   the request, finds that visitor's agent (a Durable Object, see agent.ts), hands
//   the request over, and replies. The real work happens later, inside the agent.
//   That's the article's "event inbox" idea: accept fast (202), process later.
//
// Routes (the demo page in public/index.html calls these)
//   POST /events/:user                     a new event (webhook, email, chat) -> 202
//   GET  /status/:user                     everything the agent holds, for the page
//   POST /approvals/:user/:executionId     a person's yes/no on a paused action
//   POST /releases/:user                   start the deploy-safety Workflow
//   POST /releases/:user/:id/approve       approve that Workflow
//   GET  /releases/:user/:id               which Workflow steps really ran
//   GET  /config                           public PostHog settings for the page
//   Anything else under /agents/* goes to the Agents SDK router (WebSockets etc.).
//   Static files (the page, the diagram) are served by Workers Static Assets before
//   this code runs; see `assets` in wrangler.jsonc.
//
// NOTE: there is no auth. This is a public reference demo, protected only by a rate
// limit. Put Cloudflare Access or a signed-webhook check in front of anything real.
// =====================================================================================
import { getAgentByName, routeAgentRequest } from "agents";
import type { InboundEvent } from "./agent";
import { captureError } from "./telemetry";

// Durable Object and Workflow classes must be exported from the Worker's main module;
// wrangler.jsonc binds them by these class names.
export { Assistant } from "./agent";
export { ReleaseWorkflow } from "./release-workflow";

const json = (body: unknown, status = 200) => Response.json(body, { status });

export default {
  // Wrap every request so an unexpected error becomes a clean 500 for the caller, a
  // line in Workers Logs, and an $exception in PostHog. ctx.waitUntil() lets the error
  // report finish after the response is sent.
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

// Serves a video from static assets with HTTP Range support. Lesson learned: static
// assets always answer 200 with the whole file, and Safari on iPhone refuses to play
// a video unless the server answers Range requests with 206 Partial Content. The
// walkthrough is a few MB, so reading it and slicing in memory is fine.
async function serveVideo(request: Request, env: Env, url: URL): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin)));
  if (!asset.ok) return asset;
  const body = await asset.arrayBuffer();
  const size = body.byteLength;
  const headers = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "public, max-age=3600" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (!range) return new Response(body, { headers: { ...headers, "content-length": String(size) } });
  // "bytes=a-b", "bytes=a-" (to the end) or "bytes=-n" (the last n bytes).
  let start = range[1] ? Number(range[1]) : size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  start = Math.max(0, start); end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(body.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) }
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Public PostHog settings for the page. A PostHog project token is meant to be
  // public (browsers send it), so returning it is fine.
  if (url.pathname === "/config") return json({ posthogKey: env.POSTHOG_KEY ?? null, posthogHost: env.POSTHOG_HOST });
  if (url.pathname.startsWith("/media/") && url.pathname.endsWith(".mp4")) return serveVideo(request, env, url);

  // Paths look like /<kind>/<user>/<a>/<b>, e.g. /approvals/s-123/actpause_456.
  const [, kind, user, a, b] = url.pathname.split("/");
  if (!user) return (await routeAgentRequest(request, env)) ?? json({ error: "not found" }, 404);
  // The user id names a Durable Object, so keep it short and plain.
  if (!/^[\w-]{1,40}$/.test(user)) return json({ error: "bad user id" }, 400);

  // getAgentByName() turns a name into that agent's Durable Object stub. The same name
  // always reaches the same instance, anywhere in the world: one agent per user.
  // Calls on the stub (agent.ingest(...)) are RPC into the Durable Object.
  const agent = await getAgentByName(env.Assistant, user);

  // Anything that can wake the model is rate-limited per IP: 10 a minute (the
  // EVENT_LIMIT binding in wrangler.jsonc). It's a public demo, and model calls cost money.
  if (request.method === "POST" && (kind === "events" || (kind === "releases" && !a))) {
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    const { success } = await env.EVENT_LIMIT.limit({ key: ip });
    if (!success) return json({ error: "Slow down: 10 events a minute per visitor." }, 429);
  }

  // Event inbox: POST /events/:user  {source, id, text}  -> 202 once accepted.
  // The event is rebuilt here, field by field: the text is capped at 500 characters,
  // and a caller can't set causedBy (only the agent links events to each other).
  // The same source + id twice comes back with accepted: false (see agent.ingest).
  if (kind === "events" && request.method === "POST") {
    const e = (await request.json()) as InboundEvent;
    if (typeof e?.text !== "string" || !e.text.trim()) return json({ error: "text required" }, 400);
    const event = { source: String(e.source ?? "web").slice(0, 20), id: String(e.id ?? crypto.randomUUID()).slice(0, 80), text: e.text.slice(0, 500) };
    return json(await agent.ingest(event), 202);
  }

  // Everything the agent is holding: inbox, pending approvals, outbox, alarms, notes.
  if (kind === "status") return json(await agent.snapshot());

  // A person's answer to a paused action: POST /approvals/:user/:executionId  {approve, reason?}
  if (kind === "approvals" && a && request.method === "POST") {
    const { approve, reason } = (await request.json()) as { approve: boolean; reason?: string };
    return json(await agent.decide(a, approve, reason));
  }

  // Deploy-safety demo (see release-workflow.ts).
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
