/**
 * Interactive / automated sign-in. Loaded only by the CLI, never by the plugin.
 *
 * Why a browser at all: the Sydney scopes are granted exclusively to Microsoft's own
 * Office web Copilot client, so we cannot register a loopback redirect
 * (`AADSTS50011`) and the device-code grant is refused for that client
 * (`AADSTS7000218` — it wants a client secret only Microsoft has). The `nativeclient`
 * redirect is the only remaining door, and driving it needs a real browser.
 *
 * Two modes:
 *   - automated: stored credentials plus a TOTP seed, headless. Needs the seed
 *     itself, not a code from a phone.
 *   - interactive: a visible window where you complete SSO/MFA by hand. The only
 *     option for push-only MFA, FIDO2, or a federated IdP (Okta/Ping/Duo).
 *
 * Either way it is a one-time cost — afterwards `auth.ts` refreshes silently.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AUTHORITY, CLIENT_ID, REDIRECT_URI, SYDNEY_SCOPES, authCodeFromUrl, createCachePlugin } from "./auth.js";
import { CONFIG_DIR, SECRETS_FILE } from "./paths.js";
import { createLogger } from "./log.js";

const log = createLogger("login");

const SecretsSchema = z.object({
  email: z.string().min(3),
  password: z.string().min(1),
  /**
   * The base32 TOTP seed — what your authenticator derives its 6-digit codes from,
   * not a code. Optional: without it, only interactive sign-in is possible.
   */
  mfaSecret: z.string().optional(),
});

export type Secrets = z.infer<typeof SecretsSchema>;

/** Read stored credentials, if any. Returns undefined when the file is absent. */
export function loadSecrets(file: string = SECRETS_FILE): Secrets | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${String(error)}`);
  }
  const result = SecretsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${file} is missing required fields: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  return result.data;
}

/**
 * Validate a TOTP seed before we try to use it.
 *
 * A common failure is pasting the whole `otpauth://` URI, or a 6-digit code, instead
 * of the seed. Both fail deep inside the login with an unhelpful message.
 */
export function normaliseTotpSecret(raw: string): string {
  let secret = raw.trim();
  if (secret.startsWith("otpauth://")) {
    const fromUri = new URL(secret).searchParams.get("secret");
    if (!fromUri) throw new Error("That otpauth:// URI has no `secret` parameter");
    secret = fromUri;
  }
  secret = secret.replace(/\s+/g, "").toUpperCase();
  if (/^\d{6}$/.test(secret)) {
    throw new Error("That looks like a 6-digit code, not the base32 seed it is generated from");
  }
  if (!/^[A-Z2-7]+=*$/.test(secret) || secret.length < 16) {
    throw new Error("mfaSecret must be a base32 seed (A-Z and 2-7, 16+ characters)");
  }
  return secret;
}

/** Current 6-digit code for a base32 seed. */
export async function totpCode(secret: string): Promise<string> {
  const { TOTP, Secret } = await import("otpauth");
  return new TOTP({ secret: Secret.fromBase32(normaliseTotpSecret(secret)), digits: 6, period: 30 }).generate();
}

export interface LoginOptions {
  /** Show the browser and let the user drive. Required for non-TOTP tenants. */
  interactive?: boolean;
  secretsFile?: string;
  cacheFile?: string;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
}

/**
 * Sign in and populate the MSAL cache.
 *
 * Returns the account username on success. Everything afterwards is silent refresh.
 */
export async function login(options: LoginOptions = {}): Promise<string> {
  const status = options.onStatus ?? (() => {});
  const secrets = loadSecrets(options.secretsFile);
  const interactive = options.interactive ?? !secrets?.mfaSecret;

  if (!interactive && !secrets) {
    throw new Error(
      `No credentials at ${options.secretsFile ?? SECRETS_FILE}. Create it with { "email", "password", "mfaSecret" }, or sign in interactively with --interactive.`,
    );
  }

  const { PublicClientApplication, CryptoProvider } = await import("@azure/msal-node");
  const app = new PublicClientApplication({
    auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    cache: { cachePlugin: createCachePlugin(options.cacheFile) },
  });

  // PKCE: the verifier stays here, only its hash goes to the authorize endpoint.
  const { verifier, challenge } = await new CryptoProvider().generatePkceCodes();
  const authUrl = await app.getAuthCodeUrl({
    scopes: SYDNEY_SCOPES,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    prompt: interactive ? "select_account" : undefined,
  });

  status(interactive ? "Opening a browser window — complete sign-in there." : "Signing in…");
  const code = await captureAuthCode(authUrl, { ...options, interactive, secrets });

  const result = await app.acquireTokenByCode({
    code,
    scopes: SYDNEY_SCOPES,
    redirectUri: REDIRECT_URI,
    codeVerifier: verifier,
  });

  return result?.account?.username ?? "signed in";
}

