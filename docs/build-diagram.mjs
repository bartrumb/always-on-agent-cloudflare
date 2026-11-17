// Builds public/architecture.svg: a plain SVG (no HTML inside), so it renders the same
// on GitHub, in browsers and in image viewers. Run: node docs/build-diagram.mjs
//
// Product icons: Cloudflare docs (github.com/cloudflare/cloudflare-docs, src/icons),
// licensed CC BY 4.0. Cloudflare's docs use one icon for both Workers and Workflows.
import { readFileSync, writeFileSync } from "node:fs";

const C = { orange: "#F38020", tangerine: "#FAAE40", ink: "#404041", soft: "#6D6D6F", line: "#8A8A8D",
  grey: "#F2F2F2", rule: "#DEDEDE", paper: "#FFFFFF", tint: "#FEF3E8" };
const FONT = "Arial, Helvetica, sans-serif";

// Inline a Cloudflare icon as a nested <svg>, drawn white on an orange tile.
function icon(name, x, y, size = 44, tile = C.orange) {
  const raw = readFileSync(new URL(`./icons/${name}.svg`, import.meta.url), "utf8");
  const viewBox = /viewBox="([^"]+)"/.exec(raw)[1];
  const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const pad = size * 0.2;
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="10" fill="${tile}"/>
  <svg x="${x + pad}" y="${y + pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" viewBox="${viewBox}" fill="#fff" color="#fff">${inner}</svg>`;
}
// A person glyph for the human approver (no product icon for that).
const person = (x, y, size = 44) => `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="10" fill="${C.ink}"/>
  <circle cx="${x + size / 2}" cy="${y + size * 0.38}" r="${size * 0.14}" fill="#fff"/>
  <path d="M${x + size * 0.24} ${y + size * 0.8} a${size * 0.26} ${size * 0.22} 0 0 1 ${size * 0.52} 0z" fill="#fff"/>`;
const alarm = (x, y, size = 44) => `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="10" fill="${C.orange}"/>
  <circle cx="${x + size / 2}" cy="${y + size / 2 + 2}" r="${size * 0.27}" fill="none" stroke="#fff" stroke-width="3"/>
  <path d="M${x + size / 2} ${y + size / 2 + 2} v-7 M${x + size / 2} ${y + size / 2 + 2} h6" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <path d="M${x + 9} ${y + 13} l6 -5 M${x + size - 9} ${y + 13} l-6 -5" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`;
const pause = (x, y, size = 44) => `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="10" fill="${C.tangerine}"/>
  <rect x="${x + 14}" y="${y + 12}" width="6" height="20" rx="2" fill="${C.ink}"/><rect x="${x + 24}" y="${y + 12}" width="6" height="20" rx="2" fill="${C.ink}"/>`;

function text(x, y, s, { size = 15, weight = 400, color = C.ink, anchor = "start" } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${s}</text>`;
}
// A card: icon tile and title on top, description below at full width.
function card(x, y, w, h, iconSvg, title, lines, { fill = C.paper, stroke = C.rule } = {}) {
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
  ${iconSvg}
  ${text(x + 70, y + 41, title, { size: 17, weight: 700 })}
  ${lines.map((l, i) => text(x + 16, y + 82 + i * 19, l, { size: 13.5, color: C.soft })).join("")}</g>`;
}
// Arrow with an optional label on a white pill.
function arrow(d, label, lx, ly, { dashed = false, color = C.line } = {}) {
  const pill = label ? `<rect x="${lx - label.length * 3.6 - 8}" y="${ly - 13}" width="${label.length * 7.2 + 16}" height="20" rx="10" fill="${C.paper}" stroke="${C.rule}"/>
    ${text(lx, ly + 1.5, label, { size: 12.5, color: C.ink, anchor: "middle" })}` : "";
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" ${dashed ? 'stroke-dasharray="7 6"' : ""} marker-end="url(#${dashed ? "headO" : "head"})"/>${pill}`;
}

const W = 1650, H = 870;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
  aria-label="Always-on agent on Cloudflare: events reach a Worker, which hands them to one Durable Object per user. Inside it the inbox feeds runs; runs use memory, wait for approval on risky actions, set alarms that come back as new events, and send through the outbox. Runs can start a long Workflow. Traces and logs cover every step.">
<defs>
  <marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="${C.line}"/></marker>
  <marker id="headO" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="${C.orange}"/></marker>
</defs>
<rect width="${W}" height="${H}" fill="${C.paper}"/>

