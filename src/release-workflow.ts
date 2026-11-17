// =====================================================================================
// release-workflow.ts: the deploy-safety demo.
//
// READ THIS FILE THIRD. It's about the problem the article doesn't cover: shipping new
// code while a long job is paused, waiting for a person.
//
// The idea
//   A Cloudflare Workflow is a function made of named steps (step.do("name", fn)).
//   Each finished step's result is saved under its NAME. When a paused instance
//   resumes, even on newly deployed code, every step whose name it has already
//   finished returns the saved result instead of running again.
//   So step names are cache keys. The rule that follows: add new steps, but never
//   rename a finished one, or it runs again.
//
// The demo runs three versions of this one file (picked by RELEASE_VERSION):
//   v1         collect-changes -> draft-notes -> [wait for approval] -> publish
//   v2-add     same, plus a new "notify-team" step after approval      (safe)
//   v2-rename  "draft-notes" renamed to "draft-release-notes"           (unsafe: re-runs)
// scripts/demo.mjs starts a run on v1, lets it pause at the approval, restarts the
// Worker as v2-*, approves, and checks which steps ran. In real life, v2 would be a
// code change and a `wrangler deploy`.
// =====================================================================================
import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import type { Assistant } from "./agent";

type Params = { requestedAt: number };

// ThinkWorkflow is a Workflow that belongs to a Think agent. `this.agent` is an RPC
// stub for the agent that started it (agent.startRelease() -> runWorkflow()), so steps
// can call the agent's methods, and waitForApproval() listens for approveWorkflow().
export class ReleaseWorkflow extends ThinkWorkflow<Assistant, Params> {
  async run(event: AgentWorkflowEvent<Params>, step: ThinkWorkflowStep) {
    const id = event.instanceId;
    const version = this.env.RELEASE_VERSION;

    // Step 1. Its return value is saved under "collect-changes". Every step records
    // itself (agent.recordStep) from INSIDE the step, so the log only grows when the
    // step really runs, not when a saved result is replayed.
    const changes = await step.do("collect-changes", async () => {
      await this.agent.recordStep(id, "collect-changes");
      return ["faster inbox", "safer approvals"];
    });

    // Step 2: a model call. On v2-rename this step gets a new name, which is a new
    // cache key: the saved result is not found, so it runs again (a second, paid
    // model call). That's the bug the rule prevents.
    const draftName = version === "v2-rename" ? "draft-release-notes" : "draft-notes";
    const notes = await step.do(draftName, async () => {
      await this.agent.recordStep(id, draftName);
      return this.agent.draftReleaseNotes(changes);
    });

    // The pause. The instance sleeps here using no compute, for up to 7 days, until
    // agent.approveWorkflow() sends the approval event. A deploy can happen meanwhile.
    await this.waitForApproval(step, { timeout: "7 days" });

    if (version === "v2-add") {
      // New in v2. It sits after the steps that already finished and has a new name,
      // so it simply runs once. Nothing saved is disturbed: this is the safe change.
      await step.do("notify-team", async () => {
        await this.agent.recordStep(id, "notify-team");
      });
    }

    await step.do("publish", async () => {
      await this.agent.recordStep(id, "publish");
    });

    // Tells the agent the workflow finished (Agents SDK callback), with the result.
    await step.reportComplete({ notes });
  }
}
