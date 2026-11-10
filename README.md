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

`setup` writes only a plugin reference. The provider, the model list and the default
model are all registered by the plugin at startup.

Needs **opencode 2** — from 2.0.0 the major version tracks it. On opencode 1, stay on
0.4.x — see [opencode 1](#opencode-1).

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

The proxy sees the final request, so it is the one place the trim reliably lands.

What gets dropped:

- **Tools** — keeps the shell tool under whatever name the harness gives it (`shell`
  in opencode 2, `bash` before), `read`, `grep`, and the editing tools (`edit`/`write`,
  or `apply_patch`). On opencode 2.2.5 that is five of thirteen; `execute`, `glob`,
  `skill`, `subagent`, `webfetch`, `websearch` and `question` are dropped.
- **Capability catalogues** — `<available_skills>` is removed when no `skill` tool
  survives the trim, because it advertises capabilities nothing can invoke. `<env>` and
  other structured context are kept.
- **Text about dropped tools** — opencode 2's "Code Mode" section says the listed tools
  only work inside `execute`, which the trim removes, so the model was being told its
  tools were unusable. That section, any line naming `execute`, and the skills
  paragraph go with their tools, as do two harness lines that contradict the
  contract ("prefer parallelizing tool calls", "prefer dedicated tools over shell
  commands"). On opencode 2.2.5 this takes the system prompt from about 8,000
  characters to about 2,000.
- **The harness's prose system prompt** — replaced with a short one, but **off by
  default**. A long, polished assistant prompt measurably reduces M365's tool
  compliance on another harness's numbers; that is a borrowed result we have not
  reproduced, so it is opt-in via `{ "leanSystemPrompt": true }`. Your own rules are
  never dropped either way: opencode injects `AGENTS.md` and global rules as prose
  inside the system message, and those sections are preserved verbatim.

The shell tool is never dropped. M365's chat-tuned model will not "act as an agent" on request,
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

Four things keep a turn on track:

- **A tolerant parser.** M365 writes calls loosely: the command as a `command:` header,
  `filePath:` for `path`, quoted values, a copied `$ ` prompt, prose or an invented
  `<tool_response>` after the block. These are read as the call the model meant.
- **One nudge after a give-up.** Chat tones sometimes answer a tool turn with "no tool
  is available" without trying. The proxy then asks once more, softly, in the same
  conversation (one extra message, no new conversation), worded differently once
  tools have already run.
- **A pinned backend.** Every turn's connection carries
  `X-RoutingParameter-SessionKey`, which the reference project found stops long
  sessions running on a forked copy of the conversation.
- **Telling the model what ran.** Only the first tool block in a reply runs. When a
  reply holds more, or goes on to predict its own result, the next turn starts with
  one line saying so, so the model does not assume the rest ran. opencode's tool
  errors arrive as plain text (`Error: …`) rather than a JSON envelope. In the 237
  `quick` turns measured so far, no reply needed the note.

Measured on one tenant on 2026-11-09 (`m365/quick`, opencode 2.2.5, 36 conversations,
alternating builds), with and without the prompt trimming, nudge and routing header.
Both builds had the tolerant parser:

| Task | Without | With |
|---|---|---|
| Fix a bug, then rerun its test | 6/6, 5.3 turns | 6/6, 5.0 turns |
| Find a value across six files | 6/6, 2.7 turns | 6/6, 2.0 turns |
| Edit one config value, leave the rest | 6/6, 3.5 turns | 6/6, 4.5 turns (re-read the file to check, 3 of 6) |

Every run made its tool call on the first turn, so the nudge never fired. No turn
disengaged, and none ran on a forked conversation (`turnCount` rose by one each turn).

Long sessions (2026-11-10, `m365/quick`, with all three): 4/4 solved, no nudges, no
forks.

| Task | Runs | Turns |
|---|---|---|
| Rename a function across ten modules, one edit at a time, then run the test | 2/2 | 37, 25 |
| Fix a 1,500-line file whose test fails, then fails again on a second bug | 2/2 | 8, 8 |

`turnCount` rose by one on every turn of the 37-turn session. Repeated calls were
progress checks (grep for what was left, re-reading a file after editing it), not loops.
These runs had the routing header, so they show it causes no harm. They don't show it
is needed, because no run without it was tried.

## opencode 2

This is an opencode 2 plugin (`@opencode/cli`, `@opencode/plugin`): its default export
is `{ id, setup }`. A local checkout is referenced by its **directory** — opencode 2
drops a file path with `configured plugin path must be a directory`, and since it
swallows plugin load failures, nothing else tells you. `opencode-m365 setup` writes the
right reference for you.

Everything in [Where the trimming happens](#where-the-trimming-happens-and-why) still
lives in the proxy. opencode 2 does offer hooks where opencode 1's were dead
(`ctx.tool.transform`, `session.hook("context")`); neither has been measured against a
live tenant, so the proxy stays the enforcement point.

### opencode 1

opencode 1 is no longer supported. **0.4.x is the last release that loads there** — pin
it with `npm install -g opencode-m365-copilot@0.4`. 2.0.0 and later under opencode 1
fail to load with `must default export an object with server()`. Re-running
`opencode-m365 setup` removes this plugin's entry from opencode 1's `plugin` key, keeping
any options you set on it, and leaves other plugins' entries alone.

### Verified how far

Against a real opencode 2.2.5, end to end, with the proxy running against the offline
stub rather than Microsoft: the plugin loads from a directory, registers all 21 models,
an attached image is uploaded and attached to the turn, and the session title is
answered locally — one chat turn reaches the backend, not two. The catalog records are
also checked against the real `@opencode/plugin` schema constructors in the test suite.
That stub run says nothing about Microsoft's side; see [Development](#development) for what has been run live.

## Configuration

```jsonc
{
  "plugins": [{
    "package": "opencode-m365-copilot",
    "options": {
      "lean": true,              // trim the toolset (default: true)
      "leanSystemPrompt": false, // replace opencode's prose prompt (default: false)
      "setDefaultModel": true,   // set `model` if you have not (default: true)
      "setSmallModel": true,     // answer session titles locally (default: true)
      "baseUrl": null,           // use an already-running proxy instead of an in-process one
      "apiKey": null             // that proxy's secret (or export M365_PROXY_KEY instead)
    }
  }]
}
```

The in-process proxy needs no key configured: it mints a random secret each launch and
hands it to opencode itself. Only a standalone `opencode-m365 serve` proxy needs one —
`serve` prints its key, or takes a fixed one from `M365_PROXY_KEY`. Either put that key
in `apiKey`, or export the same `M365_PROXY_KEY` to opencode and leave `apiKey` out.

### Errors and the turn log

When M365 refuses a turn, the proxy reports it so that opencode does not retry it.
Retrying a throttle only extends it, and a refusal like a missing licence never changes.
opencode streams, so the refusal usually arrives inside a stream that already answered
200. opencode then decides from the error body alone: it retries an error whose code
contains "unavailable", whose message says "try again" (M365's own refusals do), or
which mentions a rate limit. The proxy therefore sends type `invalid_request_error`,
avoids those words, and uses HTTP 422 when nothing has been streamed yet. In 2.2.0 a
licence refusal was retried ten times. The error `code` says which refusal it was:

| Code | Meaning |
|---|---|
| `m365_throttled` | The account is throttled. Wait for a lull. |
| `m365_not_served` | M365 answered with its own refusal: no credits, a model this licence does not cover, or a dead tone. Called `m365_unavailable` up to 2.2.0 |
| `m365_turn_rejected` | The server refused the request outright, typically a retired tone |
| `m365_disengaged` | M365's filter refused to engage with the prompt. A disengaged conversation stays that way, so the proxy drops it: the next request opens a fresh conversation and replays the whole history |

Set `M365_TURN_LOG=/path/to/turns.jsonl` before starting opencode to record one line
per M365 turn: the raw reply, the tool calls parsed from it, and M365's diagnostics
(`contentOrigin`, `turnCount`, throttle and classifier scores). The file is
owner-only, and off by default because a reply can quote anything from the workspace.

### Why session titles are answered locally

opencode titles every new session with a model call on your main model, which on M365
would open a **second conversation** per session. The account-level throttle counts
conversations started, not messages, so that is the fastest way to get throttled.

opencode 2 has no `small_model` setting, and its title hook exposes the model read-only,
so the plugin marks the title request on a header (`x-m365-request-kind: title`) and the
proxy answers it locally, without opening a connection. Compaction and generation stay
on the real model — they are real work, and only titling opens the extra conversation.
`setSmallModel` turns this off; the name dates from opencode 1, where it set
`small_model`. Any OpenAI client can also select `m365/local-title` by id.

## Models

Models are selected by an M365 *tone*, not a model id. `m365/quick` is the default.

Tool-calling on a live tenant (2026-11-09, one non-Premium account, a single file-read
task per run; small samples):

| Model | Made the tool call |
|---|---|
| `m365/quick` | 5/5 |
| `m365/m365-copilot` | 1/1 |
| `m365/gpt-5.5` (same tone as `quick`) | 0/1 |
| `m365/gpt-5.6` | 0/1 (the reference project: 7/30), so its picker name says "unreliable tool calls" |
| `m365/gpt-5.5-think-deeper` | 0/3 — said it had no file tool; 4/4 with the relay framing, below |

The reference project's README reports 100% tool compliance for `gpt-5.5-think-deeper`;
its protocol notes (`m365-copilot-api.md`, quirk #13) say reasoning tones disengage with
an agent attached. Our runs agree with the notes. Reasoning tones still serve plain chat.

The reasoning tones now get a different framing on tool turns. The tool block is
worded as the user asking to be guided through their own terminal, one command at a
time, pasting back the real output (the reference project's `relay`). A model that
doubts it can reach the workspace has nothing to doubt, because the user runs the
commands. Measured on `gpt-5.5-think-deeper` on 2026-11-10, 16 conversations:

| Framing | First reply said the tools were unavailable | Solved |
|---|---|---|
| Default, before the give-up nudge | 4/4 | 1/4 |
| Default, with the nudge | 8/8 | 5/8 |
| Relay, with the nudge | 0/4 | 4/4, with no nudge needed |

Claude tones stay on the agent, which M365 answers on GPT. The reference project ran
Claude without the agent and with `relay`, but an account with no Claude licence then
refuses every tool turn, and that could not be measured on a licensed account here.

A non-default tone (Claude, the reasoning tones) only takes effect when **no** agent is
attached — with one, M365 silently routes to GPT regardless. The proxy therefore attaches
the agent only on turns that carry tools, so plain chat reaches the model the tone selects.

### Reading your Microsoft 365 work

Two models ground the turn on your **own Microsoft 365 account**. Copilot's `WorkSearch`
runs server-side over the Microsoft Search index, so these span your whole work substrate,
not just mail:

| Model | Use |
|---|---|
| `m365/work` | Ask about your work — "what needs my attention first", "summarise the thread with X", "what did Jim message me on Teams", "find my recent sprint docs" |
| `m365/work-think` | The same, on a reasoning tone |

What `WorkSearch` reaches (all verified against a live tenant, except where noted):

| Source | Grounded? |
|---|---|
| Outlook **mail** and **calendar** | ✅ |
| **Teams** chats and channel messages | ✅ |
| **OneDrive** and **SharePoint** files | ✅ |
| **People** (colleagues, senders, managers) | ✅ |
| Third-party **Graph connectors** (Jira, ServiceNow, …) | ✅ *if your admin configured them* |

Select one in opencode (the model picker, or pin a `work` sub-agent to it) when you want
this context; they are listed as `Work · …`. Every other model is listed as `Code · …`,
stays coding/web-only and never reaches your account. A
grounded turn switches the request to the Outlook side-pane scenario, sends that surface's
feature variants, and attaches the built-in agent with the `WorkSearch` capability — the
combination that actually grounds on the signed-in account — then strips Copilot's inline
citation markers from the reply. Bias toward one source by saying so ("in Teams, …", "in my
OneDrive, …").

These models are for **reading and synthesis** — ask-your-work Q&A. A grounded turn carries
**no tools**: the proxy drops opencode's toolset for these models, so the fenced tool
instructions are never attached and no tool-call parsing runs on the reply — Copilot brings
its own built-in agent instead. Keep a coding model selected for coding, and switch to
`m365/work` to ask about your mail, Teams or files. Read-only: Copilot searches and
summarises, it does not send a message or edit a file.

## Authentication

Sign-in is a CLI concern, never the plugin's: the plugin only refreshes silently and asks
you to run `opencode-m365 login` if it cannot. A plugin running underneath a TUI has no
business opening a browser.

Two ways to sign in:

- **Automated (headless)** — put `{ "email", "password", "mfaSecret" }` in
  `~/.config/opencode-copilot/secrets.json`. `mfaSecret` is the **base32 seed** your
  authenticator derives codes from (`JBSWY3DPEHPK3PXP`), not a 6-digit code. Most password
  managers will show it; an `otpauth://` URI is accepted and the seed extracted.
  That file holds **both** sign-in factors — anyone who can read it can pass MFA as you —
  so keep it `chmod 600` (the CLI tightens a looser file itself and warns), keep it off
  backups and synced folders, and prefer interactive sign-in if you can. It is only read
  by `opencode-m365 login`; you can delete it once you have signed in.
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
                                      # (send its key as `Authorization: Bearer`)
opencode-m365 doctor [--live]         # check auth, agent, proxy and opencode wiring
                                      # (--live sends one short message per model tone)
```

## Images

Paste an image into opencode (or attach one with `opencode run -f shot.png`) and the
model sees it. opencode sends it to the proxy as an `image_url` data URL; the proxy
uploads it to M365 the way the Copilot web client does — `POST /m365Copilot/UploadFile`
into the same conversation — and the turn points at the upload with an `ImageFile`
annotation. Only images new to a turn are uploaded: M365 already holds the earlier ones.

- If an upload fails, the turn still runs and the model is told the image did not
  arrive, so it says so instead of describing a picture it never saw.
- Data URLs only. A remote `https://` image URL is not fetched.
- The local titler model stays text-only; it never reaches M365.
- The M365 side is implemented from cramt/m365-copilot-proxy's measurement (one model,
  agent attached and not); like the rest of this README's M365 claims, it has not been
  run against a live tenant from here.

## Limits

- **600 user messages per conversation.** The proxy reuses one conversation per task,
  sends only new messages, and reports the remaining budget in
  `usage.x_m365_conversation_remaining`. A task is the opencode session on opencode 2,
  or the system prompt plus the first user message otherwise; turns within one task run
  one at a time.
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
npm ci
npm test           # typechecks, then runs the suite; no network and no credentials required
npm run build
```

Tests run against a stub SignalR server (`test/stub-copilot.ts`) that speaks the real
framing, so a full turn — including the mandatory `Metrics` frame, ping handling,
Disengaged detection and the stop-on-abort frame — is exercised offline.

Chat, tool calling and agent provisioning have been run against one live tenant, through
opencode 2.2.5. Image upload has not, and file edits, shell commands and multi-step tasks
have not been exercised there. Other M365 behaviour is implemented from the protocol notes in
[cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) (MIT), whose
`docs/` are the source of truth for this surface. Run `opencode-m365 doctor --live`
against your own tenant before trusting it.

## Credit

The protocol this implements was reverse-engineered by
[cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy). This is an
independent implementation written against that project's documentation, not a fork of
its code.

## Licence

MIT. This speaks to Microsoft's API with your own credentials on your own account —
whether that is acceptable is between you and your tenant's acceptable-use policy.
