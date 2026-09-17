import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  inject,
  readPackageInfo,
} from "../src/services/sinfInjector.js";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import os from "os";
import plist from "plist";

const TEMP_DIR = path.join(os.tmpdir(), "sinf-injector-test");

beforeAll(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

// A valid 1x1 PNG. Each icon gets the file name appended after IEND so a test
// can tell which entry was actually read back.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12P4////DwAJBgMBMHREuwAAAABJRU5ErkJggg==",
  "base64",
);

function iconImage(name: string): Buffer {
  return Buffer.concat([TINY_PNG, Buffer.from(name)]);
}

function createMockIPA(
  bundleName: string,
  opts?: {
    addManifest?: boolean;
    sinfPaths?: string[];
    executableName?: string;
    /** Icon images placed at the top of the app bundle. */
    icons?: string[];
    /** Icons of a nested bundle, which are not this app's icon. */
    nestedIcons?: string[];
    /** Names to declare as `CFBundleIconFiles` in the Info.plist. */
    declaredIcons?: string[];
    /** `CFBundleIconName`, the asset-catalogue name. */
    iconName?: string;
    /**
     * Alternate icons, the ones a user can choose between. Real apps file whole
     * theme catalogues here, and none of them is the app's icon.
     */
    alternateIcons?: string[];
  },
): string {
  const zip = new AdmZip();
  const execName = opts?.executableName ?? bundleName;

  const infoPlistXml = plist.build({
    CFBundleExecutable: execName,
    CFBundleIdentifier: `com.example.${bundleName.toLowerCase()}`,
    CFBundleDisplayName: `${bundleName} Display`,
    CFBundleShortVersionString: "4.5.6",
    MinimumOSVersion: "16.0",
    ...(opts?.declaredIcons ? { CFBundleIconFiles: opts.declaredIcons } : {}),
    ...(opts?.iconName ? { CFBundleIconName: opts.iconName } : {}),
    ...(opts?.alternateIcons
      ? {
          CFBundleIcons: {
            CFBundleAlternateIcons: Object.fromEntries(
              opts.alternateIcons.map((name) => [
                name,
                { CFBundleIconFiles: [name] },
              ]),
            ),
            CFBundlePrimaryIcon: { CFBundleIconName: "appIconNew" },
          },
        }
      : {}),
  });
  zip.addFile(
    `Payload/${bundleName}.app/Info.plist`,
    Buffer.from(infoPlistXml),
  );
  zip.addFile(
    `Payload/${bundleName}.app/${execName}`,
    Buffer.from("fake executable"),
  );

  for (const icon of opts?.icons ?? []) {
    zip.addFile(`Payload/${bundleName}.app/${icon}`, iconImage(icon));
  }
  for (const icon of opts?.nestedIcons ?? []) {
    zip.addFile(
      `Payload/${bundleName}.app/PlugIns/Extension.appex/${icon}`,
      iconImage(icon),
    );
  }

  if (opts?.addManifest && opts?.sinfPaths) {
    const manifestPlistXml = plist.build({
      SinfPaths: opts.sinfPaths,
    });
    zip.addFile(
      `Payload/${bundleName}.app/SC_Info/Manifest.plist`,
      Buffer.from(manifestPlistXml),
    );
  }

  const ipaPath = path.join(TEMP_DIR, `${bundleName}_${Date.now()}.ipa`);
  zip.writeZip(ipaPath);
  return ipaPath;
}

