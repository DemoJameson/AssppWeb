package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/majd/ipatool/v2/internal/sap/assets"
)

func TestHealthReportsBundleReadiness(t *testing.T) {
	helper := &server{}
	read := func() map[string]any {
		recorder := httptest.NewRecorder()
		helper.handleHealth(
			recorder,
			httptest.NewRequest(http.MethodGet, "/health", nil),
		)

		var body map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode health response: %v", err)
		}

		return body
	}

	if body := read(); body["bundleReady"] != false {
		t.Errorf("bundleReady = %v before the bundle loads, want false", body["bundleReady"])
	}

	helper.bundleLoaded.Store(true)
	if body := read(); body["bundleReady"] != true {
		t.Errorf("bundleReady = %v after the bundle loads, want true", body["bundleReady"])
	}
}

func TestBundleLoadOutlivesRequestContext(t *testing.T) {
	previousLoad := loadAppleAssets
	defer func() { loadAppleAssets = previousLoad }()

	release := make(chan struct{})
	started := make(chan struct{})
	calls := 0
	loadAppleAssets = func(context.Context) (assets.Bundle, error) {
		calls++
		close(started)
		<-release
		return assets.Bundle{Commerce: []byte("bundle")}, nil
	}

	helper := &server{}
	shortCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	waited := make(chan error, 1)
	go func() {
		_, err := helper.loadBundle(shortCtx)
		waited <- err
	}()
	<-started
	cancel()
	if err := <-waited; !errors.Is(err, context.Canceled) {
		t.Fatalf("loadBundle(canceled context) error = %v, want context canceled", err)
	}
	if calls != 1 {
		t.Fatalf("assets loader calls = %d, want 1", calls)
	}

	close(release)
	bundle, err := helper.loadBundle(context.Background())
	if err != nil {
		t.Fatalf("loadBundle after release: %v", err)
	}
	if string(bundle.Commerce) != "bundle" {
		t.Fatalf("bundle.Commerce = %q, want bundle", bundle.Commerce)
	}
	if calls != 1 {
		t.Fatalf("assets loader calls = %d, want the cancelled wait to keep the load", calls)
	}
	if !helper.bundleLoaded.Load() {
		t.Fatal("health readiness was not set after the background load completed")
	}
}

func TestIsAppleAuthEndpoint(t *testing.T) {
	valid := []string{
		"https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
		"https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/",
		"https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=aabbccddeeff",
		"https://auth.itunes.apple.com/auth/v1/native/fast/",
		"https://auth.itunes.apple.com/auth/v1/native",
	}
	for _, endpoint := range valid {
		if !isAppleAuthEndpoint(endpoint) {
			t.Errorf("expected auth endpoint %q to be accepted", endpoint)
		}
	}

	invalid := []string{
		"http://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
		"https://evil.example/WebObjects/MZFinance.woa/wa/authenticate",
		"https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/other",
		"https://auth.itunes.apple.com/auth/v1/other",
		"https://user:" + "credential" + "@buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
	}
	for _, endpoint := range invalid {
		if isAppleAuthEndpoint(endpoint) {
			t.Errorf("expected auth endpoint %q to be rejected", endpoint)
		}
	}
}

func TestIsAllowedStoreEndpoint(t *testing.T) {
	valid := []string{
		"https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=aabbccddeeff",
		"https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=aabbccddeeff",
		"https://p30-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=aabbccddeeff&Pod=30",
		"https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download?guid=aabbccddeeff",
		"https://downloaddispatch.itunes.apple.com/r/redownload?guid=aabbccddeeff",
		"https://downloaddispatch.itunes.apple.com/up/updateProduct?guid=aabbccddeeff",
	}
	for _, endpoint := range valid {
		if !isAllowedStoreEndpoint(endpoint) {
			t.Errorf("expected store endpoint %q to be accepted", endpoint)
		}
	}

	invalid := []string{
		"https://downloaddispatch.itunes.apple.com/r/redownload",
		"https://downloaddispatch.itunes.apple.com/r/redownload?guid=aabbccddeeff&x=1",
		"https://downloaddispatch.itunes.apple.com/r/redownload?guid=aabbccddeeff&Pod=",
		"https://downloaddispatch.itunes.apple.com/other?guid=aabbccddeeff",
		"https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/other?guid=aabbccddeeff",
		"https://evil.example/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=aabbccddeeff",
	}
	for _, endpoint := range invalid {
		if isAllowedStoreEndpoint(endpoint) {
			t.Errorf("expected store endpoint %q to be rejected", endpoint)
		}
	}
}

func TestAuthHeadersFromAnisette(t *testing.T) {
	headers := http.Header{
		"X-Apple-I-Md":       []string{"otp"},
		"X-Apple-I-Md-M":     []string{"machine"},
		"X-Apple-I-Md-Rinfo": []string{"1"},
		"X-Mme-Device-Id":    []string{"device"},
	}

	got := authHeadersFromAnisette(headers)
	if got["X-Apple-AMD"] != "otp" {
		t.Errorf("X-Apple-AMD = %q, want otp", got["X-Apple-AMD"])
	}
	if got["X-Apple-AMD-M"] != "machine" {
		t.Errorf("X-Apple-AMD-M = %q, want machine", got["X-Apple-AMD-M"])
	}
	if got["X-Apple-I-Md-Rinfo"] != "1" {
		t.Errorf("X-Apple-I-Md-Rinfo = %q, want 1", got["X-Apple-I-Md-Rinfo"])
	}
}

