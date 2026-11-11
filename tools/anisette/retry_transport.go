package main

import (
	"io"
	"net/http"
	"time"
)

// Apple's restore-image CDN occasionally answers a burst of range reads with
// 403 or 429. The asset reader treats every non-206 as fatal, so a single
// throttled response would otherwise abort a first-run extraction. Retrying
// idempotent requests here keeps that policy inside the helper instead of
// copying Apple's extractor.
type retryingTransport struct {
	base http.RoundTripper
}

func (t *retryingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		return t.base.RoundTrip(request)
	}

	if request.Header.Get("User-Agent") == "" {
		request.Header.Set("User-Agent", storeUserAgent)
	}

	var lastResponse *http.Response
	var lastError error

	for attempt := 0; attempt < 5; attempt++ {
		response, err := t.base.RoundTrip(request.Clone(request.Context()))
		if err == nil && !retryableAssetStatus(response.StatusCode) {
			return response, nil
		}

		lastResponse = response
		lastError = err

		if attempt == 4 {
			break
		}

		if response != nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			lastResponse = nil
		}

		delay := time.Duration(1<<attempt) * 2 * time.Second
		select {
		case <-time.After(delay):
		case <-request.Context().Done():
			return nil, request.Context().Err()
		}
	}

	return lastResponse, lastError
}

func retryableAssetStatus(status int) bool {
	return status == http.StatusForbidden ||
		status == http.StatusTooManyRequests ||
		status >= http.StatusInternalServerError
}

func installRetryingTransport() {
	if _, ok := http.DefaultTransport.(*retryingTransport); ok {
		return
	}
	http.DefaultTransport = &retryingTransport{base: http.DefaultTransport}
}
