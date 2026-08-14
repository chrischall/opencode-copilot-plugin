import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSecrets, normaliseTotpSecret, totpCode } from "./login.js";

const tempFile = (contents: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "m365-login-")), "secrets.json");
  writeFileSync(file, contents);
  return file;
};

describe("stored credentials", () => {
  it("returns undefined when there is no secrets file", () => {
    expect(loadSecrets(join(tmpdir(), "definitely-not-here.json"))).toBeUndefined();
  });

  it("reads email, password and the TOTP seed", () => {
    const file = tempFile(JSON.stringify({ email: "a@b.com", password: "pw", mfaSecret: "JBSWY3DPEHPK3PXP" }));
    expect(loadSecrets(file)).toEqual({ email: "a@b.com", password: "pw", mfaSecret: "JBSWY3DPEHPK3PXP" });
  });

  it("accepts a file with no TOTP seed — that tenant signs in interactively", () => {
    const file = tempFile(JSON.stringify({ email: "a@b.com", password: "pw" }));
    expect(loadSecrets(file)?.mfaSecret).toBeUndefined();
  });

  it("names the missing field rather than failing obscurely later", () => {
    const file = tempFile(JSON.stringify({ email: "a@b.com" }));
    expect(() => loadSecrets(file)).toThrow(/password/);
  });

  it("reports invalid JSON clearly", () => {
    expect(() => loadSecrets(tempFile("{not json"))).toThrow(/not valid JSON/);
  });
});

describe("TOTP seed handling", () => {
  it("accepts a bare base32 seed", () => {
    expect(normaliseTotpSecret("JBSWY3DPEHPK3PXP")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("extracts the seed from an otpauth:// URI", () => {
    const uri = "otpauth://totp/Contoso:you@contoso.com?secret=JBSWY3DPEHPK3PXP&issuer=Contoso";
    expect(normaliseTotpSecret(uri)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("strips the spaces that password managers display", () => {
    expect(normaliseTotpSecret("jbsw y3dp ehpk 3pxp")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("rejects a 6-digit code with an explanation", () => {
    // Easy mistake: the seed is what generates codes, not a code itself.
    expect(() => normaliseTotpSecret("123456")).toThrow(/6-digit code/);
  });

  it("rejects something that is not base32 at all", () => {
    expect(() => normaliseTotpSecret("this-is-not-base32!")).toThrow(/base32/);
  });

  it("generates a six digit code from a seed", async () => {
    expect(await totpCode("JBSWY3DPEHPK3PXP")).toMatch(/^\d{6}$/);
  });
});
