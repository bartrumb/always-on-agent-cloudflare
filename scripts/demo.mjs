// End-to-end demo against `wrangler dev`. No API key needed (MODEL_MODE=mock).
//   node scripts/demo.mjs            inbox -> run -> deferred approval -> resume, then deploy safety
//   node scripts/demo.mjs inbox      only the first part
//   node scripts/demo.mjs deploy     only the deploy-safety part
import { spawn, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const user = `demo-${Date.now()}`;
const part = process.argv[2] ?? "all";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

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
function stopDev() {
  if (!dev) return;
  if (process.platform === "win32") execSync(`taskkill /pid ${dev.pid} /T /F`, { stdio: "ignore" });
  else dev.kill("SIGTERM");
  dev = undefined;
}

const call = async (method, path, body) => {
  for (;;) {
    const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    if (res.status !== 429) return res.json();
    console.log("    (rate limited: 10 events/min per IP; waiting)");
    await sleep(10_000);
  }
};
async function until(label, fn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function inboxDemo() {
  say("1. Event inbox: a webhook arrives, the Worker acks fast");
  const first = await call("POST", `/events/${user}`, { source: "email", id: "msg-1", text: "Please refund order #A100, it arrived broken" });
  console.log("   first delivery :", first);
  const retry = await call("POST", `/events/${user}`, { source: "email", id: "msg-1", text: "Please refund order #A100, it arrived broken" });
  console.log("   retried webhook:", retry);
  assert.equal(retry.accepted, false, "duplicate source event must be ignored");
  assert.equal(retry.submissionId, first.submissionId);

  say("2. The run calls issue_refund, which needs a human: the run ends and waits");
  const s1 = await until("pending approval", async () => {
    const s = await call("GET", `/status/${user}`);
    return s.pendingApprovals.length ? s : null;
  });
  console.log("   pending approval:", s1.pendingApprovals[0]);
  assert.equal(s1.outbox.some((m) => m.key.startsWith("refund:")), false, "nothing is sent before approval");

  say("3. Hours later, a person approves. The answer arrives as a new event and resumes the saved task");
  const decision = await call("POST", `/approvals/${user}/${s1.pendingApprovals[0].executionId}`, { approve: true });
  console.log("   decision:", decision);
  const s2 = await until("refund in outbox", async () => {
    const s = await call("GET", `/status/${user}`);
    return s.outbox.find((m) => m.key.startsWith("refund:") && m.status === "sent") ? s : null;
  });
  console.log("   outbox:", s2.outbox);

  say("4. Timers: ask for a reminder; the Durable Object alarm wakes the agent later");
  await call("POST", `/events/${user}`, { source: "chat", id: "chat-7", text: "Remind me to check the shipment" });
  const s3 = await until("timer follow-up sent", async () => {
    const s = await call("GET", `/status/${user}`);
    return s.outbox.find((m) => m.body.startsWith("Following up") && m.status === "sent") ? s : null;
  }, 60);
  console.log("   submissions:", s3.submissions.map((x) => `${x.key} -> ${x.status}`));
}

async function deployDemo(v2) {
  say(`5. Deploy safety (${v2}): start a release on v1, pause it at approval, deploy ${v2}, resume`);
  await startDev("v1");
  const { workflowId } = await call("POST", `/releases/${user}`);
  // Production reports "waiting"; the local emulator keeps saying "running" while the
  // instance sits in waitForEvent, so also accept "both pre-approval steps logged".
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
    const add = await deployDemo("v2-add");
    assert.deepEqual(add, ["collect-changes@v1", "draft-notes@v1", "notify-team@v2-add", "publish@v2-add"]);
    console.log("   ✓ added step ran; saved steps were NOT re-run");

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
