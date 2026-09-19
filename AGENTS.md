# Agent Instructions for AssppWeb

## TypeScript Code Style

- **Indentation**: 2 spaces
- **Semicolons**: Required
- **Quotes**: Single quotes for strings
- **Naming**: PascalCase for types/interfaces, camelCase for variables/functions

## Project Structure

- `backend/` — Node.js/Express server (TypeScript, ESM); tests in `backend/tests/`
- `frontend/` — React SPA (TypeScript, Vite, Tailwind CSS); tests in `frontend/tests/` (not collocated with src)
- `cloudflare/` + `wrangler.jsonc` — Cloudflare Workers + Containers deployment wrapper around the Docker image
- `Dockerfile` / `compose.yml` — single container serves both backend and SPA
- `frontend/scripts/unicorn-wasm-patch/` — patches + glue + build script for the Unicorn TCI WASM engine (see SAP section)
- `references/` is gitignored personal infrastructure (never commit); a local ApplePackage checkout may or may not exist

## Architecture — Zero-Trust

The server is a blind TCP proxy. It NEVER sees Apple credentials.

```
┌─ Browser (Client) ─────────────────────────────────┐
│  Credentials (IndexedDB): email, password, cookies, │
│    passwordToken, DSID, deviceIdentifier, pod       │
│                                                      │
│  Apple Protocol (libcurl.js WASM + Mbed TLS 1.3):   │
│    1. Bag fetch → backend proxy → resolve auth URL   │
│       (fallback to default auth endpoint if missing)  │
│    2. Authenticate → get token, cookies, pod         │
│    3. Purchase → acquire license                     │
│    4. Download info → get CDN URL + SINFs + metadata │
│    5. Version listing/lookup                         │
│                                                      │
│  TLS 1.3 encrypted via Wisp protocol over WebSocket  │
└──────────────────────┬───────────────────────────────┘
                       │ Wisp-multiplexed TCP (server cannot read)
┌─ Server (Wisp Proxy) ┴──────────────────────────────┐
│  Wisp server (@mercuryworkshop/wisp-js) on /wisp/    │
│  → multiplexed TCP relay (blind tunnel, no decrypt)  │
│                                                      │
│  Bag proxy: GET /api/bag?guid=<id>                   │
│    - Fetches init.itunes.apple.com/bag.xml via HTTPS │
│    - Returns public Apple service URLs (no creds)    │
│                                                      │
│  After client obtains download info:                 │
│    Client POSTs: { downloadURL, sinfs, metadata }    │
│    - downloadURL = Apple CDN (public, no auth)       │
│    - sinfs = DRM signatures (base64)                 │
│    - iTunesMetadata = app metadata plist (base64)    │
│                                                      │
│  Server downloads IPA from CDN, injects SINFs +      │
│  iTunesMetadata, stores compiled IPA, serves via     │
│  public install URL (itms-services manifest)         │
└──────────────────────────────────────────────────────┘
```

**Key invariant**: The server NEVER sees Apple credentials. All Apple TLS terminates at the browser via libcurl.js WASM (Mbed TLS 1.3). The server only receives public CDN URLs and non-secret metadata for IPA compilation. The bag proxy (`/api/bag`) only returns public Apple service URLs — no credentials pass through it.

## Architecture — SAP Request Signing (X-Apple-ActionSignature)

Apple requires every request to the auth endpoint to carry `X-Apple-ActionSignature: base64(Sign(bodyBytes))`. The signature is produced by obfuscated SAP entry points inside Apple's CommerceKit/CoreFP binaries (the same mechanism ipatool uses). Key property: **the signer's inputs are only the hardware ID (the per-account `deviceIdentifier`) plus public Apple assets — never credentials — but the signature covers the request body, which contains the password.** Therefore signing MUST stay in the browser; the zero-trust invariant is preserved.

```
┌─ Browser ────────────────────────────────────────────────────────┐
│ 1. Bag (via /api/bag) advertises:                                 │
│      sign-sap-setup      → setup exchange endpoint (POST plist)   │
│      sign-sap-setup-cert → certificate endpoint (GET plist)       │
│      sign-sap-version    → protocol version (200)                 │
│ 2. GET /api/sap-assets/:name → four Apple binaries (backend-     │
│    extracted, digest-pinned, browser-cached in the Cache API)     │
│ 3. SAP signer worker (Web Worker, off the UI thread):             │
│      Unicorn 2.1.4 → TCI interpreter backend → wasm              │
│      Mach-O x86_64 images loaded + dyld-info relocated in TS     │
│      entry points: initialize / exchange / sign / teardown        │
│ 4. Key exchange over the wisp tunnel (main thread):               │
│      GET cert → exchange(state 1) → POST setup → exchange(state 0)│
│ 5. authenticate() signs each attempt's exact UTF-8 body bytes     │
│    and attaches X-Apple-ActionSignature                           │
└──────────────────────────────────────────────────────────────────┘
```

### Frontend modules (`frontend/src/apple/sap/`)

