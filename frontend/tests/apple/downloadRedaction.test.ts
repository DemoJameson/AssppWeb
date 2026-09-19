import { describe, expect, it, vi } from "vitest";
import { redactAppleSecrets, bodySnippet } from "../../src/apple/downloadProduct";

// downloadProduct pulls in the libcurl graph through ./request; stub it so this
// pure-function test never initialises the wasm transport.
vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

describe("reply credential redaction", () => {
  it("redacts the passwordToken value in an Apple plist reply", () => {
    const body = `<?xml version="1.0"?>
<plist><dict>
  <key>failureType</key><string></string>
  <key>passwordToken</key><string>SECRET_TOKEN_BYTES</string>
  <key>name</key><string>SomeApp</string>
</dict></plist>`;

    const redacted = redactAppleSecrets(body);
    expect(redacted).toContain("passwordToken</key>");
    expect(redacted).not.toContain("SECRET_TOKEN_BYTES");
    expect(redacted).toContain("[redacted]");
  });

  it("keeps a snippet-free body intact when there is no token", () => {
    const body = `<plist><dict><key>failureType</key><string>x</string></dict></plist>`;
    expect(redactAppleSecrets(body)).toBe(body);
  });

  it("does not surface the token through bodySnippet", () => {
    const body = `<plist><dict><key>passwordToken</key><string>TOPSECRET</string>
      <key>customerMessage</key><string>Something went wrong</string></dict></plist>`;
    const snippet = bodySnippet(body, 200);
    expect(snippet).not.toContain("TOPSECRET");
    expect(snippet).toContain("Something went wrong");
  });
});