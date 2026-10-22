// Full-chain SAP machine test with the real Apple assets (no network):
// open images -> Initialize -> Sign (default), or StoreAgent kbsync
// (SAP_SMOKE=kbsync). Run each profile in its own process:
// npx tsx tests/sap/machine-live.mjs
// SAP_SMOKE=kbsync npx tsx tests/sap/machine-live.mjs
import { readFileSync } from "node:fs";
import { SapMachine } from "../../src/apple/sap/machine.ts";

// Asset layout: either SAP_ASSET_DIR pointing at a flat directory holding
// the five files, or the nested structure produced by the shell extraction.
import { existsSync } from "node:fs";
const FLAT = process.env.SAP_ASSET_DIR ?? "/tmp/sap-backend-test/sap-assets";
const NESTED = "/tmp/sap-extract/extracted/System/Library/PrivateFrameworks";
const DIR = existsSync(`${NESTED}/CoreFP.framework/Versions/A/CoreFP`)
  ? NESTED
  : null;
const assetPath = (flat, nested) => {
  if (!DIR) return `${FLAT}/${flat}`;
  return `${DIR}/${nested}`;
};
const flatCommerceKit = assetPath(
  "CommerceKit",
  "CommerceKit.framework/Versions/A/CommerceKit",
);
const flatCommerceCore = assetPath(
  "CommerceCore",
  "CommerceKit.framework/Versions/A/Frameworks/CommerceCore.framework/Versions/A/CommerceCore",
);
const flatCoreFP = assetPath(
  "CoreFP",
  "CoreFP.framework/Versions/A/CoreFP",
);
const flatICXS = assetPath(
  "CoreFP.icxs",
  "CoreFP.framework/Versions/A/CoreFP.icxs",
);
const flatStoreAgent = assetPath(
  "StoreAgent",
  "CommerceKit.framework/Versions/A/Resources/storeagent",
);
const assets = {
  coreFP: new Uint8Array(readFileSync(flatCoreFP)),
  coreFPICXS: new Uint8Array(readFileSync(flatICXS)),
  commerceKit: new Uint8Array(readFileSync(flatCommerceKit)),
  commerceCore: new Uint8Array(readFileSync(flatCommerceCore)),
  storeAgent: new Uint8Array(readFileSync(flatStoreAgent)),
};
console.log(
  "assets loaded:",
  Object.entries(assets).map(([k, v]) => `${k}=${v.length}`).join(" "),
);

const wasmBinary = readFileSync(new URL("../../src/apple/sap/vendor/unicorn.wasm", import.meta.url));

const hardwareID = Uint8Array.from(
  "0123456789ab".match(/../g),
  (byte) => Number.parseInt(byte, 16),
);

if (process.env.SAP_SMOKE === "kbsync") {
  const kbsyncStarted = Date.now();
  const kbsyncMachine = await SapMachine.open(assets, {
    wasmBinary,
    storeAgent: true,
  });
  console.log(`kbsync machine open OK (${Date.now() - kbsyncStarted}ms)`);
  const kbsync = kbsyncMachine.generateKBSync(hardwareID, 123456789012);
  if (kbsync.length === 0) {
    throw new Error("StoreAgent kbsync returned an empty buffer");
  }
  console.log(`kbsync OK: ${kbsync.length} bytes`);
  kbsyncMachine.close();
  console.log("FULL CHAIN OK");
} else {
  const signerStarted = Date.now();
  const signerMachine = await SapMachine.open(assets, { wasmBinary });
  console.log(`signer machine open OK (${Date.now() - signerStarted}ms)`);

  const t1 = Date.now();
  const context = signerMachine.initialize(hardwareID);
  console.log(`initialize OK (${Date.now() - t1}ms): context = 0x${context.toString(16)}`);

  const t2 = Date.now();
  const body = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>appleId</key><string>test@example.com</string></dict></plist>',
  );
  // Signing requires the Apple key exchange (GET certificate + POST setup).
  // Without it the guest reports -42085 on both the native ipatool runtime and
  // this port; that exact match is the assertion.
  let signStatus = "none";
  try {
    signerMachine.sign(context, body);
  } catch (e) {
    signStatus = e.message.match(/-?\d+/)?.[0] ?? e.message;
  }
  if (signStatus !== "-42085") {
    throw new Error(`expected sign status -42085, got: ${signStatus}`);
  }
  console.log(`sign gated on key exchange (${Date.now() - t2}ms): -42085 as native`);

  signerMachine.teardown(context);
  signerMachine.close();
  console.log("SIGNER CHAIN OK");
}
