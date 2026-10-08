/**
 * The store platforms Apple distinguishes, mirroring ipatool's `Platform`
 * (pkg/appstore/platform.go). iOS is the default everywhere.
 */
export type Platform = "ios" | "ipad" | "tvos" | "visionos" | "macos";

export interface Software {
  /**
   * The App Store app id (ipatool's `App.ID`) — what identifies the app to Apple,
   * and the only field a download strictly requires.
   */
  id: number;
  /**
   * May be empty for a by-ID download, which does not know it up front: the layout
   * keys off `id`, and the bundle id is read from the finished package.
   */
  bundleID: string;
  name: string;
  version: string;
  price?: number;
  artistName: string;
  sellerName: string;
  description: string;
  averageUserRating: number;
  userRatingCount: number;
  artworkUrl: string;
  screenshotUrls: string[];
  minimumOsVersion: string;
  fileSizeBytes?: string;
  releaseDate: string;
  releaseNotes?: string;
  formattedPrice?: string;
  primaryGenreName: string;
  /**
   * Which store platform the app is meant for; drives the search/lookup entity and
   * the version pin. Absent on by-ID downloads until the catalogue or user names one.
   */
  platform?: Platform;
  /** Apple's external version identifier, read from the compiled package. */
  externalVersionId?: string;
  /** Where the record came from: `store` (Apple) or `local` (the package-app index). */
  metadataSource?: "store" | "local" | "bare";
}

export interface Cookie {
  name: string;
  value: string;
  path: string;
  domain?: string;
  expiresAt?: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface Account {
  email: string;
  password: string;
  appleId: string;
  store: string;
  firstName: string;
  lastName: string;
  passwordToken: string;
  directoryServicesIdentifier: string;
  cookies: Cookie[];
  deviceIdentifier: string;
  pod?: string;
}

export interface Sinf {
  id: number;
  sinf: string; // base64
}

export interface DownloadOutput {
  downloadURL: string;
  sinfs: Sinf[];
  bundleShortVersionString: string;
  bundleVersion: string;
  /** Apple's bundle identifier; lets a by-ID download still produce a usable manifest. */
  bundleID?: string;
  /**
   * External version id of the build Apple served. The backend records it as the
   * app+platform's last-known pin, which keeps delisted apps queryable.
   */
  externalVersionId?: string;
  /**
   * Base64 `dpInfo`, sent only on a macOS download: the packages it serves there are
   * encrypted, and this is the key material the server's decrypter uses.
   */
  dpInfo?: string;
  iTunesMetadata?: string;
}

export interface VersionMetadata {
  displayVersion: string;
  /**
   * Empty when no date is vouched for: the exchange's value dates the *app*, not the
   * version.
   */
  releaseDate: string;
  /**
   * Where the date came from: `package` (this instance's compiled package),
   * `package-read` (a package read at a client-supplied URL the server cannot
   * attest), or `client` (Apple's exchange, dating the *app* not the build). Pickers
   * print a date only for the two package sources.
   */
  source?: "package" | "package-read" | "client";
}

export interface DownloadTask {
  id: string;
  software: Software;
  accountHash: string;
  status:
    | "pending"
    | "downloading"
    | "paused"
    | "injecting"
    | "completed"
    | "failed";
  progress: number;
  speed: string;
  error?: string;
  hasFile?: boolean;
  /** Set when the compiled package carried an icon the backend can serve. */
  hasIcon?: boolean;
  createdAt: string;
}

export interface PackageInfo {
  id: string;
  software: Software;
  accountHash: string;
  fileSize: number;
  createdAt: string;
}