- `engine.ts` — Unicorn WASM wrapper; all guest addresses cross the JS boundary as doubles (exact below 2^53; the guest map stays below 2^48)
- `machImage.ts` — Mach-O 64 parser: fat-binary slicing, LC_SEGMENT_64, symtab lookup, dyld_info rebase/bind/weak/lazy opcodes. **Opcode tables**: rebase uses nibbles 0x00–0x80 (SET_TYPE 0x10, SET_SEGMENT 0x20, …); bind is shifted down one slot (DO_BIND 0x90) because rebase-only ADD_ADDR_IMM_SCALED occupies bind's 0x90 slot elsewhere. Segment offsets move in uint64 BigInt space — bind ADD_ADDR_ULEB deltas are 64-bit encodings of negative steps. Fixups targeting a segment's BSS tail (within vmsize, past fileSize) are skipped: dyld would zero-fill them.
- `shims.ts` — guest libc/CF/IOKit shims; 64-bit −1 constants are passed as `-1` (wasm's saturating f64→i64 conversion yields 0xFFFF…F, which a JS number cannot represent exactly)
- `machine.ts` — entry-point invocation, scratch/stack layout, output disposal
- `signer.ts` / `client.ts` / `worker.ts` — orchestration; emulation runs in a Web Worker, Apple network calls ride the wisp tunnel on the main thread. `client.ts` keeps the signer as a singleton bound to the deviceIdentifier (rebuilding it means copying the 22.5 MB asset bundle into a fresh worker), with a zustand store (`store/sap.ts`), a warmup hook (`hooks/useSapWarmup.ts`, fires once an account exists), and an inline progress indicator (`components/common/SapStatus.tsx`)
- `protocol.ts` — certificate fetch + setup exchange (plist `<data>` round-trip via appleRequest)
- `assets.ts` — asset download with progress, SHA-256 verification (stripped-file pins), Cache API persistence; accepts both thin and fat Mach-O payloads
- `vendor/unicorn.mjs|.wasm` — prebuilt engine (regenerate via `frontend/scripts/unicorn-wasm-patch/build.sh`)

### Unicorn TCI WASM build chain (`frontend/scripts/unicorn-wasm-patch/`)

Unicorn 2.x only ships JIT TCG backends, which cannot execute under WebAssembly (no RWX, no wasm codegen). The patch (`patches/unicorn-2.1.4-tci-wasm.patch` against unicorn 2.1.4, whose QEMU base is 5.0.1):

1. Restores the QEMU 5.0.1 TCI interpreter (unicorn stripped it) into the tree
2. Forces 64-bit virtual TCI registers on wasm32 — QEMU 5.0's 32-bit TCI path is riddled with TODO() stubs; the register file is virtual state, so 64-bit registers need no 64-bit host pointers
3. Generates uniform-signature helper trampolines (`qemu/target/i386/tci-wasm-tramp.c`): TCI invokes every helper through one cast signature, which wasm's strict indirect-call checks reject
4. Adapts glib-compat GTree comparators (2-arg vs 3-arg) and disables inline hook callbacks for the same reason
5. Replaces the timeout thread (no pthreads in wasm) with a wall-clock deadline checked inside the TCI interpreter loop; mprotect/mmap-based guest RAM becomes aligned malloc

Build: `bash frontend/scripts/unicorn-wasm-patch/build.sh` (requires docker; emscripten runs in a container). The signed-off artifacts land in `frontend/src/apple/sap/vendor/`.

### Backend asset pipeline

`backend/src/services/sapAssets.ts` extracts the four binaries once from Apple's public OSXUpd10.9.pkg: xar TOC parse → HTTP range download of the Payload tail (~380 MB) → bzip2 stream (with a synthetic `BZh9` header from a fixed offset) → cpio (odc and newc formats) → pinned SHA-256 verification → **fat-binary stripping to the x86_64 slice** (the emulated guest architecture; CoreFP ships as an i386+x86_64 universal, so this halves it) → cache under `DATA_DIR/sap-assets`. All data is public Apple content (same trust class as the bag proxy). Specs carry two pin sets: the original Apple digest verifies the extraction; the stripped digest (a deterministic function of the original) verifies what is served and what the browser downloads. Distribution sizes: 37.7 MB original → 22.5 MB stripped → ~14 MB on the wire with the route's gzip response. The bz2 stream is truncated mid-file, so the decoder can emit a late crc error after the wanted members are captured — the pipeline swallows it by design (an unhandled rejection would crash Node).

On startup `ensureSapAssets` prefers `DATA_DIR/sap-assets`, then seeds from the image-prebaked directory (`BUNDLED_SAP_ASSETS`, default `/opt/asspp/sap-assets`), and only then falls back to network extraction (the bzip2 decoder is imported lazily because cross-built images may lack a matching napi binary for the runtime arch — see Dockerfile). Routes (`backend/src/routes/sapAssets.ts`): `GET /api/sap-assets/status`, `POST /api/sap-assets/prepare`, `GET /api/sap-assets/:name` (gzip when accepted).

### Container image

The Dockerfile prebakes the stripped SAP assets at build time (a `sap-assets` stage runs `backend/scripts/extract-sap-assets.mts`; Docker layer caching makes it a no-op on rebuilds). Release images ship the assets, so a fresh VPS serves them with zero network use. Build stages run on `$BUILDPLATFORM` (JS artifacts are platform-independent); the runtime image installs production deps per target platform because `yauzl-promise` → `@node-rs/crc32` ships prebuilt napi binaries per arch. Published platforms: `linux/amd64`, `linux/arm64`. **linux/386 is out**: official node images dropped it and `@node-rs/crc32` has no linux-ia32 build.

### SAP invariants

- The signer only ever sees the deviceIdentifier and public Apple assets; the password reaches the signer solely as opaque body bytes it signs in-place — it is never transmitted anywhere except through the wisp tunnel inside the auth request itself
- Bag missing the SAP keys → signing is skipped (graceful degradation to the legacy flow)
- SAP session lifetime = the page session: the signer is a singleton per deviceIdentifier, reused across sign-in attempts (2FA retries included); switching accounts rebuilds it. Initialization ≈ 150–300 ms of emulation plus the setup exchange round-trips
- First login downloads ~14 MB over the wire (22.5 MB stripped assets, gzipped); a background warmup and inline progress line cover it. Release images prebake the assets, so the backend serves them instantly
- The live bag currently returns the legacy `MZFinance` authenticate endpoint (see upstream PR discussion); `normalizeAuthURL` is effectively inert, and all three advertised endpoints sit in the SAP-signed list — signing applies regardless

## Reference Implementation

The upstream Swift project ApplePackage is the source of truth for Apple protocol behavior (authentication flow, bag endpoint, pod routing, error codes). A local checkout may live at `references/ApplePackage/`, but `references/` is gitignored — it is **not part of this repository** and may be absent. When unavailable, the field mapping below and the existing `frontend/src/apple/*` implementation are the in-repo reference.

### iTunes API Field Mapping

The backend (`backend/src/routes/search.ts`) maps raw iTunes API fields to our `Software` type, matching the Swift `CodingKeys` in ApplePackage's `Software.swift`:

| iTunes Field                | Software Field |
| --------------------------- | -------------- |
| `trackId`                   | `id`           |
| `bundleId`                  | `bundleID`     |
| `trackName`                 | `name`         |
| `artworkUrl512`             | `artworkUrl`   |
| `currentVersionReleaseDate` | `releaseDate`  |

All other fields (`version`, `price`, `artistName`, `sellerName`, `description`, `averageUserRating`, `userRatingCount`, `screenshotUrls`, `minimumOsVersion`, `fileSizeBytes`, `releaseNotes`, `formattedPrice`, `primaryGenreName`) keep their original names.

The backend also extracts the `results` array from the iTunes wrapper `{ resultCount, results }` before sending to the frontend.

## Per-Account Device Identifiers

Device identifiers are **per-account**, not global:

- Generated as 12 random hex chars (6 bytes) at account creation via `generateDeviceId()`
- Editable during login, immutable after authentication
- Stored in IndexedDB on the `Account` object as `deviceIdentifier`
- Passed to all Apple protocol calls (auth, purchase, download, version listing)

## Pod-Based Host Routing

After authentication, Apple returns a `pod` header:

- Store API: `p{pod}-buy.itunes.apple.com` (default: `p25-buy.itunes.apple.com`)
- Purchase API: `p{pod}-buy.itunes.apple.com` (default: `buy.itunes.apple.com`)
- Pod is stored on the Account object and used for all subsequent API calls
- Functions: `storeAPIHost(pod?)` and `purchaseAPIHost(pod?)` in `frontend/src/apple/config.ts`

## Dynamic Host Validation (Backend)

The Wisp server validates target hosts via `hostname_whitelist` in `backend/src/services/wsProxy.ts`:

- `auth.itunes.apple.com` — bag-resolved auth endpoint
- `buy.itunes.apple.com` — purchase endpoint
- `init.itunes.apple.com` — bag endpoint
- `/^p\d+-buy\.itunes\.apple\.com$/` — pod-based hosts
- `downloaddispatch.itunes.apple.com` — download fallbacks: redownload (`/r/redownload`) and updateProduct (`/up/updateProduct`)
- `fpinit.itunes.apple.com` — SAP setup exchange endpoint (`sign-sap-setup`)
- `s.mzstatic.com` — SAP certificate endpoint (`sign-sap-setup-cert`)
- `uclient-api.itunes.apple.com` — storefront catalogue lookup, used to pin the external version id before the redownload fallback (ipatool does the same)
- `apps.apple.com` — storefront product pages for the visionOS and macOS version lookups (`/{cc}/app/id{id}?platform=vision|mac`); public content, no credentials, but CORS-blocked so it rides the wisp tunnel
- Port restricted to `443` only
- Direct IP targets blocked (`allow_direct_ip = false`)
- Loopback IP targets blocked (`allow_loopback_ips = false`)
- Private/reserved resolved IPs allowed (`allow_private_ips = true`) for Docker/OrbStack DNS translation while hostname allowlist remains the primary control

## Download Endpoint Chain (Frontend)

`frontend/src/apple/download.ts` mirrors ipatool's `sendDownloadProduct`
(`pkg/appstore/appstore_download_product.go`). No single endpoint serves every
account/app pair, so the flow walks three of them and only two reply shapes move
it on:

1. **volumeStore** — `p{ped}-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=`.
   Primary. Names the version `externalVersionId`.
2. **redownload** — the bag's `redownloadProduct` URL. Names the version `appExtVrsId`.
3. **updateProduct** — the bag's `updateProduct` URL. Same version key as redownload.

Fallback triggers, exactly as in ipatool:

- volumeStore → redownload when the reply is **empty** (HTTP 200, no
  `failureType`, no `customerMessage`, no `songList` — the purchase receipt Apple
  returns for an app the account does not own yet) or **unavailable** (HTTP 200,
  no `failureType`, no items, `customerMessage` ending in "No Longer Available").
- redownload → updateProduct when the request fails with an **empty HTTP 500**, or
  when redownload answers with the same availability message. Only reached with a
  pinned version id, since updateProduct needs one.
- A reply carrying a `failureType` is a real answer and is never retried on
  another host. `5002` is grouped with the password-token failures (`2034`,
  `2042`, `1008`) and reported as a session problem; `9610` means the license is
  missing.

Both dispatch URLs come from the bag and are validated against an exact
host/path pair (`downloadDispatchEndpoint` in `config.ts`) before use.

The version id for the redownload hop is pinned from
`uclient-api.itunes.apple.com` before the first attempt, because the reply that
would normally carry it — the volumeStore document — is what came back empty. A
lookup failure is fatal, matching ipatool: an unpinned redownload can answer with
a tvOS build for a universal app.

### Platform Version Pinning (Frontend)

`frontend/src/apple/platformVersion.ts` mirrors ipatool's
`lookupLatestExternalVersionID` and `lookupLatestMacOSExternalVersionID`. Three
transports, one per platform family:

- **iOS / iPad / tvOS** — the MDM catalogue at `uclient-api.itunes.apple.com`
  with `p=mdm-lockup` and a per-platform `platform` parameter. iOS/iPad start
  at the enterprise catalogue (`enterprisestore`) and fall back to the
  consumer `iphone`/`ipad` catalogues — some storefronts have no enterprise
  listing even when a consumer catalogue has the app (ipatool e5211d6). Each
  lookup keeps the account's country code, and tvOS stays on the single `atv9`
  catalogue.
- **visionOS** — Apple's MDM catalogue does not carry visionOS offers, so the
  storefront product page at `apps.apple.com/{cc}/app/id{id}?platform=vision`
  is used instead. The `<script id="serialized-server-data">` JSON is parsed
  and walked for a `purchaseConfiguration` with
  `metricsPlatformDisplayStyle: "vision"`, `"vision"` in `appPlatforms`, and
  `buyParams.salableAdamId` matching the app.
- **macOS** — the legacy MDM lookup can return an iOS offer even with
  `platform=osx`, so the Mac storefront product page
  (`apps.apple.com/{cc}/app/id{id}?platform=mac`) selects the native Mac offer
  the same way (`"mac"` in `appPlatforms`, `salableAdamId` and `bundleId`
  matching).

`downloadProduct.ts` pins tvOS/visionOS/macOS before the volumeStore request;
`versionFinder.ts` pins the same three before the version list exchange. iOS/iPad
pass an empty pin and let the exchange resolve one on fallback.

### Package Platform Validation

Two checks bracket the package's platform: one before the download starts, one
after it lands.

Before: `createTask` refuses a task whose `downloadURL` path ends in `.pkg`
while the task's platform is not macOS (`assertPackageMatchesPlatform`, next to
`validateDownloadURL`). macOS packages are xar containers — no sinfs to inject,
nothing the IPA pipeline can unpack — so a mismatch would only surface after the
whole package had been fetched. The mismatch is reachable because the version
pin that selects the build can be *guessed* (see the neighbour guess in
`versionFinder`). The frontend repeats the same check in `interpretReply` so the
user gets the message in their own language before a task exists at all.

