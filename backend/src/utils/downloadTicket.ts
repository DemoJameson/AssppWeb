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

export function createDownloadTicket(
  taskId: string,
  accountHash: string,
): { exp: string; sig: string } | null {
  if (!accessPasswordHash) return null;
  const exp = String(Date.now() + TICKET_TTL_MS);
  return { exp, sig: sign(taskId, accountHash, exp) };
}

export function verifyDownloadTicket(
  taskId: string,
  accountHash: string,
  exp: string,
  sig: string,
): boolean {
  if (!accessPasswordHash) return false;

  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;

  const expected = Buffer.from(sign(taskId, accountHash, exp), "utf8");
  const actual = Buffer.from(sig, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sign(taskId: string, accountHash: string, exp: string): string {
  return createHmac("sha256", accessPasswordHash)
    .update(`${taskId}:${accountHash}:${exp}`)
    .digest("hex");
}
