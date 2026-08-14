## What and why

<!-- What changes, and what problem it solves. -->

## Checks

- [ ] `npm test` passes (no network, no credentials, no live M365 in the suite)
- [ ] `npm run typecheck` and `npm run build` pass
- [ ] The PR title is a Conventional Commit — it becomes the squash subject and is
      what release-please reads. On a **single-commit** PR GitHub squashes using the
      *commit* subject instead, so make the two match.

## If this touches the protocol or a prompt

- [ ] Behaviour verified against the stub, not just reasoned about
- [ ] Prompt changes stay soft — no fake role turns, no shouted absolutes (the
      Disengaged filter tracks prompt *shape*)
- [ ] Nothing deletes a Copilot Studio agent
- [ ] No access token can reach a log or an error message

## If this moves logic into an opencode hook

`config.tools`, `experimental.chat.system.transform` and `agent.<name>.prompt` were
all measured non-functional in opencode 1.18.18, which is why enforcement lives in
the proxy. Moving it back needs evidence the hook now works — see AGENTS.md.
