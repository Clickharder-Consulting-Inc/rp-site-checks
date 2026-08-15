# rp-site-checks

Central, reusable PR checks + deploy workflow for Raffles Plus DMS tenant lottery
sites (site engine v3 — `raffles-plus-dms/docs/raffles-plus-site-github-flow-plan.md` §6).

Tenant repos (`rp-site-*`) carry only thin caller workflows; the real gates live
here so 20 tenant repos can't drift and no editor can quietly weaken a gate —
the branch ruleset requires these named jobs.

**This repo is public on purpose**: reusable workflows here must be callable
from private tenant repos, and the check jobs `actions/checkout` this repo for
its scripts — both are friction-free only for a public repo. It contains only
generic check tooling; nothing tenant- or purchaser-related may ever land here.

## What runs on every tenant PR (`site-pr-checks.yml`)

1. **Build** — `astro build`; the built `dist/` is what the gates inspect.
2. **Impeccable design review** — the pinned impeccable detector
   (`vendor/impeccable`, a git submodule pinned by commit) over `dist/`;
   error-severity findings fail the check. The gate refuses to run if the
   detector's parser deps are missing (silent regex-only degradation is the
   documented trap — see rpdms `vendor/IMPECCABLE-SNAPSHOT.md`).
3. **Compliance review** — `dist/` verified against the repo's `FACTS.json`
   (the contract rpdms owns): licence ref, 18+ marker, mailing address, sender
   identity, and a privacy-policy link on **every** page; no external scripts;
   money/percent claims must trace to FACTS (warnings).
4. **Preview deploy** — `dist/` to the tenant SWA `preview` environment when
   `AZURE_SWA_DEPLOY_TOKEN` is provisioned (skips visibly otherwise).

## Production deploy (`site-deploy.yml`)

Runs only from a tenant repo's tag workflow (`deploy-v*`). rpdms creates the tag
when a manager clicks Publish — merge ≠ publish. Builds and deploys to the SWA
production environment; a missing deploy token is a hard failure.

## Pinning policy

`vendor/impeccable` follows the same snapshot policy as rpdms: pinned by commit,
upgraded deliberately (re-run golden fixtures, re-baseline, bump both repos in
lockstep). Never track a moving branch.