${text(40, 52, "Always-on agent on Cloudflare", { size: 26, weight: 700 })}
${text(40, 80, "Anthropic's five pieces (inbox, timers, memory, permissions, outbox) on Workers, Durable Objects and Workflows.", { size: 15, color: C.soft })}

<!-- Column 1: things that happen -->
${text(40, 150, "Things that happen", { size: 14, weight: 700, color: C.soft })}
${card(40, 165, 270, 125, icon("email-service", 56, 181), "Email, webhook, chat", ["Arrives at any time, and", "sometimes more than once"])}
${card(40, 440, 270, 125, person(56, 456), "A person decides", ["Approves or rejects,", "hours or days later"])}

<!-- Worker -->
${card(380, 300, 250, 125, icon("workers", 396, 316), "Worker", ["Accepts the event and", "replies 202 right away"])}
${arrow("M310 228 C 345 228, 345 335, 378 335", "POST /events", 345, 275)}
${arrow("M310 502 C 345 502, 345 392, 378 392", "POST /approvals", 345, 455)}

<!-- The Durable Object -->
<rect x="690" y="120" width="690" height="580" rx="18" fill="${C.grey}" stroke="${C.rule}" stroke-width="1.5"/>
${icon("durable-objects", 710, 138, 40)}
${text(764, 158, "Assistant: one Durable Object per user", { size: 18, weight: 700 })}
${text(764, 179, "Think agent harness, everything saved in its own SQLite", { size: 13.5, color: C.soft })}

${card(935, 200, 200, 118, icon("d1", 951, 216), "Memory", ["Conversation and a", "memory block, in SQLite"])}
${card(1160, 200, 200, 118, pause(1176, 216), "Waits for you", ["Risky action parks here.", "The run ends."], { fill: C.tint, stroke: C.tangerine })}
${card(710, 370, 200, 118, icon("queues", 726, 386), "Inbox", ["Same event id = one ticket.", "Runs one at a time."])}
${card(935, 370, 200, 118, icon("agents", 951, 386), "Run", ["Claude Haiku 5.5", "with its tools"])}
${card(1160, 370, 200, 118, icon("email-service", 1176, 386), "Outbox", ["Every message leaves", "here, exactly once"])}
${card(935, 545, 200, 118, alarm(951, 561), "Alarm", ["Wakes the agent later,", "on its own"])}

${arrow("M630 362 C 670 362, 675 429, 708 429", "RPC", 668, 372)}
${arrow("M910 429 L 933 429", "", 0, 0)}
${arrow("M1035 370 L 1035 320", "", 0, 0)}
${arrow("M1120 370 C 1135 350, 1160 345, 1185 320", "needs a person", 1105, 346)}
${arrow("M1250 318 C 1250 350, 1190 360, 1137 392", "", 0, 0, { dashed: true, color: C.orange })}
${text(1305, 350, "approved or rejected", { size: 12.5, color: C.orange, anchor: "middle" })}
${arrow("M1135 429 L 1158 429", "", 0, 0)}
${arrow("M1035 488 L 1035 543", "sets an alarm", 1035, 518)}
${arrow("M935 604 C 810 604, 810 540, 810 490", "rings as a new event", 835, 632, { dashed: true, color: C.orange })}

<!-- Right column -->
${card(1425, 370, 190, 118, icon("logs", 1441, 386), "Delivered", ["Log or webhook,", "with retries"])}
${arrow("M1360 429 L 1423 429", "", 0, 0)}
${card(1415, 560, 200, 137, icon("workflows", 1431, 576), "Workflow", ["Long job that waits for", "approval. Add steps,", "never rename them."])}
${arrow("M1110 488 C 1200 560, 1290 630, 1413 628", "runWorkflow()", 1290, 612)}

<!-- Observability -->
<rect x="40" y="745" width="1575" height="92" rx="14" fill="${C.paper}" stroke="${C.rule}" stroke-width="1.5"/>
${icon("logs", 56, 769)}
${text(116, 787, "Watching it: Cloudflare traces and logs on every request, run, tool call and alarm", { size: 16, weight: 700 })}
${text(116, 811, "PostHog adds traffic, session replays, one $ai_generation event per model call, and errors", { size: 14, color: C.soft })}
</svg>
`;
writeFileSync(new URL("../public/architecture.svg", import.meta.url), svg);
console.log("wrote public/architecture.svg", svg.length, "bytes");
