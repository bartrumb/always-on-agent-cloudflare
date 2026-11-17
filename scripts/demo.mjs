// =====================================================================================
// demo.mjs: the end-to-end test, written as a story you can read top to bottom.
//
// READ THIS AFTER release-workflow.ts. Each numbered section exercises one piece of
// Anthropic's article over plain HTTP, and asserts what should happen.
//
//   node scripts/demo.mjs            all of it (about 3 minutes)
//   node scripts/demo.mjs inbox      sections 1 to 4: inbox, approval, outbox, timers
//   node scripts/demo.mjs deploy     section 5: deploy safety, v2-add and v2-rename
//
// It starts `wrangler dev` itself (a local Workers runtime with Durable Objects,
// alarms and Workflows), and restarts it to "deploy" a new version. No API key is
// needed: without ANTHROPIC_API_KEY the agent uses the scripted model, so the results
// are the same every run. Local state lives in .wrangler/ and survives restarts,
// which is exactly what the deploy-safety section relies on.
// =====================================================================================
import { spawn, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
// A fresh user id per run = a fresh agent (Durable Object) with empty storage.
const user = `demo-${Date.now()}`;
const part = process.argv[2] ?? "all";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

// ---- Helpers ----------------------------------------------------------------------
// startDev(version) runs `wrangler dev` with RELEASE_VERSION set, which is how this
// script "deploys" v1, v2-add or v2-rename. It echoes the agent's [outbox] log lines
// and waits until the Worker answers.
let dev;
async function startDev(version) {
  dev = spawn(`npx wrangler dev --port ${PORT} --var RELEASE_VERSION:${version}`, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  dev.stdout.on("data", (d) => String(d).split("\n").filter((l) => l.includes("[outbox]")).forEach((l) => console.log("   ", l.trim())));
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`${BASE}/status/${user}`);
      console.log(`   (wrangler dev up, RELEASE_VERSION=${version})`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("wrangler dev did not start");
}
// Stops wrangler dev and everything it started (taskkill /T on Windows).
function stopDev() {
  if (!dev) return;
  if (process.platform === "win32") execSync(`taskkill /pid ${dev.pid} /T /F`, { stdio: "ignore" });
  else dev.kill("SIGTERM");
  dev = undefined;
}

// One HTTP call to the Worker. The Worker rate-limits model-waking requests (10 a
// minute per IP), so on a 429 this waits and tries again instead of failing.
const call = async (method, path, body) => {
  for (;;) {
    const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    if (res.status !== 429) return res.json();
    console.log("    (rate limited: 10 events/min per IP; waiting)");
    await sleep(10_000);
  }
};
// Polls until fn() returns something truthy. The agent works in the background (on its
// alarm), so the script checks /status until the expected change shows up.
async function until(label, fn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// ---- Sections 1 to 4: the article's pieces --------------------------------------------
async function inboxDemo() {
  // 1. Event inbox. The same email (same source + id) is delivered twice, as a webhook
  //    sender does when it retries. The second delivery must return the SAME submission
  //    with accepted: false, so the agent acts once.
  say("1. Event inbox: a webhook arrives, the Worker acks fast");
  const first = await call("POST", `/events/${user}`, { source: "email", id: "msg-1", text: "Please refund order #A100, it arrived broken" });
  console.log("   first delivery :", first);
  const retry = await call("POST", `/events/${user}`, { source: "email", id: "msg-1", text: "Please refund order #A100, it arrived broken" });
  console.log("   retried webhook:", retry);
  assert.equal(retry.accepted, false, "duplicate source event must be ignored");
  assert.equal(retry.submissionId, first.submissionId);

  // 2. Permissions. The model calls issue_refund, a durable-pause action. The run ends,
  //    a pending approval appears, and nothing has been sent yet.
  say("2. The run calls issue_refund, which needs a human: the run ends and waits");
  const s1 = await until("pending approval", async () => {
    const s = await call("GET", `/status/${user}`);
    return s.pendingApprovals.length ? s : null;
  });
  console.log("   pending approval:", s1.pendingApprovals[0]);
  assert.equal(s1.outbox.some((m) => m.key.startsWith("refund:")), false, "nothing is sent before approval");

  // 3. The answer, and the outbox. Approving runs the saved action once; its message
  //    goes into the outbox and is delivered (status "sent").
  say("3. Hours later, a person approves. The answer arrives as a new event and resumes the saved task");
  const decision = await call("POST", `/approvals/${user}/${s1.pendingApprovals[0].executionId}`, { approve: true });
  console.log("   decision:", decision);
  const s2 = await until("refund in outbox", async () => {
    const s = await call("GET", `/status/${user}`);
    return s.outbox.find((m) => m.key.startsWith("refund:") && m.status === "sent") ? s : null;
  });
  console.log("   outbox:", s2.outbox);

  // 4. Timers. The model sets an alarm (schedule_follow_up). When it rings, a new
  //    "timer" event lands in the inbox, and the agent sends a follow-up.
  say("4. Timers: ask for a reminder; the Durable Object alarm wakes the agent later");
  await call("POST", `/events/${user}`, { source: "chat", id: "chat-7", text: "Remind me to check the shipment" });
  const s3 = await until("timer follow-up sent", async () => {
    const s = await call("GET", `/status/${user}`);
    return s.outbox.find((m) => m.body.startsWith("Following up") && m.status === "sent") ? s : null;
  }, 60);
  console.log("   submissions:", s3.submissions.map((x) => `${x.key} -> ${x.status}`));
}

// ---- Section 5: deploy safety (see src/release-workflow.ts) -------------------------------
// Start a Workflow on v1 and let it pause at the approval. Stop the Worker, start it
// again as v2 (that's the "deploy"), approve, and list every step that really ran.
// Returns entries like "draft-notes@v1": the step, and the version that ran it.
async function deployDemo(v2) {
  say(`5. Deploy safety (${v2}): start a release on v1, pause it at approval, deploy ${v2}, resume`);
  await startDev("v1");
  const { workflowId } = await call("POST", `/releases/${user}`);
  // A Workflow paused in waitForEvent can report "running" rather than "waiting" (seen
  // locally and deployed), so also accept "both pre-approval steps logged".
  const paused = await until("workflow waiting for approval", async () => {
    const r = await call("GET", `/releases/${user}/${workflowId}`);
    const steps = r.stepsThatRan?.map((s) => s.step) ?? [];
    return r.status?.status === "waiting" || steps.includes("draft-notes") ? r : null;
  });
  await sleep(1500); // let the instance reach waitForEvent before we "deploy"
  console.log("   v1 ran:", paused.stepsThatRan.map((s) => s.step).join(", "), "-> waiting");
  stopDev();

  await startDev(v2);
  await call("POST", `/releases/${user}/${workflowId}/approve`);
  const done = await until("workflow complete", async () => {
    const r = await call("GET", `/releases/${user}/${workflowId}`);
    return r.status?.status === "complete" ? r : null;
  });
  const ran = done.stepsThatRan.map((s) => `${s.step}@${s.version}`);
  console.log("   all step executions:", ran.join(", "));
  stopDev();
  return ran;
}

try {
  if (part === "all" || part === "inbox") {
    await startDev("v1");
    await inboxDemo();
    stopDev();
  }
  if (part === "all" || part === "deploy") {
    // Adding a step: the two finished steps show @v1 (not re-run); only the new step and
    // publish ran on v2.
    const add = await deployDemo("v2-add");
    assert.deepEqual(add, ["collect-changes@v1", "draft-notes@v1", "notify-team@v2-add", "publish@v2-add"]);
    console.log("   ✓ added step ran; saved steps were NOT re-run");

    // Renaming a step: the renamed step has no saved result, so it runs again on v2.
    const rename = await deployDemo("v2-rename");
    assert.ok(rename.includes("draft-release-notes@v2-rename"));
    console.log("   ✗ renamed step got a new cache key, so it ran again (a second model call)");
  }
  say("All checks passed.");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  stopDev();
}
