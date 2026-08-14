# Contributing

Read [AGENTS.md](AGENTS.md) first — it explains why the architecture is shaped the way
it is, and lists the failure modes that will otherwise bite you.

## Getting set up

```sh
npm ci
npm test        # 238 tests; no network, no credentials, no live M365
npm run typecheck
npm run build
```

The test suite drives a stub SignalR server (`test/stub-copilot.ts`) that speaks the
real framing, so a full turn is exercised offline. **Keep it that way** — a test that
needs a tenant is a test nobody else can run.

To exercise the whole stack through real opencode without touching Microsoft, run the
proxy against the stub and point the plugin at it with the `baseUrl` option.

## Conventional Commits

The PR title becomes the squash subject, and release-please reads it:

- `feat:` → minor, `fix:` → patch, `!` or `BREAKING CHANGE` → major
- `perf`/`refactor`/`docs` appear in the changelog without bumping
- `ci`/`test`/`build`/`chore` are hidden
- no type at all → invisible: no bump, no changelog entry

On a **single-commit** PR, GitHub squashes using the *commit* subject rather than the PR
title. Make the two match, or add a second commit so the title wins.

## Things that need extra care

- **Prompt text** in `src/fenced.ts` and `src/plugin.ts`. M365's Disengaged filter tracks
  prompt *shape*, not size — fake `<system>`/`<user>` turns and shouted absolutes read as
  manipulation. When in doubt, lean softer. There are tests asserting the absence of those
  shapes; they are deliberate.
- **Anything that changes what M365 receives** belongs in the proxy, not an opencode hook.
  `config.tools`, `experimental.chat.system.transform` and `agent.<name>.prompt` were all
  measured non-functional in opencode 1.18.18. If you re-test on a newer version and one
  works, update the README rather than silently relocating the logic.
- **Never delete a Copilot Studio agent.** Another host on the tenant may be mid
  conversation with it.
- **Never log an access token.** `M365_TRACE=1` dumps full frames, which is why it is
  opt-in and documented as sensitive.

## Reporting M365 behaviour

If you find something about M365 itself — a new tone, a changed frame, a shifted
Disengage threshold — it is usually worth reporting upstream at
[cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) as well, since
that project's `docs/` are where this surface is documented.
