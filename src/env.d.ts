// =====================================================================================
// env.d.ts: types for the secrets.
//
// `wrangler types` writes worker-configuration.d.ts from wrangler.jsonc: the bindings
// (Assistant, RELEASE_WORKFLOW, EVENT_LIMIT, ASSETS) and the plain vars. Secrets are
// never in wrangler.jsonc, so they're declared here. TypeScript merges this into the
// global Env interface.
//
// Set them with `npx wrangler secret put <NAME>` (deployed) or in .dev.vars (local,
// git-ignored; see .dev.vars.example). Both are optional: without ANTHROPIC_API_KEY
// the agent uses the scripted model, and without POSTHOG_KEY analytics are off.
// =====================================================================================
interface Env {
  ANTHROPIC_API_KEY?: string; // Claude, through the AI SDK's Anthropic provider
  POSTHOG_KEY?: string; // PostHog project token (phc_...). Public by design, kept out of the repo anyway.
}
