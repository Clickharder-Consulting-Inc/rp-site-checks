// ============================================================================
// impeccable design gate — runs the PINNED impeccable detector over a built
// site and fails the check when any error-severity finding exists.
//
// Fail-closed posture (ported from rpdms modules/site/detector.ts): the
// detector's parser dependencies must be present, otherwise the CLI silently
// degrades to regex-only detection and misses whole rule families. A missing
// dep is a hard failure of THIS gate, never a quiet pass.
//
// Usage: node impeccable-gate.mjs <distDir>
// Exit codes: 0 clean/warnings-only · 1 error findings · 2 gate unavailable
// ============================================================================

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const distDir = process.argv[2];
if (!distDir || !existsSync(distDir)) {
  console.error(`usage: impeccable-gate.mjs <distDir> (got: ${distDir ?? 'nothing'})`);
  process.exit(2);
}

const checksRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(checksRoot, 'vendor', 'impeccable');
const cli = path.join(vendorRoot, 'cli', 'bin', 'cli.js');

if (!existsSync(cli)) {
  console.error(`impeccable CLI not found at ${cli} — was the submodule checked out (submodules: recursive)?`);
  process.exit(2);
}
for (const dep of ['htmlparser2', 'css-select', 'css-tree', 'domutils']) {
  if (!existsSync(path.join(vendorRoot, 'node_modules', dep))) {
    console.error(`detector dependency '${dep}' missing in ${vendorRoot} — run npm ci there. ` +
      'Refusing to run: without parser deps the detector silently degrades to regex-only.');
    process.exit(2);
  }
}

const run = spawnSync('node', [cli, 'detect', '--json', distDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0 && !run.stdout) {
  console.error(`detector failed (exit ${run.status}): ${run.stderr}`);
  process.exit(2);
}

let findings;
try {
  findings = JSON.parse(run.stdout);
} catch {
  console.error(`detector emitted unparseable output: ${run.stdout.slice(0, 500)}`);
  process.exit(2);
}

const errors = findings.filter((f) => f.severity === 'error');
const warnings = findings.filter((f) => f.severity !== 'error');
const rel = (f) => path.relative(distDir, f.file ?? '').replaceAll('\\', '/');

writeFileSync('impeccable-findings.json', JSON.stringify(findings, null, 2));

for (const f of errors) console.log(`::error::[${f.antipattern}] ${rel(f)} — ${f.snippet ?? ''}`);
for (const f of warnings) console.log(`::warning::[${f.antipattern}] ${rel(f)} — ${f.snippet ?? ''}`);

const summary = [
  `### Impeccable design review — ${errors.length} error(s), ${warnings.length} warning(s)`,
  '',
  ...(findings.length
    ? ['| Severity | Rule | File | Detail |', '|---|---|---|---|',
       ...findings.map((f) => `| ${f.severity} | ${f.antipattern} | ${rel(f)} | ${(f.snippet ?? '').replaceAll('|', '\\|').slice(0, 120)} |`)]
    : ['Clean — no findings.']),
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');

process.exit(errors.length ? 1 : 0);
