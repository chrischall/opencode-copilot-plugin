/**
 * Authentication against the Office web Copilot client.
 *
 * This module is deliberately **silent-only**. It runs inside opencode's server
 * process, where launching a browser would be hostile — so when the cache cannot
 * produce a token it raises `AuthRequiredError` telling the user to run the CLI.
 * The interactive path lives in `login.ts`, which the CLI loads on demand.
 *
 * The client id below is Microsoft's own Office web Copilot application. We did not
 * register it, and no one can: the Sydney scopes are granted to no other client, so a
 * loopback redirect URI is rejected (`AADSTS50011`) and the device-code grant demands
 * a client secret only Microsoft holds (`AADSTS7000218`). The `nativeclient` redirect
 * is the only door, which is why `login.ts` has to drive a real browser.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import { CACHE_FILE } from "./paths.js";
import { createLogger } from "./log.js";

const log = createLogger("auth");

/** Microsoft's Office web Copilot client. Not ours, and not replaceable. */
export const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
export const AUTHORITY = "https://login.microsoftonline.com/common";
export const REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";

/** Scopes for the chat backend. The resulting token's audience is Sydney. */
export const SYDNEY_SCOPES = [
  "https://substrate.office.com/sydney/M365Chat.Read",
  "https://substrate.office.com/sydney/sydney.readwrite",
];

/** Copilot Studio agent management — acquired separately from the chat token. */
export const POWERPLATFORM_SCOPE = "https://api.powerplatform.com/.default";
/** Power Platform environment discovery. */
export const BAP_SCOPE = "https://api.bap.microsoft.com/.default";

/** Re-acquire this far ahead of expiry rather than racing the clock mid-turn. */
const EXPIRY_MARGIN_MS = 120_000;

/** No usable cached credential. The user has to sign in; we cannot do it for them. */
export class AuthRequiredError extends Error {
  readonly authRequired = true;
  constructor(reason: string) {
    super(`${reason}. Run \`opencode-m365 login\` to sign in.`);
    this.name = "AuthRequiredError";
  }
}

/**
 * Persist MSAL's token cache to disk.
 *
 * The cache is disposable: delete it and the next login rebuilds an equivalent one.
 * It still holds refresh tokens, so it is written owner-only.
 */
export function createCachePlugin(file: string = CACHE_FILE): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      try {
        context.tokenCache.deserialize(readFileSync(file, "utf8"));
      } catch {
        // First run, or a corrupted cache. Either way MSAL starts empty and the
        // user signs in again — nothing here is precious.
      }
    },
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (!context.cacheHasChanged) return;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, context.tokenCache.serialize(), { mode: 0o600 });
        chmodSync(file, 0o600);
      } catch (error) {
        log.warn("could not persist the token cache", String(error));
      }
    },
  };
}

/** The slice of MSAL's PublicClientApplication we depend on. */
export interface MsalLike {
  getTokenCache(): { getAllAccounts(): Promise<any[]> };
  acquireTokenSilent(request: { account: any; scopes: string[]; forceRefresh?: boolean }): Promise<any>;
}

export interface TokenClient {
  /** A Sydney chat token. */
  getToken(): Promise<string>;
  /** A token for some other resource — agent management, environment discovery. */
  getTokenForScope(scopes: string[]): Promise<string>;
  /** Forget cached tokens so the next call re-acquires. */
  invalidate(): void;
}

export interface TokenClientOptions {
  /** Inject an MSAL client. Defaults to a real one over the on-disk cache. */
  app?: MsalLike;
  cacheFile?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export function createTokenClient(options: TokenClientOptions = {}): TokenClient {
  let app: MsalLike | undefined = options.app;
  const cache = new Map<string, CachedToken>();

  async function client(): Promise<MsalLike> {
    if (app) return app;
    // Imported lazily so that merely loading the plugin does not pull MSAL in.
    const { PublicClientApplication } = await import("@azure/msal-node");
    app = new PublicClientApplication({
      auth: { clientId: CLIENT_ID, authority: AUTHORITY },
      cache: { cachePlugin: createCachePlugin(options.cacheFile) },
    }) as unknown as MsalLike;
    return app;
  }

  async function acquire(scopes: string[]): Promise<string> {
    const key = scopes.join(" ");
    const cached = cache.get(key);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached.token;

    const msal = await client();
    const accounts = await msal.getTokenCache().getAllAccounts();
    const account = accounts[0];
    if (!account) throw new AuthRequiredError("No signed-in Microsoft 365 account");

    let result: any;
    try {
      result = await msal.acquireTokenSilent({ account, scopes });
    } catch (error) {
      // Silent refresh fails when the refresh token has expired or been revoked, or
      // when the tenant now demands interaction (a new conditional-access policy).
      // All of them mean the same thing to us.
      log.warn("silent token acquisition failed", String(error));
      throw new AuthRequiredError("Could not refresh the Microsoft 365 token silently");
    }

    if (!result?.accessToken) throw new AuthRequiredError("Microsoft 365 returned no access token");

    cache.set(key, {
      token: result.accessToken,
      expiresAt: result.expiresOn ? new Date(result.expiresOn).getTime() : Date.now() + 300_000,
    });
    return result.accessToken;
  }

  return {
    getToken: () => acquire(SYDNEY_SCOPES),
    getTokenForScope: (scopes) => acquire(scopes),
    invalidate: () => cache.clear(),
  };
}

/**
 * Pull the authorization code out of a navigation URL.
 *
 * The `nativeclient` redirect is designed to be intercepted by an embedded native
 * host before the page loads. A real browser instead follows it one hop further and
 * lands on `/common/wrongplace`, so waiting for the redirect to *land* misses the
 * code entirely — it only ever exists on the in-flight navigation request.
 */
export function authCodeFromUrl(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!url.pathname.includes("/oauth2/nativeclient")) return undefined;

  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    throw new Error(`Sign-in failed: ${error}${description ? ` — ${description}` : ""}`);
  }

  return url.searchParams.get("code") ?? undefined;
}