/** Drive a browser to the authorize endpoint and pull the code off the redirect. */
async function captureAuthCode(
  authUrl: string,
  options: LoginOptions & { interactive: boolean; secrets?: Secrets },
): Promise<string> {
  const playwright = await importPlaywright();
  const timeout = options.timeoutMs ?? (options.interactive ? 600_000 : 120_000);

  mkdirSync(CONFIG_DIR, { recursive: true });
  // A persistent profile keeps AAD's device cookies, so repeat logins are quiet and
  // look like a familiar device rather than a fresh unknown one every time.
  const profileDir = process.env.M365_BROWSER_PROFILE || join(CONFIG_DIR, "browser-profile");

  const context = await playwright.chromium.launchPersistentContext(profileDir, {
    headless: !options.interactive,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    locale: process.env.M365_LOGIN_LOCALE || "en-GB",
    timezoneId: process.env.M365_LOGIN_TIMEZONE || undefined,
    ...(process.env.M365_LOGIN_UA ? { userAgent: process.env.M365_LOGIN_UA } : {}),
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for sign-in to complete")), timeout);
      // The code lives on the navigation REQUEST. Waiting for the page to land
      // misses it — a real browser bounces straight on to /common/wrongplace.
      page.on("request", (request: { url(): string }) => {
        try {
          const found = authCodeFromUrl(request.url());
          if (found) {
            clearTimeout(timer);
            resolve(found);
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });

    await page.goto(authUrl, { waitUntil: "domcontentloaded" }).catch(() => {
      /* navigation may be interrupted by the redirect we are racing for */
    });

    if (!options.interactive && options.secrets) {
      await fillCredentials(page, options.secrets, options.onStatus ?? (() => {}));
    }

    return await code;
  } finally {
    await context.close().catch(() => {});
  }
}

/** Walk the converged AAD form: email, password, then the TOTP code. */
async function fillCredentials(page: any, secrets: Secrets, status: (message: string) => void): Promise<void> {
  status("Entering credentials…");
  await fillVerified(page, 'input[name="loginfmt"]', secrets.email);
  await page.click("#idSIButton9").catch(() => page.keyboard.press("Enter"));

  await page.waitForSelector('input[name="passwd"]', { timeout: 30_000 });
  await fillVerified(page, 'input[name="passwd"]', secrets.password);
  await page.click("#idSIButton9").catch(() => page.keyboard.press("Enter"));

  if (!secrets.mfaSecret) return;

  const otc = await page.waitForSelector('input[name="otc"]', { timeout: 30_000 }).catch(() => null);
  if (!otc) return;

  status("Entering the MFA code…");
  await fillVerified(page, 'input[name="otc"]', await totpCode(secrets.mfaSecret));
  await page.click("#idSubmit_SAOTCC_Continue").catch(() => page.keyboard.press("Enter"));
}

/**
 * Fill a field and check the value actually landed.
 *
 * The converged login page keeps hidden duplicate `<input type=password>` nodes, and
 * a naive fill can target a stale hidden one and submit an empty password — which
 * AAD reports as bad credentials.
 */
async function fillVerified(page: any, selector: string, value: string): Promise<void> {
  const field = page.locator(`${selector}:visible`).first();
  await field.waitFor({ state: "visible", timeout: 30_000 });
  await field.fill(value);
  const landed = await field.inputValue();
  if (landed !== value) {
    log.warn(`value did not land in ${selector}, retrying`);
    await field.fill("");
    await field.type(value, { delay: 20 });
    if ((await field.inputValue()) !== value) throw new Error(`Could not fill ${selector} on the sign-in page`);
  }
}

async function importPlaywright(): Promise<any> {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed. It ships as an optional dependency — run `npm i playwright && npx playwright install chromium`, or set CHROMIUM_PATH to an existing browser.",
    );
  }
}