describe("sinfInjector", () => {
  it("should inject sinf via Info.plist fallback (no manifest)", async () => {
    const ipaPath = createMockIPA("TestApp", { executableName: "TestApp" });
    const sinfData = Buffer.from("fake sinf data for testing").toString(
      "base64",
    );

    await inject([{ id: 1, sinf: sinfData }], ipaPath);

    const resultZip = new AdmZip(ipaPath);
    const sinfEntry = resultZip.getEntry(
      "Payload/TestApp.app/SC_Info/TestApp.sinf",
    );
    expect(sinfEntry).not.toBeNull();

    const sinfContent = resultZip.readFile(sinfEntry!);
    expect(sinfContent).not.toBeNull();
    expect(sinfContent!.toString()).toBe("fake sinf data for testing");
  });

  it("should read bundle name from .app directory", async () => {
    const ipaPath = createMockIPA("MyGreatApp");
    const sinfData = Buffer.from("sinf content").toString("base64");

    await inject([{ id: 1, sinf: sinfData }], ipaPath);

    const resultZip = new AdmZip(ipaPath);
    const sinfEntry = resultZip.getEntry(
      "Payload/MyGreatApp.app/SC_Info/MyGreatApp.sinf",
    );
    expect(sinfEntry).not.toBeNull();
  });

  it("should handle multiple sinfs with manifest", async () => {
    const ipaPath = createMockIPA("MultiSinf", {
      addManifest: true,
      sinfPaths: ["SC_Info/main.sinf", "SC_Info/extension.sinf"],
    });

    const sinf1 = Buffer.from("sinf data 1").toString("base64");
    const sinf2 = Buffer.from("sinf data 2").toString("base64");

    await inject(
      [
        { id: 1, sinf: sinf1 },
        { id: 2, sinf: sinf2 },
      ],
      ipaPath,
    );

    const resultZip = new AdmZip(ipaPath);

    const entry1 = resultZip.getEntry(
      "Payload/MultiSinf.app/SC_Info/main.sinf",
    );
    expect(entry1).not.toBeNull();
    expect(resultZip.readFile(entry1!)!.toString()).toBe("sinf data 1");

    const entry2 = resultZip.getEntry(
      "Payload/MultiSinf.app/SC_Info/extension.sinf",
    );
    expect(entry2).not.toBeNull();
    expect(resultZip.readFile(entry2!)!.toString()).toBe("sinf data 2");
  });

  it("should handle empty sinfs array with no-manifest fallback", async () => {
    const ipaPath = createMockIPA("EmptyTest");
    await inject([], ipaPath);

    const resultZip = new AdmZip(ipaPath);
    const entries = resultZip
      .getEntries()
      .filter((e) => e.entryName.endsWith(".sinf"));
    expect(entries.length).toBe(0);
  });

  it("should throw if IPA has no .app directory", async () => {
    const zip = new AdmZip();
    zip.addFile("SomeFile.txt", Buffer.from("not an IPA"));
    const ipaPath = path.join(TEMP_DIR, "invalid.ipa");
    zip.writeZip(ipaPath);

    const sinfData = Buffer.from("sinf").toString("base64");
    await expect(
      inject([{ id: 1, sinf: sinfData }], ipaPath),
    ).rejects.toThrow();
  });

  it("should use different executable name from CFBundleExecutable", async () => {
    const ipaPath = createMockIPA("AppBundle", {
      executableName: "CustomExec",
    });
    const sinfData = Buffer.from("sinf").toString("base64");

    await inject([{ id: 1, sinf: sinfData }], ipaPath);

    const resultZip = new AdmZip(ipaPath);
    // Should use CFBundleExecutable (CustomExec), not bundle name (AppBundle)
    const sinfEntry = resultZip.getEntry(
      "Payload/AppBundle.app/SC_Info/CustomExec.sinf",
    );
    expect(sinfEntry).not.toBeNull();
  });

  it("should prefer manifest over Info.plist when both exist", async () => {
    const ipaPath = createMockIPA("WithManifest", {
      addManifest: true,
      sinfPaths: ["SC_Info/custom.sinf"],
      executableName: "WithManifest",
    });

    const sinfData = Buffer.from("manifest sinf").toString("base64");
    await inject([{ id: 1, sinf: sinfData }], ipaPath);

    const resultZip = new AdmZip(ipaPath);
    // Should inject at manifest-specified path, not Info.plist path
    const manifestEntry = resultZip.getEntry(
      "Payload/WithManifest.app/SC_Info/custom.sinf",
    );
    expect(manifestEntry).not.toBeNull();
    expect(resultZip.readFile(manifestEntry!)!.toString()).toBe(
      "manifest sinf",
    );
  });

  it("should report the metadata the package declares", async () => {
    // The package is the source of truth for what it contains, which is what
    // lets a download started from a bare app id show real values.
    const ipaPath = createMockIPA("MetadataApp", {
      executableName: "MetadataApp",
    });

    const result = await inject(
      [{ id: 1, sinf: Buffer.from("sinf").toString("base64") }],
      ipaPath,
    );

    expect(result.metadata).toEqual({
      name: "MetadataApp Display",
      bundleID: "com.example.metadataapp",
      version: "4.5.6",
      minimumOsVersion: "16.0",
      artistName: undefined,
      primaryGenreName: undefined,
      releaseDate: expect.any(String),
    });
  });

  it("should prefer the store metadata it injected over the Info.plist", async () => {
    const ipaPath = createMockIPA("StoreApp", { executableName: "StoreApp" });
    const storeMetadata = Buffer.from(
      plist.build({
        bundleDisplayName: "Store Display Name",
        artistName: "Store Developer",
        bundleShortVersionString: "9.9.9",
        primaryGenreName: "Utilities",
        releaseDate: new Date("2026-01-02T03:04:05Z"),
      }),
    ).toString("base64");

    const result = await inject(
      [{ id: 1, sinf: Buffer.from("sinf").toString("base64") }],
      ipaPath,
      storeMetadata,
    );

    expect(result.metadata.name).toBe("Store Display Name");
    expect(result.metadata.artistName).toBe("Store Developer");
    expect(result.metadata.version).toBe("9.9.9");
    expect(result.metadata.primaryGenreName).toBe("Utilities");
    // releaseDate comes from the IPA's Info.plist (or its ZIP entry time),
    // not the store metadata — Apple's download API can return stale values.
    expect(result.metadata.releaseDate).toEqual(expect.any(String));
    // Still the package's own value: the store metadata does not carry one.
    expect(result.metadata.minimumOsVersion).toBe("16.0");
  });
});

