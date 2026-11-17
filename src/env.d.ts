// Secrets, never in wrangler.jsonc: `npx wrangler secret put <NAME>`
// (or put them in .dev.vars for local runs).
interface Env {
  ANTHROPIC_API_KEY?: string;
  POSTHOG_KEY?: string; // PostHog project token (phc_...). Public by design, kept out of the repo anyway.
}
