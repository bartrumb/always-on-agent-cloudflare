// Deploy-safety demo. Workflow step names are cache keys: a finished step is never
// re-run when the instance resumes, *as long as its name is unchanged*.
//
//   v1         collect-changes -> draft-notes -> [wait for approval] -> publish
//   v2-add     same, plus a new "notify-team" step after approval      (safe)
//   v2-rename  "draft-notes" renamed to "draft-release-notes"           (unsafe: re-runs)
//
// Start a run on v1, let it pause at the approval, redeploy as v2-*, approve, and
// compare which steps ran (see scripts/demo.mjs).
import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import type { Assistant } from "./agent";

type Params = { requestedAt: number };

export class ReleaseWorkflow extends ThinkWorkflow<Assistant, Params> {
  async run(event: AgentWorkflowEvent<Params>, step: ThinkWorkflowStep) {
    const id = event.instanceId;
    const version = this.env.RELEASE_VERSION;

    const changes = await step.do("collect-changes", async () => {
      await this.agent.recordStep(id, "collect-changes");
      return ["faster inbox", "safer approvals"];
    });

    // Renaming a finished step gives it a new cache key, so it runs again
    // (here that means a second, paid model call).
    const draftName = version === "v2-rename" ? "draft-release-notes" : "draft-notes";
    const notes = await step.do(draftName, async () => {
      await this.agent.recordStep(id, draftName);
      return this.agent.draftReleaseNotes(changes);
    });

    // Paused here: the instance sleeps (no compute) until a human approves.
    await this.waitForApproval(step, { timeout: "7 days" });

    if (version === "v2-add") {
      // New in v2. Added *after* the steps that already finished, so it is safe.
      await step.do("notify-team", async () => {
        await this.agent.recordStep(id, "notify-team");
      });
    }

    await step.do("publish", async () => {
      await this.agent.recordStep(id, "publish");
    });

    await step.reportComplete({ notes });
  }
}
