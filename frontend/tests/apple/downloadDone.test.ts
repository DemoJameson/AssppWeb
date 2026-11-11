import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { reportDownloadDone } from "../../src/apple/downloadDone";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import type { Account } from "../../src/types";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
}));

const account: Account = {
  email: "test@example.com",
  password: "secret",
  appleId: "test@example.com",
  store: "143441",
  storeFront: "143441-1,29",
  firstName: "Test",
  lastName: "User",
  passwordToken: "token",
  directoryServicesIdentifier: "1234567890",
  cookies: [{ name: "session", value: "cookie", domain: ".apple.com", path: "/" }],
  deviceIdentifier: "aabbccddeeff",
  pod: "25",
};

describe("apple/downloadDone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://auth.example",
      songDownloadDoneEndpoint:
        "https://buy.itunes.apple.com/WebObjects/MZFastFinance.woa/wa/songDownloadDone",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({ jingleDocType: "success" }),
    });
  });

  it("reports a completed download with the account pod and device GUID", async () => {
    await expect(reportDownloadDone(account, 6503940939, "download-1")).resolves.toBe(
      true,
    );

    const request = vi.mocked(appleRequest).mock.calls[0][0];
    expect(request.host).toBe("p25-buy.itunes.apple.com");
    expect(request.path).toContain("songId=6503940939");
    expect(request.path).toContain("download-id=download-1");
    expect(request.path).toContain("Pod=25");
    expect(request.path).toContain("guid=aabbccddeeff");
    expect(request.headers?.["X-Token"]).toBeUndefined();
    expect(request.headers?.["X-Dsid"]).toBe("1234567890");
    expect(request.cookies).toEqual(account.cookies);
  });

  it("does nothing when the bag advertises no completion endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({ authURL: "https://auth.example" });

    await expect(reportDownloadDone(account, 6503940939)).resolves.toBe(false);
    expect(appleRequest).not.toHaveBeenCalled();
  });
});
