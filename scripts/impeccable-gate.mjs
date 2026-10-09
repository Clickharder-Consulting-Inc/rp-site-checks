// ============================================================================
// Impeccable design-QA gate — runs the vendored impeccable detector's BROWSER
// engine over the BUILT site and turns its findings into GitHub annotations.
//
// Browser engine, not the static one (2026-10-06): the static engine reads the
// HTML + CSS text and cannot resolve `var(--x)` colour tokens, so on a site
// that sets every colour through variables it reported dark-on-dark where the
// page is gold-on-dark (23 of 29 findings on Milk River were phantoms) and
// missed the real failures (a 1.9:1 button, white text on #fefefe, text over
// the hero video). The browser engine renders each page in headless Chrome:
// real cascade, real computed styles, pixel contrast — and it knows WHICH
// element it flagged, which rpdms uses to show the finding on the page.
//
// Mechanics:
//   - dist/ is served on a localhost port (the pages load their own CSS/JS by
//     absolute path, so file:// would reproduce the unresolved-colour problem);
//   - each page is scanned with waitUntil 'load' — the CLI default
//     'networkidle0' never fires on a page streaming a hero video or sending
//     analytics heartbeats, and times out at 30s;
//   - no fallback to the static engine: if Chrome can't launch or a page
//     can't render, this check FAILS and says so (a silent downgrade would
//     report a green review nobody ran).
//
// Annotation format (rpdms parses it — keep in step with @rp/shared):
//   ::warning file=<page>,title=<element text excerpt>::[<rule>] <page> — <snippet>⟪sel:<base64url selector>⟫
// `file` and `title` are GitHub annotation properties (path + title); the
// ⟪sel:…⟫ suffix carries the element's CSS selector for "Show on page".
//
// Usage: node impeccable-gate.mjs <distDir>
// ============================================================================

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [distDir] = process.argv.slice(2);
if (!distDir || !existsSync(distDir)) {
  console.error(`usage: impeccable-gate.mjs <distDir>`);
  process.exit(2);
}
const checksRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(checksRoot, 'vendor', 'impeccable');
const enginePath = path.join(vendorRoot, 'cli', 'engine', 'engines', 'browser', 'detect-url.mjs');
if (!existsSync(enginePath)) {
  console.error(`impeccable browser engine not found at ${enginePath} — was the submodule checked out (submodules: recursive)?`);
  process.exit(2);
}
for (const dep of ['puppeteer', 'htmlparser2', 'css-select', 'css-tree', 'domutils']) {
  if (!existsSync(path.join(vendorRoot, 'node_modules', dep))) {
    console.error(`detector dependency '${dep}' missing in ${vendorRoot} — run npm ci there (puppeteer is an optional dependency; do not --omit=optional).`);
    process.exit(2);
  }
}

// --- serve dist/ ------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};
const root = path.resolve(distDir);
const server = createServer((req, res) => {
  let f = path.join(root, decodeURIComponent((req.url ?? '/').split('?')[0]));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function htmlPages(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlPages(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}
const pages = htmlPages(root).map((p) => path.relative(root, p).replaceAll('\\', '/')).sort();
const urlFor = (rel) => `${base}/${rel.endsWith('index.html') ? rel.slice(0, -'index.html'.length) : rel}`;

// --- scan -------------------------------------------------------------------
const { createBrowserDetector } = await import(pathToFileURL(enginePath).href);
let detector;
try {
  detector = await createBrowserDetector();
} catch (e) {
  console.error(`::error::design review could not start headless Chrome: ${String(e.message ?? e).split('\n')[0]}`);
  server.close();
  process.exit(2);
}
const findings = [];
const renderErrors = [];
try {
  for (const rel of pages) {
    try {
      const found = await detector.detectUrl(urlFor(rel), { waitUntil: 'load', settleMs: 300 });
      for (const f of found) findings.push({ ...f, page: rel });
    } catch (e) {
      renderErrors.push(`${rel}: design review could not render the page — ${String(e.message ?? e).split('\n')[0]}`);
    }
  }
} finally {
  await detector.close().catch(() => {});
  server.close();
}

// --- report -----------------------------------------------------------------
// GitHub workflow-command escaping: properties also escape ':' and ','.
const escMsg = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escMsg(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const b64url = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const line = (f) => {
  const props = [`file=${escProp(f.page)}`, ...(f.text ? [`title=${escProp(f.text)}`] : [])].join(',');
  const sel = f.selector ? `⟪sel:${b64url(f.selector)}⟫` : '';
  return `${props}::${escMsg(`[${f.antipattern}] ${f.page} — ${f.snippet ?? ''}`)}${sel}`;
};
const errors = findings.filter((f) => f.severity === 'error');
const warnings = findings.filter((f) => f.severity !== 'error');
for (const e of renderErrors) console.log(`::error::${escMsg(e)}`);
for (const f of errors) console.log(`::error ${line(f)}`);
for (const f of warnings) console.log(`::warning ${line(f)}`);

const failing = errors.length + renderErrors.length;
const summary = [
  `### Impeccable design review (browser engine) — ${failing} error(s), ${warnings.length} warning(s) across ${pages.length} page(s)`,
  '',
  ...renderErrors.map((e) => `- ❌ ${e}`),
  ...(findings.length
    ? ['| severity | rule | page | where | detail |', '|---|---|---|---|---|',
       ...findings.map((f) => `| ${f.severity} | ${f.antipattern} | ${f.page} | ${(f.text ?? '').replaceAll('|', '\\|').slice(0, 60)} | ${(f.snippet ?? '').replaceAll('|', '\\|').slice(0, 120)} |`)]
    : ['No design findings.']),
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
else console.log(summary);
process.exit(failing ? 1 : 0);