After: `backend/src/services/packagePlatform.ts` mirrors ipatool's
`validatePackagePlatform`. The downloaded package's `Payload/*.app/Info.plist`
`CFBundleSupportedPlatforms` is **the authority** over the platform the request
named: a universal app searched as tvOS may have served its iOS build, and the
package knows which. `platformFromSupported` reads the platform out of it
(`XROS` → visionOS, `AppleTVOS` → tvOS, `iPhoneOS` → iOS) and the completion path
**rewrites the task's platform** to what the package really is
(`downloadManager`, right after the download) rather than failing — the task
then reads as the platform it actually holds. Only a package declaring no known
platform at all fails the task. macOS packages skip the check (they are not
IPAs, and `isMacOSPackage` is decided by the task's platform).

The payload both endpoints receive is `creditDisplay`, `guid`, `salableAdamId`
(integer), `serialNumber: "0"`, plus the endpoint's version key when pinned. The
original POST is replayed at any redirect location (the volumeStore pod
hand-off expects the same body; Go's client would downgrade 302 to a bodyless
GET).

### Version flows share the exchange

`frontend/src/apple/downloadProduct.ts` holds the exchange itself
(`requestDownloadProduct`), because ipatool drives three operations through its
`sendDownloadProduct`. On this side:

- `download.ts` — ipatool's `Download`
- `versionFinder.ts` — ipatool's `ListVersions` (`listVersions`)
- `versionLookup.ts` — ipatool's `GetVersionMetadata` (`getVersionMetadata`)

So the endpoint fallbacks above apply to the version pickers too. Each caller
applies its own failure mapping, exactly as ipatool does:

- `Download`: `5002` joins the session failures (`2034`, `2042`, `1008`).
- `ListVersions` / `GetVersionMetadata`: only `2034`/`2042` are session
  failures; `5002` is reported as a plain failure.

`listVersions` returns identifiers **newest first** (Apple sends them oldest
first) because the pickers render the array in order, and exposes Apple's
`softwareVersionExternalIdentifier` as `latestExternalVersionId` (optional — this
app offers "latest" as an explicit choice instead of reading it off the reply).

One deliberate deviation in `getVersionMetadata`: ipatool reads the display
version and release date out of the IPA itself (range requests against the CDN)
because Apple's reply can carry stale values. Fetching app assets from the
browser would mean widening the Wisp host allowlist and duplicating what the
backend downloads, so the reply's metadata is used instead; the version-history
UI treats a failure there as non-fatal.

### License acquisition treats "already owned" as success

`purchase.ts` (ipatool's `Purchase`) treats `failureType 5002`, `2019`, and an
HTTP 500 carrying no `failureType` as success: all three mean the order is
already fulfilled, and ipatool's CLI ignores its `ErrLicenseAlreadyExists` as a
terminal success state. `2059` retries once with the Apple Arcade
`pricingParameters` (`GAME`), matching ipatool.

### Finding apps (link, bundle id, or App ID)

The search page is the single entry for creating a download: its input takes
an App Store link, a bundle id, a numeric App ID, or a plain name. A numeric
input — or a store link's `/id…` — goes through the id lookup; anything else
goes through the catalogue. The App ID **is** ipatool's `App.ID`. The
new-download page is retired: `/downloads/add` and the legacy
`/downloads/by-id` redirect to `/search`, the downloads list carries no
「新建下载」 shortcut anymore, and the page component is deleted.

A delisted app recalled from the package-app index (below) has its version
list fetched in the background when its detail view opens — the id alone is
enough for Apple's exchange — and the result is cached per app+platform
(page memory only — a reload fetches fresh), so 选择版本 opens straight from
the cache. The fetch is silent, and the recorded version pin keeps it
working where the live catalogue has nothing to say.

The app id is therefore the identity of a task and everything else is derived,
in this order:

1. the storefront lookup (with the package-app index as its fallback),
2. what the download response reports — `softwareVersionBundleId` becomes
   `DownloadOutput.bundleID`, and the item metadata is what the frontend embeds
   as `iTunesMetadata.plist`,
3. **the compiled package**, read by the injector (`inject()` returns a
   `PackageMetadata`): the `iTunesMetadata.plist` written during injection names
   the app the way the storefront does, and the app's own `Info.plist` covers
   the rest (`CFBundleIdentifier`, `CFBundleShortVersionString`,
   `MinimumOSVersion`, `CFBundleDisplayName`/`CFBundleName`).

`applyPackageMetadata` in `downloadManager.ts` fills only the fields that are
still empty, and the task is persisted with them — so the downloads list and the
package detail view show the real name, developer, version, minimum OS, genre and
release date instead of any sparse label the request carried. The package
build size is filled the same way. A storefront value always wins, so downloads
started from search results are untouched.

Until step 3 lands, the on-disk layout uses the app id as the directory segment
(`appPathSegment`), which is also ipatool's rule of omitting the fields it does
not know. `POST /api/downloads` rejects a request without a positive app id, and
the install manifest refuses to build without a bundle identifier rather than
handing iOS one it will reject.

One deliberate gap remains: a task that finished before this enrichment existed
keeps its stored values.

### Search (name, bundle id, link, or App ID)

The search box is the app entry (see above): a store link's `/id…` or a bare
numeric App ID goes through the exact id lookup — which also recalls delisted
apps from the package-app index — while bundle ids keep their exact lookup
and everything else stays a fuzzy catalogue search. A bare id that resolves
nowhere becomes a 「无商店数据」 row (`metadataSource: "bare"`, name `App <id>`)
that is probed by the version exchange: while it runs the card says
「正在确认该 App ID 是否存在…」 and is not walkable; versions coming back settle
it into a normal, walkable result; Apple having nothing to serve drops it into
the 未找到相关应用 panel. A 「已下架 · 本地记录」 row (`metadataSource: "local"`)
carries that evidence only for the platforms it was recorded on (`version` is
filled from the *requested* platform's build and left empty when that platform
was never downloaded), so an iOS-only record asked for as tvOS is probed the
same way — under 「正在确认该平台是否有可下载的版本…」 — with one difference: a
package-index record is never dropped, since a compiled package vouches the app
exists and Apple's answer settles this platform at most (the card stays closed
and says why). An inconclusive
failure (session, transport, storefront mismatch, or a version id that cannot
be pinned — a non-iOS ask is not judged without one, and a `bare`/`local`
record with no pin to read may first have one guessed: the ids adjacent to the
newest one in its iOS list are probed against the target platform's exchange,
nearest first (±1, ±2, … up to six steps each way), six at a time, and the
first one served becomes the pin; an id the iOS list itself carries is never a
candidate, since it is known to be an iOS build) keeps the card closed
and says why. The verification is region-
and platform-scoped: switching either re-runs it with the new dimension's
account and entity — the list cache alone never re-settles across regions, and
`ensureVersionList` takes a flow key so the new dimension starts a fresh
exchange. The probe follows the delisted
flow otherwise — 选择版本/查版本号 fetch versions (iOS natively; other
platforms need a version id) and the download proceeds from them.
Bundle-id misses and empty name searches stay an empty result set — shown as
its own 未找到相关应用 panel (the store's `searched` flag separates it from
the pre-search empty state). A name search also merges the package-app index's matches in on
top — tagged, newest first, and never duplicating a storefront hit — so
delisted apps are findable by name. It pairs with an optional 版本 ID field (validated as digits)
whose value rides along as the version pin: the delisted background fetch,
the detail picker's fetch and preselect, and the download's fallback target.
A delisted hit is tagged 「已下架 · 本地记录」 (a bare record 「无商店数据」)
right in the result row, and its version list is fetched in the background
as soon as the search resolves it — for a bare record, and for a package-index
record with no build for the platform in view, that fetch *is* the probe —
before the detail view opens, so 选择版本 can start from the cache.

Product detail carries the version picking now that the separate version
history page is retired (its route and lazy import are gone; the component
file is kept on disk, unreferenced, per the user's call): 「选择版本」 opens an
inline picker — fetched with the license-aware flow and cached per
app+platform — and 「下载」 downloads the picked version; delisted apps fetch
their list in the background on open so the picker starts from the cache.
Picking resets whenever the storefront or platform changes, and the preview
mode simulates the action like its siblings. With the automation switch off,
the picker offers 「查版本号」 next to 「下载」 — the same on-demand fill
(`force`). A route-supplied version id (from the search page's optional
field) pins the picker fetch and becomes the download target when nothing
else is picked. When the entry region has no account, the actions hide behind
a notice asking for another region's account — the account selector stays
usable and already drives the region (picking one refetches). Switching to a
region or platform the app does not exist in snaps back to the previous
selection with a toast — the page never dead-ends on not-found; only the
newest lookup may apply. Delisted records carry the same 「已下架 · 本地记录」 tag on
the detail header plus the local-record note, and missing detail values
(version, size, minimum OS, seller, date) render as an em dash — the package
enrichment backfills them once a build is downloaded.

### App icon extraction

The icon comes out of the package during the same pass that reads the metadata —
`inject()` returns a `PackageIcon` alongside `PackageMetadata`. Apple ships the
icon as several loose images at the top of the app bundle
(`AppIcon60x60@2x.png` and friends), so `selectIcon` considers only two groups,
in order:

1. images the **primary** icon declares (`CFBundleIcons.CFBundlePrimaryIcon` /
   `CFBundleIcons~ipad.CFBundlePrimaryIcon` / the legacy top-level
   `CFBundleIconFiles` + `CFBundleIconName`);
2. files named like an icon — `AppIcon…`, `Icon-60@2x`.

Within the group it takes the largest, by the point size encoded in the name
(`AppIcon76x76@2x` beats `AppIcon60x60@2x`) with file size as the tiebreak.

Three rules keep this from picking the wrong image, and all three matter:

- **`CFBundleAlternateIcons` is ignored.** Those are the alternates a user picks
  between, and apps that sell themes register hundreds of them. One shipping app
  files its whole skin catalogue there, naming the files after numbers, and its
  bundle root holds 269 images — treating those as declarations let unrelated
  resource art pass for the icon.
- **Only `Payload/<App>.app/<file>` counts**, so icons of nested bundles
  (extensions, watch apps) are never mistaken for the app's.
- **When neither group matches, nothing is extracted.** The real icon may live
  in `Assets.car`, which is not worth parsing; a wrong icon is worse than none
  when `software.artworkUrl` can cover the UI instead.

Apple repacks shipped icons with `pngcrush -iphone`, producing a **CgBI** PNG:
the `CgBI` chunk before IHDR, a raw (unwrapped) deflate stream, and BGRA
premultiplied pixels. Safari decodes those and **no other browser does**, so an
icon served untouched simply fails to load and the UI shows a placeholder.
`services/cgbiPng.ts` converts it back to a standard PNG (inflate raw, reverse
the scanline filters, un-premultiply, swap channels, re-emit with a zlib stream
and fresh CRCs) as part of extraction.

`downloadManager` parks the result beside the IPA as `icon.png` (or `icon.jpg`),
and `iconPathFor` finds it by that name — no extra field on the task. It is
exposed as `hasIcon` on the API response and served by
`GET /api/downloads/:id/icon?accountHash=…`, which 404s when a package had none
so the frontend can draw its own placeholder. That route is exempt from
`accessAuth` because an `<img>` cannot carry the access token, and the same image
is already public under `/install/`.

`/api/install/:id/icon-small.png` and `icon-large.png` serve the same file
instead of the blank placeholder they used to return, which is what iOS shows on
the home screen while installing. Both come from one file because the package
rarely holds anything near the 512px the manifest nominally asks for and iOS
scales. The frontend prefers `software.artworkUrl` and only falls back to the
extracted icon (`taskIconUrl` in `utils/icon.ts`), so a storefront download is
unchanged.

The 「安装」 button carries a platform guard (`frontend/src/utils/device.ts`):
every click opens a dialog before the `itms-services://` hop. iPhone/iPad take
iOS/iPadOS packages and a Vision Pro takes visionOS; an Apple-silicon Mac takes
iOS/iPadOS when the probe can prove the silicon (Chromium's UA-CH
`architecture`, else the Safari WebGL renderer — anything unconfirmed falls back
to the download route), and every other mismatch (iPhone × tvOS, desktop ×
iOS, …) gets a next-step hint instead of a hop into a broken install. A
device that can take the package first sees the overwrite notice: a direct
install cannot replace an already-installed app. On Apple-silicon Macs the
notice says the new build replaces the installed one in place
(`install.overwrite.bodyMac`); on iPhone/iPad/Vision Pro it points at the
AirDrop route (`install.overwrite.body`) — sending the package from another
device installs over the existing app when it is received. The copy lives under
the `install.*` keys in the six locales.

The store metadata also carries the icon URL Apple handed out with the download
(`softwareIcon57x57URL`), which the injector already writes into the package as
`iTunesMetadata.plist`. `PackageMetadata.artworkURL` reads it back out, so a
package with no icon of its own still has one to show — a tvOS build keeps its
icon inside `Assets.car` and has **no** loose image anywhere, which is the case
that needed this. mzstatic hands the URL out sized for a 57pt slot and renders
any size on demand, so the size component in the path is raised to 512; a URL
that does not look like one of these is left alone rather than risked.

The stored values are **cached answers**, so `repairFinishedPackages` re-derives
both the icon and the metadata of every finished package at startup (in the
background, never awaited): packages that predate extraction get theirs read
back, an icon stored in a format browsers cannot decode is rewritten, one the
current rules would not choose is removed, and metadata that was missing is
filled. That is what carries a rule fix to packages already on disk — much
cheaper than another download.

## Bag Proxy (Backend)

The backend proxies the bag endpoint via `GET /api/bag?guid=<deviceId>` using Node.js native HTTPS. It sends Configurator-compatible request headers (`User-Agent`, `Accept: application/xml`). The bag response is public data (Apple service URLs) — no credentials are involved. See `backend/src/routes/bag.ts`.

## Backend

- Express + `@mercuryworkshop/wisp-js` for HTTP and Wisp proxy
- ESM modules (`"type": "module"` in package.json)
- `tsx` for development, `tsc` for production build
- SINF injector also handles optional `iTunesMetadata.plist` injection at IPA root
- Bag proxy for `init.itunes.apple.com`
- SAP asset extraction service (xar + bzip2 + cpio) with digest pinning; routes under `/api/sap-assets`
- Shared version metadata cache (read-only, passively seeded — see the Version Metadata Cache section below)
- Shared version pin store (read-only, passively seeded — see the Version Pin Store section below)

### Backend Shared Utilities

- `backend/src/utils/route.ts` — shared Express route helpers (`getIdParam`, `requireAccountHash`, `verifyTaskOwnership`)
- `backend/src/config.ts` — centralized constants (`MAX_DOWNLOAD_SIZE`, `DOWNLOAD_TIMEOUT_MS`, `BAG_TIMEOUT_MS`, `BAG_MAX_BYTES`, `MIN_ACCOUNT_HASH_LENGTH`, `VERSION_METADATA_MAX_ENTRIES`) and env-var config (`disableHttpsRedirect` via `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT`)

### Version Metadata Cache

`services/versionMetadataCache.ts` + `routes/versionMetadata.ts` serve a read-only, instance-wide `(appId, versionId) -> (displayVersion, releaseDate)` directory via `GET /api/version-metadata/:appId`. Entries are seeded **passively only** — the download pipeline records what compiled packages read back (the two `applyPackageMetadata` sites in downloadManager, including the startup `repairFinishedPackages` pass). There is no client write-back and the server never queries Apple itself (it holds no credentials), so the zero-trust invariant is untouched; the data is storefront-public and carries no account binding, but reads still ride `accessAuth`. Entries are immutable (a version id names a fixed build), capped at `VERSION_METADATA_MAX_ENTRIES` (oldest evicted first), and persisted to `DATA_DIR/version-metadata.json`. The frontend consumes the cache best-effort (`api/versionMetadata.ts`, `hooks/useVersionMetadata.ts`, `utils/versionLabels.ts`) and falls back to the live Apple exchange for uncached versions. The hook marks versions whose lookup is in flight as `pending` (`store/versionMetadata.ts`), so the pickers and rows can show a fetching marker (`search.versions.fetching`) instead of a bare id while it runs. A list load fills up to a hundred missing versions — the first twenty five wide, the rest one at a time — and leaving the page cancels the queue; results already fetched keep their write-back (keepalive requests, so a closing tab still delivers them). With the automation switch off, the version picker offers the same fill on demand: a 「查版本号」 button left of 「下载」, styled like 「选择版本」 (`search.product.checkVersionNumbers`; it passes `force` to run the fill even though the automatic path is off).

### Version Pin Store

`services/versionPinStore.ts` + `routes/versionPins.ts` serve a read-only, instance-wide `(appId, platform) -> externalVersionId` record via `GET /api/version-pins/:appId`. It exists because listing versions for tvOS / visionOS / macOS requires pinning the download-product exchange to a version id that exists for that platform — and the catalogue lookup that normally supplies it has no answer left for **delisted apps**. A past download of the app left the id behind in its finished package, so recording it keeps those apps queryable. Seeded **passively only** (the completion and `repairFinishedPackages` paths of the download pipeline; no client write-back, no server-side Apple queries), the newest (largest) id per app+platform wins, and the store persists to `DATA_DIR/version-pins.json`. The frontend consumes it best-effort in `apple/versionPins.ts` (`recordedVersionIdFor` / `withRecordedFallback`): the live catalogue lookup stays first; the recorded pin is the fallback for both version listing (`apple/versionFinder.ts`, which also accepts a caller-provided pin) and the download flow's pin resolution (`apple/downloadProduct.ts`). The search page passes a hand-entered version id as the exchange pin
directly.

`services/packageAppStore.ts` is the companion index for delisted apps
themselves: `appId -> { bundleID, name, builds }`, written by
`rememberPackageApp` from the same compile / repair call sites that feed the
version cache and pins, and persisted to `DATA_DIR/package-apps.json`. Builds
are tracked per platform — the same app ships different versions for different
platforms (`Forward` was 1.3.18 on iOS and 1.3.19 on tvOS) — and `/api/lookup`
answers with the requested platform's build, omitting the version when that
platform has no recorded package (legacy flat files migrate to the platform
they recorded). It consults the index when the storefront answers nothing, so
a delisted app stays findable by bundle id (or enriched when looked up by id);
the response carries `metadataSource: "local"` and the UI labels it. Storefront
answers always win.

## Frontend

- React 19, React Router 7, Zustand for state
- Tailwind CSS 4 for styling
- Vite for build tooling
- IndexedDB for credential storage (via `idb`)
- `libcurl.js` (WASM) for browser-side TLS 1.3 via Mbed TLS — connects through Wisp protocol
- `appleRequest()` in `frontend/src/apple/request.ts` wraps `libcurl.fetch` for all Apple API calls and forces HTTP/1.1 (`_libcurl_http_version: 1.1`)
- Bag endpoint (`frontend/src/apple/bag.ts`) uses backend proxy (`/api/bag`) and falls back to `https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate` when `authenticateAccount` is missing or bag fetch fails
- Authentication (`frontend/src/apple/authenticate.ts`) resolves bag endpoint, then sets `guid` via URL query manipulation to avoid duplicate/malformed query parameters
- Plist build/parse (`frontend/src/apple/plist.ts`) uses native XML builder and browser-native `DOMParser`
- Cookie helper (`frontend/src/apple/cookies.ts`) — `extractAndMergeCookies(rawHeaders, existingCookies)` replaces the repeated extract-and-merge pattern across all Apple protocol files

### Frontend Shared Components (`components/common/`)

- **Alert** — `<Alert type="error|success|warning">` for status messages (replaces inline alert divs)
- **Modal** — `<Modal open={bool} onClose={fn} title={string}>` for dialog overlays
- **Spinner** — inline SVG loading spinner for buttons
- **CountrySelect** — optgroup-based country dropdown with "Available Regions" + "All Regions"
- **AppIcon** — 3 sizes (40/56/80px), rounded corners; a real name falls back to its letter, the `App <id>` placeholder name to the Apple mark
- **AccountAvatar** — account avatar: probes the email's gravatar (MD5-keyed, `?d=404`) and swaps the image in only once it loads; accounts without one keep the initial-letter gradient. No CSP is set, so the image loads unobstructed
- **Badge** — color-coded status pill
- **ProgressBar** — gray track, blue fill, percentage label
- **ToastContainer** / `utils/toast.ts` — toast notifications (incl. account-context helpers)
- **GlobalDownloadNotifier** — global download status notifications
- **icons** — shared SVG icon components (`HomeIcon`, `AccountsIcon`, `SearchIcon`, `DownloadsIcon`, `SettingsIcon`, `SunIcon`, `MoonIcon`, `SystemIcon`) used by Sidebar, MobileNav, and MobileHeader

### Frontend Shared Utilities (`utils/`)

- `utils/error.ts` — `getErrorMessage(e, fallback)` for standardized catch-block error extraction
- `utils/crypto.ts` — AES-GCM encrypt/decrypt for account export/import
- `utils/account.ts` — `accountHash()`, `accountStoreCountry()`, `firstAccountCountry()`, `accountSelectLabel()` (region · name (email), joined with a middle dot)
- `utils/avatar.ts` — `gravatarUrl()` + a local RFC 1321 `md5()`: the account-avatar probe (lowercase email digest; `d=404` makes a missing avatar fail fast)
- `utils/toast.ts` — toast helpers (pairs with `ToastContainer`)
- `utils/version.ts` — numeric dot-separated version string comparison
- `utils/versionLabels.ts` — `versionOptionLabel` / `versionRowLabel`: render a cached display version in the version pickers (uncached entries keep the raw id)
- `utils/bundleId.ts` — `looksLikeBundleId(term)`: search terms that read as bundle identifiers are routed to the exact lookup (Apple's fuzzy search answers them with unrelated apps)

### Import Ordering Convention

1. React / library imports (`useState`, `useNavigate`, `useTranslation`)
2. Layout components (`PageContainer`)
3. Common components (`AppIcon`, `Alert`, `Spinner`, `Modal`, `CountrySelect`)
4. Sibling components within the same feature folder (e.g., `DownloadItem` inside `Download/`)
5. Hooks / stores (`useAccounts`, `useSettingsStore`)
6. Apple protocol / API modules (`authenticate`, `purchaseApp`, `apiPost`)
7. Utilities (`accountHash`, `getErrorMessage`)
8. Config (`countryCodeMap`, `storeIdToCountry`)
9. Types (`type Software`)

**Enforcement**: Every PR must verify import ordering. Common mistakes:

- Putting hooks/stores before layout/common components
- Putting config before utilities
- Putting type imports in the middle instead of last

## Security Model

### Account Hash Is Public

`accountHash` is a SHA-256 of the account email. It is treated as **public, non-secret data** — it identifies which account owns a download but does not grant any privileged access. No authentication is bound to it. This is by design: the server is a blind proxy and does not manage user sessions.

### Trusted Sources

- **Apple API responses** (bag XML, iTunes search results, `customerMessage` fields) are treated as trusted content. No additional sanitization is applied beyond what React's text rendering provides (no `dangerouslySetInnerHTML`).
- **Apple CDN redirects** during IPA download are trusted. The initial URL is validated against `*.apple.com`, and redirect targets from Apple's CDN infrastructure (e.g., Akamai) are followed. The response body is saved to disk — it is never reflected back to the requester.
- **Version-metadata CDN range fetch** (`backend/src/services/packageVersionMetadata.ts`, `versionMetadataFromDownloadURL`) follows the same trust model: only the initial URL is validated via `validateDownloadURL` against `*.apple.com`, and the native `fetch` follows the CDN redirect chain (Akamai and friends) without re-checking each hop. The downloaded bytes are only parsed for a plist and returned to the caller as version metadata — never reflected — and every fetch is range/HEAD bounded, so this matches the main download pipeline's posture rather than adding a stricter redirect check.

### Browser as Security Boundary

Credentials (passwords, `passwordToken`, cookies) stored in IndexedDB are protected by the browser's same-origin policy. Encrypting them at rest would be security theater — the decryption key would also live in JS. The threat model assumes the browser environment is trusted; if an attacker has XSS, they can exfiltrate credentials regardless of at-rest encryption.

### Backend Does Not Reflect Request Headers

The settings endpoint (`/api/settings`) must never reflect request headers (`x-forwarded-host`, `host`, etc.) in its response body. Use server-side values only (`config.*`, `process.uptime()`).

## Error Handling

- Early returns to reduce nesting
- `try/catch` for async operations
- Express error middleware for centralized handling
- Type-safe error responses

### Apple Protocol Error Codes

- `2034` / `2042`: Token expired — re-authentication required
- `customerMessage === 'Your password has changed.'`: Password token invalid
- `action.url` ending in `termsPage`: Terms acceptance required (throw with URL)

## Testing

### Unit Tests (Vitest)

```bash
cd backend && npx vitest run    # Node environment; tests in backend/tests/
cd frontend && npx vitest run   # jsdom environment with fake-indexeddb; tests in frontend/tests/
```

Frontend tests mirror the src layout under `frontend/tests/` (`apple/`, `api/`, `store/`, `utils/`) — add new tests there, not next to source files.

There is no E2E suite or lint script in the repo currently. Real-account Docker verification (2026-02-22): authentication succeeds through Wisp, and backend logs contain only connection/stream metadata (no Apple credentials, password tokens, or cookies).

SAP-specific tests:

- `frontend/tests/sap/machImage.test.ts` (vitest) — synthetic Mach-O builder exercising symbol export, rebase/bind opcodes, addends, and BSS-tail fixup tolerance
- `frontend/tests/sap/machine-live.mjs` (manual, `npx tsx`) — full chain against the real Apple assets served by the backend: machine open → Initialize (context matches the native ipatool runtime bit-for-bit: `0x400000000200`) → Sign correctly gated by the key exchange (`-42085` without it, identical to native). Requires `SAP_ASSET_DIR` pointing at a flat copy of the four assets, or the nested extraction layout

Test credentials, if ever needed, belong in environment variables (`TEST_EMAIL`, `TEST_PASSWORD`, `TEST_DEVICE_ID`, `TEST_BUNDLE_ID`) and must never be committed.

## Deployment

### Docker Compose (self-host)

```bash
docker compose up -d   # Runs prebuilt image ghcr.io/demojameson/assppweb:latest on port 8080
```

`compose.yml` pulls the published image (no local build), mounts `./mnt/asspp-data:/data` for `DATA_DIR`, and supports `ACCESS_PASSWORD` / `DOWNLOAD_THREADS` env vars. The `Dockerfile` at the repo root is what CI builds and publishes that image.

Single container serves both the Express backend and the Vite-built React SPA. SPA routes are handled by serving `index.html` for all non-API paths.

### Cloudflare Workers + Containers

`wrangler.jsonc` + `cloudflare/src/index.ts` deploy the same Docker image as a Cloudflare Container behind a Worker:

```bash
npx wrangler login
npx wrangler deploy
```

- Requires the Cloudflare Workers **Paid** plan (Containers are not on Free)
- All HTTP/WebSocket traffic routes to one named container instance (`main`) to keep state consistent; `max_instances: 1`
- Container filesystem is **ephemeral** — compiled IPAs are lost when the container stops/sleeps (`sleepAfter = "2h"`)
- Health ping endpoint: `/api/settings`; worker injects `x-forwarded-proto: https` when missing to avoid redirect loops
- `wrangler.jsonc` build command installs `@cloudflare/containers` on the fly, so deploys need no persistent devDependency

`README.md` documents the full deploy matrix (Cloudflare button, Railway with its Cloudflare-proxy TLS caveat, reverse-proxy WebSocket requirements for `/wisp/`).

## Interface Design System

### Intent

**Who**: Developers and power users managing Apple app downloads outside the App Store — sideloading IPAs, managing multiple Apple IDs, tracking licenses. Technical audience, likely running this alongside terminals or Xcode.

**Task**: Authenticate Apple accounts → search apps → acquire licenses → download/compile IPAs → install.

**Feel**: A sharp utility. Precise like a package manager, clear like Apple's developer tools. Confident, quiet, functional. Not playful, not corporate.

### Design Tokens

- **Primary accent**: `blue-600` / `blue-700` (hover) — trust + system authority, echoes Apple dev tooling
- **Backgrounds**: `gray-50` (app), `white` (cards/surfaces)
- **Text**: `gray-900` (primary), `gray-600` (secondary), `gray-400` (tertiary)
- **Borders**: `gray-200` (default), `gray-300` (hover) — use sparingly, prefer background tinting for containment
- **Status badges**: Muted tones — `green` (completed), `blue` (downloading), `yellow` (paused), `purple` (injecting), `red` (failed), `gray` (pending)
- **Alerts**: `red-50`/`red-700` (error), `amber-50`/`amber-700` (warning), `green-50`/`green-700` (success)

### Styling Mechanics (gotchas)

- `index.css` overrides the Tailwind palette with iOS-flavored values: `blue-600` = `#007aff` (system blue) and a full iOS gray ramp. `orange` is **not** overridden (stock Tailwind). In computed styles, overridden hex colors surface as `rgb(...)` while stock Tailwind v4 colors surface as `oklch(...)` — assert accordingly in tests.
- `button, input, select, textarea { font: inherit }` is declared **unlayered**, so it beats Tailwind v4's `@layer utilities`: any `text-*` / `font-*` utility on a `<button>` is silently ignored (buttons render at the inherited 16px / 400). Links (`<a>`) are unaffected.
  - Consequence: to make an `<a>` styled as a button match its button siblings, leave the font utilities OFF it so both sides inherit identically.
- Secondary-action pattern (low presence, mirrors 「获取许可证」): tinted background + colored text, e.g. `bg-orange-50 text-orange-600 hover:bg-orange-100` with `dark:bg-orange-950/60 dark:text-orange-400 dark:hover:bg-orange-950`. Use for version-action buttons (选择版本 / 查版本号); solid `bg-blue-600` stays for primary download actions.
- Dropdown menus open with a small heading naming their content — set each option's `group` (`SelectOption.group`, rendered as a muted `text-xs` row above its section): 平台 / 账号 / 版本 / 语言 / 国家 / 地区. The country menus keep their structured sections instead (可用国家 / 地区 · 所有国家 / 地区). Dropdowns carry no caption above them (a short-lived experiment, reverted) — only inputs do: the search box, the version ID field, and the settings selects keep their field labels.

### Typography

- System font stack (Inter / SF Pro fallback)
- Weight scale: `500` (medium, workhorse), `600` (semibold, page titles and key labels only). Avoid `700` in body.
- Size scale: `xs` (12px), `sm` (14px), `base` (16px), `lg` (18px), `xl` (20px), `2xl` (24px)

### Spacing

- Base unit: `4px`
- Consistent vertical rhythm: `space-y-4` within sections, `space-y-6` between sections
- Page padding: `px-4 sm:px-6`, `py-6`
- Container: `max-w-5xl` (1024px)

### Depth & Surfaces

- Single elevation: white cards on `gray-50` background
- No shadows. Borders only where they serve function (form inputs, dividers, interactive boundaries)
- Rounded corners: `rounded-lg` (8px) for cards, `rounded-md` (6px) for inputs/buttons, `rounded-full` for badges
- Prefer background tinting (`gray-50` → `gray-100`) over borders for visual containment

### Layout

- Desktop: fixed sidebar (240px / `w-60`) + scrollable main content
- Mobile: bottom tab bar with safe-area padding
- Breakpoint: `md:` (768px) for sidebar ↔ bottom nav switch
- Page structure: `PageContainer` with title + optional action button, then content

### Component Patterns

- **Buttons**: Primary (`bg-blue-600 text-white`), Secondary (`border border-gray-300 text-gray-700`), Danger (`text-red-600 border-red-300`)
- **Inputs**: `rounded-md border-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500`
- **Cards**: White background, `border border-gray-200 rounded-lg`, no shadow
- **Badge**: Color-coded pill (`rounded-full px-2 py-0.5 text-xs font-medium`)
- **ProgressBar**: Gray track, blue fill, percentage label
- **AppIcon**: 3 sizes (40/56/80px), rounded corners, letter fallback
- **Nav active state**: `bg-blue-50 text-blue-700` (sidebar), `text-blue-600` (mobile)

## Frontend Cleanup Rules

These rules prevent the codebase from becoming messy after merging PRs. Enforce them on every change.

### Mount-Effect Guards (`mountedRef`)

A `mountedRef` that is only cleared on cleanup mutes itself forever under React
StrictMode (dev): the mount cycle runs setup → cleanup → setup, and the first
cleanup's `false` survives into the second run. **Re-arm it in setup**:

```ts
useEffect(() => {
  mountedRef.current = true;
  return () => {
    mountedRef.current = false;
  };
}, []);
```

Symptom when forgotten: every settled promise guards on `!mountedRef.current`
and returns without touching state, so async work hangs mid-flight (the search
page's bare-App-ID probe stayed on 正在确认 forever). Unit tests do not run
StrictMode — cover the pattern with a StrictMode-wrapped render test.

### `transition-colors` Usage Policy

**Problem**: `transition-colors` on static containers (cards, sections, alerts, badges) causes visible color flashing when the page loads in dark mode — the element briefly renders in light colors then transitions to dark.

**Rule**: Only use `transition-colors` on **interactive elements** that change color on user interaction:

- Buttons (hover state)
- Links (hover state)
- Form inputs and selects (focus state)
- Nav items (hover/active state)

**Never use `transition-colors` on**:

- Card containers (`bg-white dark:bg-gray-900 rounded-lg border ...`)
- Section wrappers (`<section>` with background)
- Alert/warning banners (use the `<Alert>` component)
- Badge pills
- ProgressBar tracks
- Modal containers
- AppIcon fallback containers
- Empty state placeholder containers

**Exception**: Layout chrome (Sidebar, MobileNav, MobileHeader, PageContainer) may keep `transition-colors duration-200` for smooth theme toggle animation, since these persist across navigations.

### Shared Icons

All navigation and theme icons live in `components/common/icons.tsx`. When Sidebar, MobileNav, or MobileHeader need icons, import from there. Never duplicate icon SVG components inline.

### Import Ordering Verification

Before merging any frontend PR, verify imports follow the convention in every changed file:

```
1. React / library imports
2. Layout components
3. Common components
4. Sibling components (same feature folder)
5. Hooks / stores
6. Apple protocol / API modules
7. Utilities
8. Config
9. Types (always last)
```

### Empty State Containers

Empty states (shown when a list has no items) use a consistent pattern:

- `border-2 border-dashed` (not solid border)
- `bg-gray-50 dark:bg-gray-900/30` background
- No `transition-colors` (removed to prevent dark mode flashing)
- Centered icon in a white circle, title, description, optional CTA button

### Dark Mode Color Pairings

Always pair light and dark variants consistently:

- **Primary text**: `text-gray-900 dark:text-white`
- **Secondary text**: `text-gray-600 dark:text-gray-400` or `text-gray-500 dark:text-gray-400`
- **Tertiary text**: `text-gray-400 dark:text-gray-500`
- **Card background**: `bg-white dark:bg-gray-900`
- **Page background**: `bg-gray-50 dark:bg-gray-950`
- **Card border**: `border-gray-200 dark:border-gray-800`
- **Input border**: `border-gray-300 dark:border-gray-700`

### Code Duplication Prevention

When the same UI pattern appears in 3+ components, extract it to `components/common/`. Current shared components:

- `Alert`, `Modal`, `Spinner`, `CountrySelect`, `AppIcon`, `Badge`, `ProgressBar`, `icons`

When adding new common components, update this AGENTS.md file accordingly.

### Authenticated API Downloads

**Problem**: Plain `<a href="/api/...">` tags and `window.open("/api/...")` make regular browser navigations that cannot carry custom HTTP headers. When `ACCESS_PASSWORD` is set, the `accessAuth` middleware requires an `X-Access-Token` header, so these requests fail with 401.

**Rule**: Never use `<a href>` or `window.open` for `/api/` endpoints that require authentication. Instead, use `fetch()` with `authHeaders()` from `api/client.ts`, then trigger a download via blob URL:

```tsx
const res = await fetch(url, { headers: authHeaders() });
const blob = await res.blob();
const blobUrl = URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = blobUrl;
a.download = filename;
a.click();
URL.revokeObjectURL(blobUrl);
```

**Exceptions**: Routes that the backend explicitly skips auth for (`/auth/*`, `/install/*`) may use plain links — e.g., `itms-services://` install URLs are fine since `/install/*` is public.
