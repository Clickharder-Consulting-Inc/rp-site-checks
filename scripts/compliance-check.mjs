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
//     - Google Analytics is platform-owned (FACTS analytics.ga4MeasurementId,
//       set from RPL's Lottery site screen):
//         * an ID in FACTS → every page carries /js/rp-ga4.js with THAT ID,
//           the script ships in dist, and the CSP admits Google's hosts
//           (a revision that drops the tag fails — the tag is protected)
//         * no ID in FACTS → no page carries the tag (no stale tracking)
//         * never a hand-pasted gtag/googletagmanager snippet or stray
//           measurement ID (prevents double tags and IDs RPL doesn't know)
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

// Money / percent tokens as they appear in page text. The magnitude suffix
// needs a word boundary: without it "$17,000 MRI" read as "$17,000M".
const MONEY_RE = /\$\s?[\d][\d,]*(?:\.\d+)?(?:\s?(?:million|M|k)\b)?/g;
const PERCENT_RE = /\b\d+(?:\.\d+)?\s?%/g;
const claimTokens = (text) => [...text.matchAll(MONEY_RE), ...text.matchAll(PERCENT_RE)].map((m) => m[0].replace(/\s+/g, ''));

// Grounded numbers: explicit allow-list + every price/value stated in FACTS +
// every amount inside an extraFacts value. extraFacts is the projection of the
// operator's Tenant data facts — an attested amount ("Splash park donation":
// "$17,000") arrives there, and this is what makes it count as grounded.
const allowed = new Set(
  [
    ...(facts.claims?.allowedNumbers ?? []),
    ...(facts.raffle?.ticketPricing ?? []).map((t) => t.price),
    ...(facts.raffle?.prizes ?? []).map((p) => p.value).filter(Boolean),
    ...Object.values(facts.extraFacts ?? {}).flatMap((v) => (typeof v === 'string' ? claimTokens(v) : [])),
  ].map((s) => String(s).replace(/\s+/g, '')),
);

const errors = [];
const warnings = [];
const pages = htmlFiles(distDir);
if (!pages.length) {
  console.error(`no HTML pages found under ${distDir}`);
  process.exit(2);
}

// --- Google Analytics (platform-owned) — site-wide preconditions ---
const GA_ID_FORMAT = /^G-[A-Z0-9]{4,20}$/;
const gaId = facts.analytics?.ga4MeasurementId ?? null;
if (gaId !== null && !GA_ID_FORMAT.test(String(gaId))) {
  errors.push(`FACTS.json analytics.ga4MeasurementId "${gaId}" is not a GA4 measurement ID (G-XXXXXXXX) — fix it on RPL's Lottery site screen`);
}
const gaOn = gaId !== null && GA_ID_FORMAT.test(String(gaId));
if (gaOn) {
  if (!existsSync(path.join(distDir, 'js', 'rp-ga4.js'))) {
    errors.push('analytics is configured but dist/js/rp-ga4.js is missing — the consent script must ship with the site');
  }
  // Without these hosts in the CSP the browser blocks GA silently — fail visibly.
  const swa = path.join(distDir, 'staticwebapp.config.json');
  const csp = existsSync(swa) ? String(JSON.parse(readFileSync(swa, 'utf8')).globalHeaders?.['Content-Security-Policy'] ?? '') : '';
  const directive = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '');
  if (!/googletagmanager\.com/.test(directive('script-src'))) errors.push('analytics is configured but the CSP script-src does not admit https://*.googletagmanager.com — GA would be blocked');
  if (!/google-analytics\.com/.test(directive('connect-src'))) errors.push('analytics is configured but the CSP connect-src does not admit https://*.google-analytics.com — GA hits would be blocked');
}
const GA_TAG = /<script[^>]*\ssrc=["']\/js\/rp-ga4\.js["'][^>]*>/i;

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

  // Google Analytics: exactly the platform tag, with FACTS' ID — nothing else.
  const gaTags = [...html.matchAll(new RegExp(GA_TAG.source, 'gi'))].map((m) => m[0]);
  const tagId = gaTags[0]?.match(/\sdata-ga-id=["']([^"']*)["']/i)?.[1] ?? null;
  if (gaOn) {
    if (!gaTags.length) errors.push(`${relPage}: Google Analytics is configured but the page is missing the /js/rp-ga4.js tag`);
    else if (tagId !== gaId) errors.push(`${relPage}: GA tag carries "${tagId ?? '(no id)'}" but FACTS sets "${gaId}"`);
  } else if (gaTags.length) {
    errors.push(`${relPage}: GA tag present but FACTS.json sets no analytics.ga4MeasurementId — remove it, or configure GA on RPL's Lottery site screen`);
  }
  if (gaTags.length > 1) errors.push(`${relPage}: more than one GA tag on the page`);
  const scriptBodies = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  if (/gtag\s*\(|googletagmanager\.com|google-analytics\.com/i.test(scriptBodies) || /googletagmanager\.com|google-analytics\.com/i.test(html)) {
    errors.push(`${relPage}: hand-added Google tag — GA4 is configured from RPL's Lottery site screen, not pasted into pages`);
  }
  for (const s of new Set([...scriptBodies.matchAll(/\bG-[A-Z0-9]{6,20}\b/g)].map((m) => m[0]))) {
    errors.push(`${relPage}: stray GA measurement ID "${s}" in a script — only the platform tag may carry one`);
  }

  const tokens = claimTokens(text);
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
