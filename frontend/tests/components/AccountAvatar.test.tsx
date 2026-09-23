import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountAvatar } from "../../src/components/Account/AccountAvatar";
import type { Account } from "../../src/types";

const account: Account = {
  email: "myemailaddress@example.com",
  password: "test-password",
  appleId: "myemailaddress@example.com",
  store: "143441",
  firstName: "Ava",
  lastName: "Example",
  passwordToken: "test-token",
  directoryServicesIdentifier: "123456789",
  cookies: [],
  deviceIdentifier: "001122aabbcc",
};

class FakeImage {
  static instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private source = "";

  set src(value: string) {
    this.source = value;
    FakeImage.instances.push(this);
  }

  get src(): string {
    return this.source;
  }
}

describe("AccountAvatar", () => {
  beforeEach(() => {
    FakeImage.instances = [];
    vi.stubGlobal("Image", FakeImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probes the gravatar and swaps in the image once it loads", () => {
    const { container } = render(<AccountAvatar account={account} />);

    // The initial-letter fallback shows first — nothing waits on the network.
    expect(screen.getByText("A")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();

    const probe = FakeImage.instances[0];
    expect(probe.src).toBe(
      "https://www.gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?s=96&d=404",
    );

    act(() => probe.onload?.());

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain(
      "0bc83cb571cd1c50ba6f3e8a78ef1346",
    );
    expect(screen.queryByText("A")).toBeNull();
  });

  it("keeps the initial letter when the address has no avatar", () => {
    const { container } = render(<AccountAvatar account={account} />);

    act(() => FakeImage.instances[0].onerror?.());

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("A")).toBeTruthy();
  });

  it("never hashes a phone-number Apple ID for gravatar", () => {
    const { container } = render(
      <AccountAvatar
        account={{
          ...account,
          email: "13800138000",
          appleId: "13800138000",
          firstName: "",
          lastName: "",
        }}
      />,
    );

    expect(FakeImage.instances).toHaveLength(0);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("1")).toBeTruthy();
  });
});
