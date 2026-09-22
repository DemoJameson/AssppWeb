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
   * May be empty: a download created from a bare app id (the download-by-ID
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
   * Which store platform the app is meant for, as chosen on the search or
   * download form. macOS downloads are .pkg containers, not IPAs, so this also
   * drives the compile pipeline.
   */
  platform?: Platform;
  /** Apple's external version identifier, read from the compiled package. */
  externalVersionId?: string;
  /**
   * Where the record came from: `store` (Apple answered) or `local` (the
   * package-app index — a delisted app recalled from past downloads).
   */
  metadataSource?: "store" | "local";
}

export interface Sinf {
  id: number;
  sinf: string; // base64 encoded
}

export interface DownloadTask {
  id: string;
  software: Software;
  accountHash: string;
  downloadURL: string;
  sinfs: Sinf[];
  iTunesMetadata?: string;
  /**
   * Base64 `dpInfo` Apple answered a macOS download with — the key material
   * its package is decrypted by. Held only for as long as the task needs it
   * (stripped on completion, never persisted, never sent to a client).
   */
  dpInfo?: string;
  /**
   * The hardware id that download was requested with (`guid`), hex encoded.
   * It is the second half of what decryption needs: StoreAgent derives the key
   * from the pair, so the wrong id yields bytes that are still ciphertext.
   */
  hardwareId?: string;
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
  filePath?: string;
  /**
   * Cached answers for the API response, maintained at the few mutation
   * points (completion, icon write/unlink, startup restore) instead of
   * hitting the file system on every list/poll request. Recomputed once at
   * startup, so an externally deleted file stays "present" until restart.
   */
  hasFile?: boolean;
  hasIcon?: boolean;
  createdAt: string;
}

export interface PackageInfo {
  id: string;
  software: Software;
  accountHash: string;
  filePath: string;
  fileSize: number;
  createdAt: string;
}
