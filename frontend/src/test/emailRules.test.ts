import { describe, it, expect } from "vitest";
import { getEmailError, getEmailCharacterError } from "@/utils/emailRules";
import { validateEmail } from "@/utils/validation";

// Same cases as backend/test/email-rules.test.js — the two rule modules must agree.
const OK = [
  "maria@example.com",
  "maria.santos+enroll@example.co.ph",
  "first_last-1@sub.domain.com",
  "o'brien@example.com",
  '"john doe"@example.com',
  '"a(b)c[d]e<f>g;h:i,j"@example.com',
  '"back\\\\slash"@example.com',
  "  padded@example.com  ",
];

const BAD: [string, RegExp][] = [
  ["john doe@example.com", /spaces/i],
  ["ma(ria@example.com", /"\("/],
  ["ma)ria@example.com", /"\)"/],
  ["ma[ria@example.com", /"\["/],
  ["ma]ria@example.com", /"\]"/],
  ["ma<ria@example.com", /"<"/],
  ["ma>ria@example.com", /">"/],
  ["ma;ria@example.com", /semicolon/i],
  ["ma:ria@example.com", /colon/i],
  ["ma,ria@example.com", /comma/i],
  ["ma\\ria@example.com", /backslash/i],
  ['ma"ria@example.com', /double quote/i],
  ['"maria@example.com', /double quote/i],
  ['"unescaped"quote"@example.com', /escaped/i],
  ["a@b@example.com", /one @/i],
  [".maria@example.com", /period/i],
  ["maria.@example.com", /period/i],
  ["ma..ria@example.com", /period/i],
  ["maria@", /domain/i],
  ["maria@example", /domain/i],
  ["maria@-example.com", /domain/i],
  ["maria@exa mple.com", /domain/i],
  ["maria@example.c", /domain/i],
  ["@example.com", /before the @/i],
  ["mariaexample.com", /@/],
  ["", /required/i],
  ["   ", /required/i],
];

describe("email rules", () => {
  it("accepts valid emails", () => {
    for (const e of OK) expect(getEmailError(e), e).toBeNull();
  });

  it("rejects each restricted character / shape with a specific message", () => {
    for (const [email, pattern] of BAD) {
      const err = getEmailError(email);
      expect(err, email).not.toBeNull();
      expect(err, email).toMatch(pattern);
    }
  });

  it("restricted symbols are allowed only when the whole local part is double-quoted", () => {
    for (const ch of [" ", "(", ")", "[", "]", "<", ">", ";", ":", ","]) {
      expect(getEmailError(`"a${ch}b"@example.com`), `quoted ${JSON.stringify(ch)}`).toBeNull();
      expect(getEmailError(`a${ch}b@example.com`), `unquoted ${JSON.stringify(ch)}`).not.toBeNull();
    }
  });

  it("getEmailCharacterError gives immediate feedback while typing (no domain nagging)", () => {
    expect(getEmailCharacterError("ma")).toBeNull();
    expect(getEmailCharacterError("maria@")).toBeNull();
    expect(getEmailCharacterError("ma(r")).toMatch(/"\("/);
    expect(getEmailCharacterError('"ma (r)"@example.com')).toBeNull();
  });

  it("the shared validateEmail helper uses the same rules", () => {
    expect(validateEmail("maria@example.com")).toBe(true);
    expect(validateEmail("ma(ria@example.com")).toBe(false);
  });
});
