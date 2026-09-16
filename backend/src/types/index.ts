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
