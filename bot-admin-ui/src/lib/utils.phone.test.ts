import { describe, expect, it } from "vitest";
import { microsipUri, uzbekPhoneWithoutCountryCode } from "./utils";

describe("uzbekPhoneWithoutCountryCode", () => {
  it("drops the +998 country code from a canonical number", () => {
    expect(uzbekPhoneWithoutCountryCode("+998901112233")).toBe("901112233");
    expect(uzbekPhoneWithoutCountryCode("998901112233")).toBe("901112233");
    expect(uzbekPhoneWithoutCountryCode("901112233")).toBe("901112233");
  });

  it("strips spaces and punctuation from a formatted Uzbek number", () => {
    expect(uzbekPhoneWithoutCountryCode("+998 90 111-22-33")).toBe("901112233");
  });

  it("leaves a non-Uzbek number unchanged", () => {
    expect(uzbekPhoneWithoutCountryCode("+1 555 0100")).toBe("+1 555 0100");
    expect(uzbekPhoneWithoutCountryCode("12345")).toBe("12345");
  });
});

describe("microsipUri", () => {
  it("builds a sip link without the +998 country code", () => {
    expect(microsipUri("+998909999999")).toBe("sip:909999999");
    expect(microsipUri("998909999999")).toBe("sip:909999999");
    expect(microsipUri("+998 90 999-99-99")).toBe("sip:909999999");
  });
});