func TestIdentityHeadersStripMachineValues(t *testing.T) {
	got := identityHeaders(map[string]string{
		"X-Apple-AMD":        "otp",
		"X-Apple-AMD-M":      "machine",
		"X-Apple-I-MD-RINFO": "1",
		"X-Mme-Device-Id":    "device",
		"X-Apple-Locale":     "en_US",
		"Cookie":             "must-not-pass",
		"X-Token":            "must" + "-not-pass",
		"X-Dsid":             "must-not-pass",
	})

	if got.Get("X-Apple-AMD") != "" || got.Get("X-Apple-AMD-M") != "" ||
		got.Get("X-Apple-I-MD-RINFO") != "" || got.Get("Cookie") != "" ||
		got.Get("X-Token") != "" || got.Get("X-Dsid") != "" {
		t.Fatalf("non-identity headers were not stripped: %#v", got)
	}
	if got.Get("X-Mme-Device-Id") != "device" || got.Get("X-Apple-Locale") != "en_US" {
		t.Fatalf("identity headers were lost: %#v", got)
	}
}

func TestDecodeHardwareID(t *testing.T) {
	got, err := decodeHardwareID("AABBCCDDEEFF")
	if err != nil || len(got) != 6 {
		t.Fatalf("decodeHardwareID = %x, %v", got, err)
	}

	for _, value := range []string{"", "aabbcc", "aabbccddeeff00", "zzzzzzzzzzzz"} {
		if _, err := decodeHardwareID(value); err == nil {
			t.Errorf("expected %q to be rejected", value)
		}
	}
}

func TestNormalizeHeaderMapPreservesAMDCasing(t *testing.T) {
	got := normalizeHeaderMap(map[string]string{
		"x-apple-amd":   "otp",
		"x-apple-amd-m": "machine",
	})
	if got["X-Apple-AMD"] != "otp" || got["X-Apple-AMD-M"] != "machine" {
		t.Fatalf("normalizeHeaderMap = %#v", got)
	}
}

func TestAuthHeadersForFamily(t *testing.T) {
	headers := http.Header{
		"X-Apple-I-Md":       []string{"otp"},
		"X-Apple-I-Md-M":     []string{"machine"},
		"X-Apple-I-Md-Rinfo": []string{"1"},
		"X-Mme-Device-Id":    []string{"device"},
	}

	md := authHeadersForFamily(headers, familyMD)
	if md["X-Apple-MD"] != "otp" || md["X-Apple-MD-M"] != "machine" {
		t.Fatalf("MD headers = %#v", md)
	}

	amd := authHeadersForFamily(headers, familyAMD)
	if amd["X-Apple-AMD"] != "otp" || amd["X-Apple-AMD-M"] != "machine" {
		t.Fatalf("AMD headers = %#v", amd)
	}
}

func TestNormalizeHeaderMapPreservesMDCasing(t *testing.T) {
	got := normalizeHeaderMap(map[string]string{
		"x-apple-md":   "otp",
		"x-apple-md-m": "machine",
	})
	if got["X-Apple-MD"] != "otp" || got["X-Apple-MD-M"] != "machine" {
		t.Fatalf("normalizeHeaderMap = %#v", got)
	}
}

func TestFamilyForRequest(t *testing.T) {
	amd, err := familyForRequest("", nil)
	if err != nil || amd != familyAMD {
		t.Fatalf("empty family = %q, %v", amd, err)
	}

	md, err := familyForRequest("MD", nil)
	if err != nil || md != familyMD {
		t.Fatalf("explicit family = %q, %v", md, err)
	}

	state, err := json.Marshal(anisetteState{
		Identifier: make([]byte, 16),
		Family:     familyMD,
	})
	if err != nil {
		t.Fatal(err)
	}
	fromState, err := familyForRequest("", state)
	if err != nil || fromState != familyMD {
		t.Fatalf("state family = %q, %v", fromState, err)
	}

	if _, err := familyForRequest("other", nil); err == nil {
		t.Fatal("expected an invalid family to be rejected")
	}
}

func TestIsAllowedProvisioningURL(t *testing.T) {
	valid := []string{
		"https://auth.itunes.apple.com/auth/v1/otp/1.5/finish",
		"https://auth.itunes.apple.com/auth/v1/otp/1.0/finish",
		"https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/finishMachineProvisioning",
		"https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/finishMachineProvisioning",
	}
	for _, endpoint := range valid {
		if !isAllowedProvisioningURL(endpoint) {
			t.Errorf("expected provisioning URL %q to be accepted", endpoint)
		}
	}

	invalid := []string{
		"http://auth.itunes.apple.com/auth/v1/otp/1.5/finish",
		"https://evil.example/auth/v1/otp/1.5/finish",
		"https://auth.itunes.apple.com/auth/v1/otp/1.5/finish?x=1",
		"https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
	}
	for _, endpoint := range invalid {
		if isAllowedProvisioningURL(endpoint) {
			t.Errorf("expected provisioning URL %q to be rejected", endpoint)
		}
	}
}

func TestIsAllowedCommerceEndpoint(t *testing.T) {
	valid := []string{
		"https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct",
		"https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct",
		"https://downloaddispatch.itunes.apple.com/r/redownload?guid=aabbccddeeff",
	}
	for _, endpoint := range valid {
		if !isAllowedCommerceEndpoint(endpoint) {
			t.Errorf("expected commerce URL %q to be accepted", endpoint)
		}
	}

	invalid := []string{
		"https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct?guid=aabbccddeeff",
		"https://evil.example/WebObjects/MZFinance.woa/wa/buyProduct",
	}
	for _, endpoint := range invalid {
		if isAllowedCommerceEndpoint(endpoint) {
			t.Errorf("expected commerce URL %q to be rejected", endpoint)
		}
	}
}
