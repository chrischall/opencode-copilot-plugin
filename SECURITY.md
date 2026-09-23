# Security

## What this software handles

Your Microsoft 365 credentials and the access tokens derived from them. Specifically:

- `~/.config/opencode-copilot/msal-cache.json` — the MSAL token cache, including refresh
  tokens. Written owner-only (`0600`).
- `~/.config/opencode-copilot/secrets.json` — optional stored credentials and TOTP seed,
  if you choose the headless sign-in path. That is both factors in one plaintext file:
  reading it is enough to pass MFA as you. A copy readable by other users is tightened
  to `0600` (with a warning) before it is used, and refused if it cannot be.
- `~/.config/opencode-copilot/browser-profile/` — a persistent browser profile holding
  Entra device/SSO cookies.
- `~/.config/opencode-copilot/debug.log` — written only under `M365_DEBUG`/`M365_TRACE`.

The directory and the browser profile are created (and, if they already exist,
tightened to) owner-only `0700`; every file written in it is `0600`.

The local proxy binds to loopback only, and loopback alone is not a boundary — every
web page open in your browser can reach `127.0.0.1` too. So the proxy also:

- requires `Authorization: Bearer <key>` on every request but `/health`. The in-process
  proxy generates a fresh 32-byte random key per launch and hands it only to opencode;
  `opencode-m365 serve` prints its key, or uses `M365_PROXY_KEY`;
- refuses any request carrying a browser `Origin`, refuses every CORS preflight, and
  sends no CORS headers;
- refuses a `Host` that is not a loopback name on its own port (DNS rebinding);
- caps request bodies at 32 MB.

Treat the `serve` key like a password: anything holding it can spend your Copilot
quota. Do not run `opencode-m365 serve` on a shared host.

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
