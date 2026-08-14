# AGENTS.md

Working notes for agents and humans editing this repo.

## What this is

An opencode plugin that makes Microsoft 365 Copilot usable as opencode's model backend.
It implements M365's undocumented SignalR protocol, exposes it as an OpenAI-compatible
proxy, and constrains opencode enough that M365 will engage with it.

Start with the README — it explains the Disengaged constraint, which is the reason almost
every design decision here is what it is.

## The one rule that shapes the architecture

**Anything that has to change what M365 receives belongs in the proxy, not in an opencode
hook.** Two opencode levers were tried and measured non-functional in 1.18.18:

| Lever | What happens |
|---|---|
| `config.tools` from the `config` hook | Resolved into the config, visible in `opencode debug config`, and then ignored — the request still offers every tool |
| `experimental.chat.system.transform` | Fires, accepts a replacement `system` array, and the original prompt is sent anyway |
| `agent.<name>.prompt` from the `config` hook | Ignored the same way |

The proxy sees the final OpenAI request. That is where `selectLeanTools` and
`condenseSystemPrompt` run, and where anything similar should go.

If you re-test these on a newer opencode and one starts working, say so in the README —
do not silently move the logic back.

## Layout

| File | Responsibility |
|---|---|
| `src/session.ts` | SignalR over WebSocket: framing, the mandatory Metrics frame, ping, stop, Disengaged |
| `src/auth.ts` | MSAL silent refresh. **Never opens a browser** |
| `src/login.ts` | The browser sign-in. CLI-only, Playwright is an optional dependency |
| `src/agent.ts` | Copilot Studio declarative agent: discovery, create, publish, hash-versioning |
| `src/fenced.ts` | The fenced tool-call contract, both directions, plus the hardening layers |
| `src/translate.ts` | OpenAI ⇄ M365: conversation pooling, delta sends, prompt condensing, streaming |
| `src/server.ts` | The HTTP surface. `node:http`, loopback only |
| `src/config.ts` | Provider config and tool policy — the pure decisions |
| `src/plugin.ts` | The opencode plugin. Thin: starts the proxy, registers the provider |
| `src/cli.ts` | `opencode-m365 login \| setup \| serve \| doctor` |

## Testing

TDD, `pnpm test`. No network, no credentials, no live M365 — ever, in the test suite.

`test/stub-copilot.ts` speaks enough of the real protocol to drive a full turn, and
records every frame the client sends so tests can assert on things the real server
punishes silently. The most important of those: **the `Metrics` frame must ride in the
same `ws.send()` as the chat frame**, or the turn produces no output and no error.

Frames the client sends after a turn resolves — a pong, the stop frame on abort — are
still in flight when the awaited call returns. Use `connection.waitForFrame`, not a
direct read of `frames`.

For an end-to-end check through real opencode without touching Microsoft, run the proxy
against the stub and point the plugin at it with the `baseUrl` option.

## Things that will bite you

- **Disengaged is not rate limiting.** Empty content, no error. Retrying makes it worse
  and burns the 600-per-conversation quota. `DisengagedError` exists so this is never
  confused with a throttle.
- **An empty reply returning in under a second with `throttle: null` is a dead agent**,
  not throttling. Real throttling reports the quota at its limit.
- **Never delete a declarative agent.** Another host on the tenant may be mid-conversation
  with it, and pulling it away produces exactly the instant-empty-reply symptom above.
- **The agent overrides the tone.** With an agent attached, a Claude or reasoning tone
  silently routes to GPT. Attach it only for tool turns.
- **Prompt shape, not size, trips the filter.** 500k tokens of benign input is fine; a
  shouty ALL-CAPS prompt with fake role turns is not. When editing any prompt in
  `fenced.ts` or `plugin.ts`, lean softer, not harder. There are tests asserting the
  absence of jailbreak shapes — they are there on purpose.
- **`small_model` must never reach M365.** The throttle counts conversations started;
  titling every session on the main model is the fastest route into it.

## Provenance

The protocol is implemented from the documentation in
[cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) (MIT) —
`docs/m365-copilot-api.md`, `docs/tool-calling.md`, `docs/prompt-engineering.md`. This is
an independent implementation, not a fork; no code was copied. When M365 behaviour is
unclear, those documents are the reference, and they record measurements we have not
repeated ourselves.
