import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AuthRequiredError,
  BAP_SCOPE,
  POWERPLATFORM_SCOPE,
  SYDNEY_SCOPES,
  authCodeFromUrl,
  createCachePlugin,
  createTokenClient,
} from "./auth.js";

const tempFile = (name = "cache.json") => join(mkdtempSync(join(tmpdir(), "m365-auth-")), name);

/** A stand-in for MSAL's PublicClientApplication, with only what we call. */
function fakeApp(options: { accounts?: any[]; silent?: (req: any) => Promise<any> } = {}) {
  const accounts = options.accounts ?? [{ homeAccountId: "a", username: "you@example.com" }];
  const silent = options.silent ?? (async () => ({ accessToken: "token-abc", expiresOn: new Date(Date.now() + 3.6e6) }));
  return {
    getTokenCache: () => ({ getAllAccounts: async () => accounts }),
    acquireTokenSilent: vi.fn(silent),
  };
}

describe("scopes", () => {
  it("asks for the Sydney chat scopes", () => {
    expect(SYDNEY_SCOPES).toContain("https://substrate.office.com/sydney/M365Chat.Read");
    expect(SYDNEY_SCOPES).toContain("https://substrate.office.com/sydney/sydney.readwrite");
  });

  it("keeps agent-management scopes separate — they need their own acquisition", () => {
    expect(POWERPLATFORM_SCOPE).toBe("https://api.powerplatform.com/.default");
    expect(BAP_SCOPE).toBe("https://api.bap.microsoft.com/.default");
    expect(SYDNEY_SCOPES).not.toContain(POWERPLATFORM_SCOPE);
  });
});

describe("token cache persistence", () => {
  it("loads an existing cache into MSAL", async () => {
    const file = tempFile();
    writeFileSync(file, '{"Account":{}}');
    const plugin = createCachePlugin(file);

    const deserialize = vi.fn();
    await plugin.beforeCacheAccess({ tokenCache: { deserialize, serialize: () => "" } } as any);
    expect(deserialize).toHaveBeenCalledWith('{"Account":{}}');
  });

  it("tolerates a missing cache file on first run", async () => {
    const plugin = createCachePlugin(tempFile("does-not-exist.json"));
    const deserialize = vi.fn();
    await expect(
      plugin.beforeCacheAccess({ tokenCache: { deserialize, serialize: () => "" } } as any),
    ).resolves.toBeUndefined();
    expect(deserialize).not.toHaveBeenCalled();
  });

  it("writes the cache back only when MSAL says it changed", async () => {
    const file = tempFile();
    const plugin = createCachePlugin(file);
    const context = { cacheHasChanged: false, tokenCache: { serialize: () => "{}", deserialize: () => {} } };

    await plugin.afterCacheAccess(context as any);
    expect(() => readFileSync(file)).toThrow();

    await plugin.afterCacheAccess({ ...context, cacheHasChanged: true } as any);
    expect(readFileSync(file, "utf8")).toBe("{}");
  });

  it("writes the cache with owner-only permissions", async () => {
    const file = tempFile();
    const plugin = createCachePlugin(file);
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => "{}", deserialize: () => {} },
    } as any);
    const { statSync } = await import("node:fs");
    expect(statSync(file).mode & 0o077).toBe(0);
  });
});

describe("acquiring a token", () => {
  it("returns the access token from a silent refresh", async () => {
    const client = createTokenClient({ app: fakeApp() as any });
    expect(await client.getToken()).toBe("token-abc");
  });

  it("refreshes silently against the Sydney scopes", async () => {
    const app = fakeApp();
    await createTokenClient({ app: app as any }).getToken();
    expect(app.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ scopes: SYDNEY_SCOPES }));
  });

  it("acquires other scopes separately", async () => {
    const app = fakeApp();
    await createTokenClient({ app: app as any }).getTokenForScope([POWERPLATFORM_SCOPE]);
    expect(app.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ scopes: [POWERPLATFORM_SCOPE] }));
  });

  it("asks for a sign-in when the cache holds no account", async () => {
    // The plugin runs inside opencode's TUI, so it must never launch a browser
    // itself — it reports what the user needs to run.
    const client = createTokenClient({ app: fakeApp({ accounts: [] }) as any });
    await expect(client.getToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("asks for a sign-in when the refresh token has expired", async () => {
    const app = fakeApp({
      silent: async () => {
        throw new Error("AADSTS700082: The refresh token has expired");
      },
    });
    await expect(createTokenClient({ app: app as any }).getToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("tells the user which command fixes it", async () => {
    const client = createTokenClient({ app: fakeApp({ accounts: [] }) as any });
    await expect(client.getToken()).rejects.toThrow(/opencode-m365 login/);
  });

  it("caches a live token instead of hitting MSAL on every turn", async () => {
    const app = fakeApp();
    const client = createTokenClient({ app: app as any });
    await client.getToken();
    await client.getToken();
    expect(app.acquireTokenSilent).toHaveBeenCalledTimes(1);
  });

  it("re-acquires once the cached token is close to expiring", async () => {
    const app = fakeApp({
      silent: async () => ({ accessToken: "soon", expiresOn: new Date(Date.now() + 30_000) }),
    });
    const client = createTokenClient({ app: app as any });
    await client.getToken();
    await client.getToken();
    expect(app.acquireTokenSilent).toHaveBeenCalledTimes(2);
  });
});

describe("auth code extraction", () => {
  // The nativeclient redirect is meant to be intercepted by an embedded host. A real
  // browser follows it one hop further to /common/wrongplace, so the ?code= URL only
  // ever exists as a navigation request — never as a page that lands.
  it("pulls the code out of a nativeclient navigation url", () => {
    const url = "https://login.microsoftonline.com/common/oauth2/nativeclient?code=ABC123&session_state=x";
    expect(authCodeFromUrl(url)).toBe("ABC123");
  });

  it("ignores unrelated navigations", () => {
    expect(authCodeFromUrl("https://login.microsoftonline.com/common/login")).toBeUndefined();
  });

  it("ignores the wrongplace bounce the browser actually lands on", () => {
    expect(authCodeFromUrl("https://login.microsoftonline.com/common/wrongplace")).toBeUndefined();
  });

  it("surfaces an error redirect instead of silently returning nothing", () => {
    const url = "https://login.microsoftonline.com/common/oauth2/nativeclient?error=access_denied&error_description=no";
    expect(() => authCodeFromUrl(url)).toThrow(/access_denied/);
  });

  it("does not choke on a malformed url", () => {
    expect(authCodeFromUrl("not a url")).toBeUndefined();
  });
});
