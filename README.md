# opencode-m365-copilot

[![ci](https://github.com/chrischall/opencode-copilot-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/opencode-copilot-plugin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-m365-copilot)](https://www.npmjs.com/package/opencode-m365-copilot)
[![node](https://img.shields.io/node/v/opencode-m365-copilot)](https://www.npmjs.com/package/opencode-m365-copilot)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Use your organisation's **Microsoft 365 Copilot** as the model backend for
[opencode](https://opencode.ai).

M365 Copilot has no developer API. It is an undocumented SignalR-over-WebSocket service
(`substrate.office.com`) that Microsoft intends only its own clients to speak to. This
package implements that protocol, wraps it in an OpenAI-compatible proxy, and ships an
opencode plugin that starts the proxy in-process and registers it as a provider.

```
opencode ──OpenAI /v1──▶ in-process proxy ──SignalR/WS──▶ M365 Copilot
                              │
                              └── local-title model, answered without any M365 call
```

## Install

```sh
npm install -g opencode-m365-copilot
opencode-m365 login      # one-time browser sign-in
opencode-m365 setup      # adds the plugin to ~/.config/opencode/opencode.json
opencode                 # models appear as m365/*
```

`setup` writes only a plugin reference. The provider, the model list, the default model
and the small model are all registered by the plugin at startup.

## The thing you need to know first

**M365 refuses to work with a full coding-agent toolset.** Its "Disengaged" filter
returns an empty reply — indistinguishable from rate limiting unless you look for
`messageType: "Disengaged"` — and the reference reverse-engineering notes measure the
threshold at roughly 12 tools, naming opencode specifically as the harness that
disengages *persistently*.

So this plugin's main job is not wiring. It is **cutting opencode down to something M365
will engage with**. Measured against opencode 1.18.18 on a single agentic turn:

| | stock | with this plugin |
|---|---|---|
| tools offered | 9 | 4 |
| prompt sent to M365 | 53,676 chars | 9,701 chars |
| `<available_skills>` catalogue | 34,263 chars | removed |

The trimming is on by default. Turn it off with `{ "lean": false }` and expect empty
replies.

## Where the trimming happens, and why

Not in opencode's config — **in the proxy**. Two opencode levers look like they should
work and do not (verified against 1.18.18, and the reason the architecture is what it is):

- **`config.tools`** is resolved into the config — `opencode debug config` shows it
  correctly — but the request still offers every tool. A config disabling eight tools
  produced a request offering all nine.
- **`experimental.chat.system.transform`** fires, and accepts a replacement `system`
  array, but the request that reaches the provider still carries the original prompt.
  Setting `agent.<name>.prompt` from the `config` hook is ignored the same way.

The proxy sees the final request, so it is the one place the trim reliably lands. The
plugin still sets `config.tools` as a declaration of intent, in case a future version
honours it.

What gets dropped:

- **Tools** — keeps `bash`, `read`, `grep`, and whichever editing tool is present
  (`apply_patch` in 1.18.18, `edit`/`write` in others). Drops `glob`, `skill`, `task`,
  `todowrite`, `webfetch`, `websearch`, `lsp`, `question`.
- **Capability catalogues** — `<available_skills>` is removed when no `skill` tool
  survives the trim, because it advertises capabilities nothing can invoke. `<env>` and
  other structured context are kept.
- **The harness's prose system prompt** — replaced with a short one, but **off by
  default**. A long, polished assistant prompt measurably reduces M365's tool
  compliance on another harness's numbers; that is a borrowed result we have not
  reproduced, so it is opt-in via `{ "leanSystemPrompt": true }`. Your own rules are
  never dropped either way: opencode injects `AGENTS.md` and global rules as prose
  inside the system message, and those sections are preserved verbatim.

`bash` is never dropped. M365's chat-tuned model will not "act as an agent" on request,
but it *will* reflexively write a ```` ```bash ```` block — routing that block to the
shell tool is the single lever that makes tool calling work at all.

## How tool calling works

M365 has no native `tool_calls`. Tools go out as a fenced contract and come back as
fenced blocks:

````
```read
filePath: /etc/hostname
```
````

Scalar arguments are `key: value` header lines, one free-form argument is the fence body,
and an old/new pair is written as a SEARCH/REPLACE diff. A JSON `{"tool": …}` contract
was tried in the reference project and scored 0/5 on real agentic tasks.

The other half is a **Copilot Studio declarative agent**, provisioned automatically on
the first turn that carries tools. Microsoft's server-side prompt outranks anything we
send, so per-request instructions get answered in prose; instructions delivered through
an agent land in the server-side system prompt and are obeyed. The agent is named after
a hash of its instructions, so hosts on a tenant converge on one, and it is never
deleted — another host may be mid-conversation with it.

Without Copilot Studio access the plugin still works, just less reliably; it logs a
warning and carries on.

## Configuration

```jsonc
{
  "plugin": [["opencode-m365-copilot", {
    "lean": true,              // trim the toolset (default: true)
    "leanSystemPrompt": false, // replace opencode's prose prompt (default: false)
    "setDefaultModel": true,   // set `model` if you have not (default: true)
    "setSmallModel": true,     // route title generation to the local titler (default: true)
    "baseUrl": null            // use an already-running proxy instead of an in-process one
  }]]
}
```

### Why `small_model` is redirected

opencode's `small_model` defaults to your main model, so every new session would generate
its title on M365 — opening a **second conversation**. The account-level throttle counts
conversations started, not messages, so that is the fastest way to get throttled. The
`m365/local-title` model is answered by the proxy itself and never opens a connection.

## Models

Models are selected by an M365 *tone*, not a model id. `m365/gpt-5.5-think-deeper` is the
default.

> **A conflict worth knowing about.** The reference project's README recommends
> `gpt-5.5-think-deeper` and reports 100% tool compliance with the agent plus
> fenced/shell-routing. Its own protocol notes (`m365-copilot-api.md`, quirk #13) say the
> opposite — that reasoning tones meta-analyse the injected prompt and disengage, and
> only `magic`/`*_Quick` work with an agent attached. The README is the newer
> measurement, so it is the default here; if you see disengagement on tool turns, try
> `m365/quick` or `m365/m365-copilot`.

A non-default tone (Claude, the reasoning tones) only takes effect when **no** agent is
attached — with one, M365 silently routes to GPT regardless. The proxy therefore attaches
the agent only on turns that carry tools, so plain chat reaches the model the tone selects.

## Authentication

Sign-in is a CLI concern, never the plugin's: the plugin only refreshes silently and asks
you to run `opencode-m365 login` if it cannot. A plugin running underneath a TUI has no
business opening a browser.

Two ways to sign in:

- **Automated (headless)** — put `{ "email", "password", "mfaSecret" }` in
  `~/.config/opencode-copilot/secrets.json`. `mfaSecret` is the **base32 seed** your
  authenticator derives codes from (`JBSWY3DPEHPK3PXP`), not a 6-digit code. Most password
  managers will show it; an `otpauth://` URI is accepted and the seed extracted.
- **Interactive** — `opencode-m365 login --interactive` opens a window and you complete
  SSO/MFA by hand once. Required for tenants with push-only MFA, FIDO2, or a federated IdP
  (Okta/Ping/Duo), where no seed exists to extract.

Either way it is one-time; afterwards tokens refresh from the MSAL cache.

The client id is Microsoft's own Office web Copilot application. That is not a shortcut —
the Sydney scopes are granted to no other client, so a loopback redirect is rejected
(`AADSTS50011`) and the device-code grant demands a client secret only Microsoft holds
(`AADSTS7000218`). Driving a browser is the only door.

State lives in `~/.config/opencode-copilot/` — deliberately not `~/.config/opencode-m365/`,
which belongs to the m365-copilot-proxy project.

## CLI

```sh
opencode-m365 login [--interactive]   # sign in
opencode-m365 setup [--local]         # register the plugin with opencode
opencode-m365 serve [--port 4141]     # run the proxy standalone, for any OpenAI client
opencode-m365 doctor                  # check auth, agent, proxy and opencode wiring
```

## Limits

- **600 user messages per conversation.** The proxy reuses one conversation per task and
  sends only new messages, and reports the remaining budget in
  `usage.x_m365_conversation_remaining`.
- **Account-level throttling** exists and is keyed to your identity, so re-authenticating
  does not clear it. It self-heals after a lull.
- **Streaming** works for tool-less turns. A tool turn is buffered, because a fenced call
  cannot be parsed until the fence closes.
- **Tool calling is emulated**, not native, and one call per turn is kept by default —
  M365 batches its whole plan into one response, and later steps run on guessed state.
- `usage` reports zero tokens. M365 never exposes token counts; the `x_m365_*` extension
  fields carry what it does report, including `x_m365_dea_score`, the classifier score
  that rises before the Disengaged filter fires.

## Development

```sh
pnpm install
pnpm test          # 237 tests, no network and no credentials required
pnpm typecheck
pnpm build
```

Tests run against a stub SignalR server (`test/stub-copilot.ts`) that speaks the real
framing, so a full turn — including the mandatory `Metrics` frame, ping handling,
Disengaged detection and the stop-on-abort frame — is exercised offline.

**No live M365 traffic has been run against this implementation.** Everything above about
opencode's behaviour is measured; everything about M365's behaviour is implemented from
the protocol notes in
[cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) (MIT), whose
`docs/` are the source of truth for this surface. Run `opencode-m365 doctor` against your
own tenant before trusting it.

## Credit

The protocol this implements was reverse-engineered by
[cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy). This is an
independent implementation written against that project's documentation, not a fork of
its code.

## Licence

MIT. This speaks to Microsoft's API with your own credentials on your own account —
whether that is acceptable is between you and your tenant's acceptable-use policy.
