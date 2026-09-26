import { createHmac, timingSafeEqual } from "crypto";
import { accessPasswordHash } from "../config.js";

/**
 * Short-lived signed links for the package file route. A browser-native
 * download is a plain GET navigation, which cannot attach the access-token
 * header, so those links carry an `exp` + `sig` pair instead — issued by
 * `GET /packages/:id/file-url` (itself behind the normal middleware) and
 * scoped to a single task and account hash. Without an instance password the
 * file route is open anyway, so no ticket is issued.
 */
const TICKET_TTL_MS = 5 * 60 * 1000;

/**
 * Install links are handed to a *device* rather than used on the spot: the URL
 * is shown as a QR code and scanned from another machine, sometimes minutes
 * after the page was opened. Its window is therefore wider than the file
 * link's, while still being bounded — the password gate's point is that a
 * leaked link stops working.
 */
const INSTALL_TICKET_TTL_MS = 30 * 60 * 1000;

export function createDownloadTicket(
  taskId: string,
  accountHash: string,
): { exp: string; sig: string } | null {
  if (!accessPasswordHash) return null;
  const exp = String(Date.now() + TICKET_TTL_MS);
  return { exp, sig: signDownload(taskId, accountHash, exp) };
}

export function verifyDownloadTicket(
  taskId: string,
  accountHash: string,
  exp: string,
  sig: string,
): boolean {
  if (!accessPasswordHash) return false;
  return verify(exp, sig, signDownload(taskId, accountHash, exp));
}

/**
 * Issues the pair the install routes accept: `manifest.plist`, `payload.ipa`
 * and the two icon sizes, which iOS fetches itself and therefore cannot
 * authenticate with the access token. Minted by `GET /install/:id/url`, which
 * *is* behind the token.
 */
export function createInstallTicket(
  taskId: string,
): { exp: string; sig: string } | null {
  if (!accessPasswordHash) return null;
  const exp = String(Date.now() + INSTALL_TICKET_TTL_MS);
  return { exp, sig: signInstall(taskId, exp) };
}

export function verifyInstallTicket(
  taskId: string,
  exp: string,
  sig: string,
): boolean {
  if (!accessPasswordHash) return false;
  return verify(exp, sig, signInstall(taskId, exp));
}

function verify(exp: string, sig: string, expected: string): boolean {
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;

  const expectedBytes = Buffer.from(expected, "utf8");
  const actual = Buffer.from(sig, "utf8");
  return (
    expectedBytes.length === actual.length &&
    timingSafeEqual(expectedBytes, actual)
  );
}

function signDownload(
  taskId: string,
  accountHash: string,
  exp: string,
): string {
  return sign(`download:${taskId}:${accountHash}`, exp);
}

function signInstall(taskId: string, exp: string): string {
  return sign(`install:${taskId}`, exp);
}

function sign(scope: string, exp: string): string {
  return createHmac("sha256", accessPasswordHash)
    .update(`${scope}:${exp}`)
    .digest("hex");
}