describe("sinfInjector icon extraction", () => {
  const sinf = Buffer.from("sinf").toString("base64");

  /** Which entry the icon came from, from the marker the mock appends. */
  function iconNameOf(result: { icon?: { data: Buffer } }): string | undefined {
    return result.icon?.data.subarray(TINY_PNG.length).toString();
  }

  it("should lift the largest icon out of the bundle", async () => {
    // Apple ships several variants; the biggest downsamples cleanly, which is
    // what both the download list and the install manifest need.
    const ipaPath = createMockIPA("IconApp", {
      icons: ["AppIcon60x60@2x.png", "AppIcon76x76@2x~ipad.png"],
    });

    const result = await inject([{ id: 1, sinf }], ipaPath);

    expect(result.icon?.filename).toBe("AppIcon76x76@2x~ipad.png");
    expect(iconNameOf(result)).toBe("AppIcon76x76@2x~ipad.png");
  });

  it("should prefer the icon the Info.plist declares", async () => {
    // A declared icon that is smaller still wins over a bigger undecided one:
    // the Info.plist is what the app itself says it uses.
    const ipaPath = createMockIPA("DeclaredIconApp", {
      icons: ["Alternate@2x.png", "AppIcon76x76@2x~ipad.png"],
      declaredIcons: ["Alternate"],
    });

    const result = await inject([{ id: 1, sinf }], ipaPath);

    expect(iconNameOf(result)).toBe("Alternate@2x.png");
  });

  it("should match asset-catalogue icons by CFBundleIconName", async () => {
    const ipaPath = createMockIPA("CatalogueIconApp", {
      icons: ["AppIcon60x60@2x.png", "Unrelated@2x.png"],
      iconName: "AppIcon",
    });

    const result = await inject([{ id: 1, sinf }], ipaPath);

    expect(iconNameOf(result)).toBe("AppIcon60x60@2x.png");
  });

  it("should ignore icons of nested bundles", async () => {
    // Extensions and watch apps carry their own icons; only the top of the app
    // bundle describes this app.
    const ipaPath = createMockIPA("NestedIconApp", {
      icons: ["AppIcon60x60@2x.png"],
      nestedIcons: ["AppIcon1024x1024.png"],
    });

    const result = await inject([{ id: 1, sinf }], ipaPath);

    expect(iconNameOf(result)).toBe("AppIcon60x60@2x.png");
  });

  it("should report no icon when the bundle carries none", async () => {
    const ipaPath = createMockIPA("NoIconApp");

    const result = await inject([{ id: 1, sinf }], ipaPath);

    expect(result.icon).toBeUndefined();
  });

  it("should not mistake an alternate icon for the app icon", async () => {
    // One shipping app registers hundreds of theme icons as `CFBundleIconFiles`
    // under `CFBundleAlternateIcons`, naming the files after numbers. Treating
    // those as declarations would let any numbered resource image pass for the
    // icon, which is exactly the wrong answer.
    const ipaPath = createMockIPA("AlternateIconApp", {
      icons: ["176.png", "185.png"],
      alternateIcons: ["176", "185"],
    });

    const result = await inject([{ id: 1, sinf }], ipaPath);

    expect(result.icon).toBeUndefined();
  });

  it("should not guess from a resource image that merely mentions an icon", async () => {
    // The icon lives in Assets.car for this shape of bundle, and the root is
    // full of unrelated art. Nothing here is the app icon, and a wrong icon is
    // worse than none: the caller still has the storefront's.
    const ipaPath = createMockIPA("CatalogueOnlyApp", {
      icons: ["cm6_playpage_live_icon.png", "cm8_homepage_live_icon@2x.png"],
    });

    const result = await inject([{ id: 1, sinf }], ipaPath);

    expect(result.icon).toBeUndefined();
  });

  it("should read the icon back out of an already compiled package", async () => {
    // This is what fills in the icon of a package compiled before icons were
    // extracted, so it must work on a finished package and leave it alone.
    const ipaPath = createMockIPA("BackfillApp", {
      icons: ["AppIcon60x60@2x.png"],
    });
    await inject([{ id: 1, sinf }], ipaPath);

    const { icon } = await readPackageInfo(ipaPath);

    expect(icon?.filename).toBe("AppIcon60x60@2x.png");
    expect(icon?.data.subarray(TINY_PNG.length).toString()).toBe(
      "AppIcon60x60@2x.png",
    );

    // Nothing was injected twice or otherwise disturbed.
    const after = new AdmZip(ipaPath);
    const sinfEntries = after
      .getEntries()
      .filter((entry) => entry.entryName.endsWith(".sinf"));
    expect(sinfEntries).toHaveLength(1);
  });

  it("should read the icon URL Apple handed out with the download", async () => {
    // A package with no icon of its own — a tvOS build keeps it inside
    // Assets.car — still has this, and it is the only icon it can offer.
    const ipaPath = createMockIPA("ArtworkApp");
    await inject(
      [{ id: 1, sinf }],
      ipaPath,
      Buffer.from(
        plist.build({
          bundleDisplayName: "Artwork Display",
          softwareIcon57x57URL: "https://cdn.apple.com/icon.jpg",
        }),
      ).toString("base64"),
    );

    const { icon, metadata } = await readPackageInfo(ipaPath);

    expect(icon).toBeUndefined();
    expect(metadata.artworkURL).toBe("https://cdn.apple.com/icon.jpg");
    expect(metadata.name).toBe("Artwork Display");
  });

  it("should report no icon for a package that has none", async () => {
    const ipaPath = createMockIPA("NoIconBackfillApp");

    expect((await readPackageInfo(ipaPath)).icon).toBeUndefined();
  });

  it("should ask mzstatic for an icon large enough to render sharply", async () => {
    // Apple hands this one out sized for a 57pt slot; the CDN renders whatever
    // size the path asks for.
    const ipaPath = createMockIPA("SharpIconApp");
    await inject(
      [{ id: 1, sinf }],
      ipaPath,
      Buffer.from(
        plist.build({
          softwareIcon57x57URL:
            "https://is1-ssl.mzstatic.com/image/thumb/AppIcon.png/114x114bb.jpg",
        }),
      ).toString("base64"),
    );

    const { metadata } = await readPackageInfo(ipaPath);

    expect(metadata.artworkURL).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/AppIcon.png/512x512bb.jpg",
    );
  });

  it("should leave an icon URL it does not recognise alone", async () => {
    const ipaPath = createMockIPA("OpaqueIconApp");
    await inject(
      [{ id: 1, sinf }],
      ipaPath,
      Buffer.from(
        plist.build({
          softwareIcon57x57URL: "https://cdn.apple.com/icon.jpg",
        }),
      ).toString("base64"),
    );

    const { metadata } = await readPackageInfo(ipaPath);

    expect(metadata.artworkURL).toBe("https://cdn.apple.com/icon.jpg");
  });
});
