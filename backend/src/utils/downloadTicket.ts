import { createHmac, timingSafeEqual } from "crypto";
import { accessPasswordHash } from "../config.js";

/**
 * `exp`+`sig` links for the package file route: a plain GET download cannot
 * carry the access-token header, so `GET /packages/:id/file-url` (itself behind
 * the normal middleware) scopes a short-lived pair to the task and account hash.
 * Without an instance password the file route is open anyway, so no ticket.
 */
const TICKET_TTL_MS = 5 * 60 * 1000;

/**
 * Install links are scanned from another device, sometimes minutes after the
 * page was opened, so this window is wider than the file link's — but still
 * bounded, since the password gate's point is that a leaked link stops working.
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
 * Issues the pair the install routes accept — `manifest.plist`, `payload.ipa`
 * and the two icon sizes, which iOS fetches itself and cannot authenticate —
 * minted by `GET /install/:id/url`, which *is* behind the token.
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
