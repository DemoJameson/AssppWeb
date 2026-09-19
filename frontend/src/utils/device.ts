import type { Platform } from "../types";

/**
 * What the browser can plausibly be installing for, inferred from its user
 * agent. iPhone and iPad share one family (an iPadOS package installs on
 * either); a Mac's eligibility additionally depends on its CPU — see
 * `installDecision` — and everything else is "desktop": none of our web
 * install flow runs there.
 */
export type InstallDeviceFamily =
  | "iphone"
  | "ipad"
  | "visionos"
  | "mac"
  | "desktop";

export interface InstallDevice {
  family: InstallDeviceFamily;
  /** Shown verbatim in messages — brand names, or the "browser" placeholder. */
  name: "iPhone" | "iPad" | "Vision Pro" | "Mac" | "browser";
}

/** The raw signals the classifier reads; separable so tests can pin them. */
export interface DeviceSignals {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** WebXR presence — visionOS Safari has it; macOS and iPadOS Safari do not. */
  hasXR: boolean;
  /** Touch events support — visionOS and iPadOS have it; macOS does not. */
  hasTouchEvents: boolean;
}

export function readDeviceSignals(): DeviceSignals {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    hasXR: "xr" in navigator,
    hasTouchEvents: document.ontouchstart !== undefined,
  };
}

/**
 * Classify a browser. Order matters: visionOS Safari reports a Macintosh UA,
 * and iPadOS in desktop mode looks like a Macintosh *and* a touch device —
 * both must be caught before the plain-Mac branch.
 */
export function classifyInstallDevice(signals: DeviceSignals): InstallDevice {
  const { userAgent, platform, maxTouchPoints } = signals;
  const macLike = /\(Macintosh;/.test(userAgent) || platform === "MacIntel";
  // visionOS: Macintosh UA + WebXR + touch. macOS Safari has no WebXR,
  // iPadOS has none either, and macOS browsers with WebXR have no touch.
  const visionOS = macLike && signals.hasXR && signals.hasTouchEvents;

  if (/iPhone|iPod/.test(userAgent)) return { family: "iphone", name: "iPhone" };
  if (/iPad/.test(userAgent)) return { family: "ipad", name: "iPad" };
  if (visionOS) return { family: "visionos", name: "Vision Pro" };
  if (macLike && maxTouchPoints > 1) return { family: "ipad", name: "iPad" };
  if (macLike) return { family: "mac", name: "Mac" };
  return { family: "desktop", name: "browser" };
}

export function detectInstallDevice(): InstallDevice {
  return classifyInstallDevice(readDeviceSignals());
}

interface NavigatorWithUAData {
  userAgentData?: {
    getHighEntropyValues?: (
      hints: string[],
    ) => Promise<{ architecture?: string }>;
  };
}

/**
 * Best-effort probe for an Apple-silicon Mac. Chromium exposes the CPU through
 * UA client hints; Safari has no such API, so the WebGL renderer stands in
 * ("Apple GPU" / "Apple M…" vs Intel/AMD renderers). Anything short of a
 * positive signal counts as "not confirmed" and the caller falls back to the
 * download route — the machines let through are exactly the ones the probe
 * can recognise.
 */
export async function isAppleSiliconMac(): Promise<boolean> {
  try {
    const uaData = (navigator as NavigatorWithUAData).userAgentData;
    if (uaData?.getHighEntropyValues) {
      const values = await uaData.getHighEntropyValues(["architecture"]);
      return values?.architecture === "arm";
    }
  } catch {
    // No client hints (Safari) — fall through to the renderer probe.
  }

  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return typeof renderer === "string" && /Apple (GPU|M\d)/i.test(renderer);
  } catch {
    return false;
  }
}

export type InstallHint = "visionPro" | "iosDevice" | "download";

export type InstallDecision =
  | { kind: "install" }
  | { kind: "blocked"; hint: InstallHint };

/**
 * Whether this browser may hand the package to its OS. iPhone/iPad take
 * iOS/iPadOS packages; a Vision Pro takes visionOS; an Apple-silicon Mac takes
 * iOS/iPadOS (those Macs can install them, and only when the silicon probe
 * confirms — otherwise the download route is the honest answer). A tvOS
 * package has no browser anywhere (Apple TV carries none), and any other
 * mismatch gets a next-step hint instead of a hop into a broken install.
 */
export function installDecision(
  device: InstallDevice,
  platform: Platform,
  appleSilicon: boolean,
): InstallDecision {
  if (platform === "tvos") return { kind: "blocked", hint: "download" };

  switch (device.family) {
    case "iphone":
    case "ipad":
      if (platform === "ios" || platform === "ipad") return { kind: "install" };
      if (platform === "visionos") {
        return { kind: "blocked", hint: "visionPro" };
      }
      return { kind: "blocked", hint: "download" };
    case "visionos":
      if (platform === "visionos") return { kind: "install" };
      if (platform === "ios" || platform === "ipad") {
        return { kind: "blocked", hint: "iosDevice" };
      }
      return { kind: "blocked", hint: "download" };
    case "mac":
      if ((platform === "ios" || platform === "ipad") && appleSilicon) {
        return { kind: "install" };
      }
      if (platform === "visionos") {
        return { kind: "blocked", hint: "visionPro" };
      }
      return { kind: "blocked", hint: "download" };
    default:
      if (platform === "visionos") {
        return { kind: "blocked", hint: "visionPro" };
      }
      return { kind: "blocked", hint: "download" };
  }
}
