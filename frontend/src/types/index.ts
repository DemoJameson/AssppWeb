/**
 * The store platforms Apple distinguishes, mirroring ipatool's `Platform`
 * (pkg/appstore/platform.go). iOS is the default everywhere.
 */
export type Platform = "ios" | "ipad" | "tvos" | "visionos" | "macos";

export interface Software {
  /**
   * The App Store app id (ipatool's `App.ID`). It is what identifies the app to
   * Apple, and the only field a download strictly requires.
   */
  id: number;
  /**
   * May be empty: a download created from a bare app id (the manual download
   * page) does not know it up front. The layout then keys off `id`, and the
   * bundle identifier is read out of the finished package.
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
   * Which store platform the app is meant for. Drives the search entity, the
   * lookup entity and the version pin; absent on manual downloads until the
   * catalogue or the user names a platform.
   */
  platform?: Platform;
  /** Apple's external version identifier, read from the compiled package. */
  externalVersionId?: string;
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
  /**
   * Apple's bundle identifier for the item. Lets a download created without
   * storefront metadata (manual download) still produce a usable manifest.
   */
  bundleID?: string;
  iTunesMetadata?: string;
}

export interface VersionMetadata {
  displayVersion: string;
  releaseDate: string;
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
