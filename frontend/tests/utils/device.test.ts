import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyInstallDevice,
  installDecision,
  isAppleSiliconMac,
  type DeviceSignals,
  type InstallDevice,
} from "../../src/utils/device";

const signals = (overrides: Partial<DeviceSignals> = {}): DeviceSignals => ({
  userAgent: "",
  platform: "",
  maxTouchPoints: 0,
  hasXR: false,
  hasTouchEvents: false,
  ...overrides,
});

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

describe("classifyInstallDevice", () => {
  it("sees an iPhone from its user agent", () => {
    expect(
      classifyInstallDevice(
        signals({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 }),
      ),
    ).toEqual({ family: "iphone", name: "iPhone" });
  });

  it("sees an iPad — native and in desktop mode", () => {
    expect(
      classifyInstallDevice(signals({ userAgent: IPAD_UA, platform: "iPad" })),
    ).toEqual({ family: "ipad", name: "iPad" });
    // iPadOS 13+ desktop mode: a Macintosh UA and touch, but no WebXR.
    expect(
      classifyInstallDevice(
        signals({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 5 }),
      ),
    ).toEqual({ family: "ipad", name: "iPad" });
  });

  it("sees visionOS through Macintosh + WebXR + touch", () => {
    expect(
      classifyInstallDevice(
        signals({
          userAgent: MAC_UA,
          platform: "MacIntel",
          maxTouchPoints: 5,
          hasXR: true,
          hasTouchEvents: true,
        }),
      ),
    ).toEqual({ family: "visionos", name: "Vision Pro" });
  });

  it("does not mistake macOS for visionOS or an iPad", () => {
    expect(
      classifyInstallDevice(signals({ userAgent: MAC_UA, platform: "MacIntel" })),
    ).toEqual({ family: "mac", name: "Mac" });
    // macOS Chrome has WebXR but no touch events.
    expect(
      classifyInstallDevice(
        signals({ userAgent: MAC_UA, platform: "MacIntel", hasXR: true }),
      ),
    ).toEqual({ family: "mac", name: "Mac" });
  });

  it("treats anything else as a plain browser", () => {
    expect(
      classifyInstallDevice(signals({ userAgent: WINDOWS_UA, platform: "Win32" })),
    ).toEqual({ family: "desktop", name: "browser" });
  });
});

describe("installDecision", () => {
  const device = (family: InstallDevice["family"]): InstallDevice => ({
    family,
    name:
      family === "iphone"
        ? "iPhone"
        : family === "ipad"
          ? "iPad"
          : family === "visionos"
            ? "Vision Pro"
            : family === "mac"
              ? "Mac"
              : "browser",
  });

  it("lets iPhone and iPad take iOS and iPadOS packages", () => {
    for (const family of ["iphone", "ipad"] as const) {
      expect(installDecision(device(family), "ios", false)).toEqual({
        kind: "install",
      });
      expect(installDecision(device(family), "ipad", false)).toEqual({
        kind: "install",
      });
    }
  });

  it("sends mismatched packages to their next step", () => {
    expect(installDecision(device("iphone"), "visionos", false)).toEqual({
      kind: "blocked",
      hint: "visionPro",
    });
    expect(installDecision(device("iphone"), "macos", false)).toEqual({
      kind: "blocked",
      hint: "download",
    });
    expect(installDecision(device("visionos"), "ios", false)).toEqual({
      kind: "blocked",
      hint: "iosDevice",
    });
    expect(installDecision(device("visionos"), "visionos", false)).toEqual({
      kind: "install",
    });
  });

  it("only takes an iOS package on a Mac when the silicon probe confirms", () => {
    expect(installDecision(device("mac"), "ios", true)).toEqual({
      kind: "install",
    });
    expect(installDecision(device("mac"), "ipad", true)).toEqual({
      kind: "install",
    });
    expect(installDecision(device("mac"), "ios", false)).toEqual({
      kind: "blocked",
      hint: "download",
    });
    expect(installDecision(device("mac"), "macos", true)).toEqual({
      kind: "blocked",
      hint: "download",
    });
  });

  it("offers the download route on plain desktops", () => {
    expect(installDecision(device("desktop"), "ios", false)).toEqual({
      kind: "blocked",
      hint: "download",
    });
    expect(installDecision(device("desktop"), "visionos", false)).toEqual({
      kind: "blocked",
      hint: "visionPro",
    });
  });

  it("never lets a tvOS package through", () => {
    for (const family of [
      "iphone",
      "ipad",
      "visionos",
      "mac",
      "desktop",
    ] as const) {
      expect(installDecision(device(family), "tvos", true)).toEqual({
        kind: "blocked",
        hint: "download",
      });
    }
  });
});

describe("isAppleSiliconMac", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "userAgentData");
    vi.restoreAllMocks();
  });

  it("trusts the UA client hints architecture when present", async () => {
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: {
        getHighEntropyValues: vi.fn(async () => ({ architecture: "arm" })),
      },
    });
    await expect(isAppleSiliconMac()).resolves.toBe(true);

    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: {
        getHighEntropyValues: vi.fn(async () => ({ architecture: "x86" })),
      },
    });
    await expect(isAppleSiliconMac()).resolves.toBe(false);
  });

  it("returns false when nothing can be confirmed", async () => {
    // No client hints and no WebGL renderer to read: not confirmed, so the
    // caller stays on the download route.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(isAppleSiliconMac()).resolves.toBe(false);
  });
});
