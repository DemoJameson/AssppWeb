import { Router, Request, Response } from "express";
import https from "https";
import bplistParser from "bplist-parser";
import plist from "plist";
import { BAG_TIMEOUT_MS, BAG_MAX_BYTES } from "../config.js";
import { STORE_USER_AGENT } from "../services/appleUserAgents.js";

const router = Router();

// Proxy for Apple's bag endpoint: public data (service URLs, no credentials),
// proxied server-side because init.itunes.apple.com requires TLS 1.3, which
// node-forge (browser-side TLS) does not support.
router.get("/bag", async (req: Request, res: Response) => {
  const guid = req.query.guid as string | undefined;
  if (!guid) {
    res.status(400).json({ error: "Missing guid parameter" });
    return;
  }

  // Validate guid format (should be hex string)
  if (!/^[a-fA-F0-9]+$/.test(guid)) {
    res.status(400).json({ error: "Invalid guid format" });
    return;
  }

  // `ix=6` is the current bag generation ipatool 2.8.0 asks for; it keeps the
  // native auth endpoint and SAP keys in the reply.
  const url = `https://init.itunes.apple.com/bag.xml?ix=6&guid=${encodeURIComponent(guid)}`;

  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            "User-Agent": STORE_USER_AGENT,
            Accept: "application/xml",
          },
          timeout: BAG_TIMEOUT_MS,
        },
        (resp) => {
          let data = "";
          let totalBytes = 0;

          resp.on("data", (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > BAG_MAX_BYTES) {
              request.destroy();
              reject(new Error("Bag response too large"));
              return;
            }
            data += chunk;
          });
          resp.on("end", () => {
            if (resp.statusCode && resp.statusCode >= 400) {
              reject(
                new Error(`Bag upstream returned HTTP ${resp.statusCode}`),
              );
              return;
            }
            resolve(data);
          });
          resp.on("error", reject);
        },
      );
      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy();
        reject(new Error("Bag request timed out"));
      });
    });

    // Extract plist from XML wrapper
    const plistMatch = body.match(/<plist[\s\S]*<\/plist>/);
    if (!plistMatch) {
      res.status(502).json({ error: "No plist found in bag response" });
      return;
    }

    // Older/default bags wrap the real dictionary in {bag = <data>}. Unwrap it
    // here so the browser sees the same flat XML whichever generation Apple
    // serves; the inner value may be XML or a binary plist.
    res.type("text/xml").send(unwrapSignedBag(plistMatch[0]));
  } catch (err) {
    console.error("Bag proxy error:", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "Bag request failed" });
  }
});

function unwrapSignedBag(xml: string): string {
  try {
    const outer = plist.parse(xml) as Record<string, unknown>;
    const bytes = plistBytes(outer.bag);
    if (!bytes) return xml;

    if (bytes.subarray(0, 8).toString("utf8") === "bplist00") {
      const parsed = bplistParser.parseBuffer(bytes);
      const inner = Array.isArray(parsed) ? parsed[0] : parsed;
      if (inner && typeof inner === "object") {
        return plist.build(inner as Parameters<typeof plist.build>[0]);
      }
    }

    const text = bytes.toString("utf8");
    if (text.includes("<plist")) {
      const inner = plist.parse(text);
      if (inner && typeof inner === "object") {
        return plist.build(inner as Parameters<typeof plist.build>[0]);
      }
    }
  } catch {
    // An ordinary (already flat) bag, or a shape we do not understand, stays
    // untouched.
  }

  return xml;
}

function plistBytes(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string" && value.trim() !== "") {
    return Buffer.from(value, "base64");
  }
  return null;
}

export default router;
