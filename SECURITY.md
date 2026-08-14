# Security

## What this software handles

Your Microsoft 365 credentials and the access tokens derived from them. Specifically:

- `~/.config/opencode-copilot/msal-cache.json` — the MSAL token cache, including refresh
  tokens. Written owner-only (`0600`).
- `~/.config/opencode-copilot/secrets.json` — optional stored credentials and TOTP seed,
  if you choose the headless sign-in path.
- `~/.config/opencode-copilot/browser-profile/` — a persistent browser profile holding
  Entra device/SSO cookies.

The local proxy binds to `127.0.0.1` only and is **unauthenticated**. Anything able to
reach that port can spend your Copilot quota. Do not expose it, and do not run
`opencode-m365 serve` on a shared host.

## Before sharing a log

`M365_DEBUG=1` truncates payloads. `M365_TRACE=1` does not — it writes every WebSocket
frame, and the access token travels in the connection URL. Scrub `access_token` before
attaching a trace log or a frame dump to an issue.

## Reporting a vulnerability

Open a [security advisory](https://github.com/chrischall/opencode-copilot-plugin/security/advisories/new)
rather than a public issue.

## Scope note

This client speaks to Microsoft's undocumented first-party API using your own credentials
on your own account. Whether that is permitted is a matter for your tenant's
acceptable-use policy, not a security property of this software.
