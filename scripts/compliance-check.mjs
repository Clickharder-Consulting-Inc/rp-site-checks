// ============================================================================
// Compliance gate — verifies a BUILT tenant site against its FACTS.json (the
// compliance contract rpdms owns). Anchors ported from rpdms's mechanical
// verifier (agent-engine.ts verifyAgentOutput) + numeric grounding from
// grounding.ts:
//
//   errors (fail the check):
//     - every page carries the licence ref, an 18+ marker, the mailing
//       address, the sender identity, and a link to the privacy policy
//     - no external <script src> (only same-origin bundles)
//   warnings (reported, non-blocking — parity with the rpdms grounding gate):
//     - money/percent claims in visible text that don't trace to FACTS
//       (claims.allowedNumbers + ticket prices + prize values)
//
// Usage: node compliance-check.mjs <distDir> <factsPath>
// ============================================================================

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const [distDir, factsPath] = process.argv.slice(2);
if (!distDir || !existsSync(distDir) || !factsPath || !existsSync(factsPath)) {
  console.error(`usage: compliance-check.mjs <distDir> <factsPath>`);
  process.exit(2);
}
const facts = JSON.parse(readFileSync(factsPath, 'utf8'));

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const visibleText = (html) =>
  decode(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Grounded numbers: explicit allow-list + every price/value stated in FACTS.
const allowed = new Set(
  [
    ...(facts.claims?.allowedNumbers ?? []),
    ...(facts.raffle?.ticketPricing ?? []).map((t) => t.price),
    ...(facts.raffle?.prizes ?? []).map((p) => p.value).filter(Boolean),
  ].map((s) => String(s).replace(/\s+/g, '')),
);

const errors = [];
const warnings = [];
const pages = htmlFiles(distDir);
if (!pages.length) {
  console.error(`no HTML pages found under ${distDir}`);
  process.exit(2);
}

for (const page of pages) {
  const relPage = path.relative(distDir, page).replaceAll('\\', '/');
  const html = readFileSync(page, 'utf8');
  const text = visibleText(html);

  const anchors = [
    ['licence ref', facts.licence?.ref],
    ['mailing address', facts.org?.mailingAddress],
    ['sender identity', facts.org?.senderIdentity],
  ];
  for (const [label, value] of anchors) {
    if (!value) errors.push(`${relPage}: FACTS.json is missing the ${label} — cannot verify`);
    else if (!norm(text).includes(norm(String(value)))) errors.push(`${relPage}: missing ${label} ("${value}")`);
  }
  if (!/18\s*\+|18 years|18 or older/i.test(text)) errors.push(`${relPage}: missing 18+ age marker`);
  const privacyUrl = facts.org?.privacyUrl;
  if (!privacyUrl) errors.push(`${relPage}: FACTS.json missing privacyUrl`);
  else if (!html.includes(`href="${privacyUrl}"`) && !html.includes(`href="${privacyUrl}/"`)) {
    errors.push(`${relPage}: no link to the privacy policy (${privacyUrl})`);
  }

  for (const m of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)) {
    const src = m[1];
    if (!(src.startsWith('/') || src.startsWith('./'))) errors.push(`${relPage}: external script "${src}"`);
  }

  const tokens = [
    ...text.matchAll(/\$\s?[\d][\d,]*(?:\.\d+)?(?:\s?(?:million|M|k))?/g),
    ...text.matchAll(/\b\d+(?:\.\d+)?\s?%/g),
  ].map((m) => m[0].replace(/\s+/g, ''));
  for (const t of new Set(tokens)) {
    if (!allowed.has(t)) warnings.push(`${relPage}: ungrounded claim "${t}" — not in FACTS.json`);
  }
}

for (const e of errors) console.log(`::error::${e}`);
for (const w of warnings) console.log(`::warning::${w}`);
const summary = [
  `### Compliance review — ${errors.length} error(s), ${warnings.length} warning(s) across ${pages.length} page(s)`,
  '',
  ...errors.map((e) => `- ❌ ${e}`),
  ...warnings.map((w) => `- ⚠️ ${w}`),
  ...(errors.length || warnings.length ? [] : ['All compliance anchors present on every page; every numeric claim grounded.']),
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');

process.exit(errors.length ? 1 : 0);
