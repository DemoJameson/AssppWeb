/**
 * The current Configurator user agent Apple expects for Store authentication,
 * purchases, and download-product requests (ipatool 2.8.0). Search and lookup
 * keep the older default in the frontend; only credential-bearing Store calls
 * use this one.
 */
export const STORE_USER_AGENT =
  "Configurator/2.21 (Macintosh; OS X 27.0.1; 26A434) AppleWebKit/0625.2.5.11.6";
