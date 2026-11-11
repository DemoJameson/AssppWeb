package main

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/majd/ipatool/v2/internal/sap/assets"
	"github.com/majd/ipatool/v2/internal/sap/machine"
	"github.com/majd/ipatool/v2/internal/sap/unicorn"
	"github.com/majd/ipatool/v2/internal/storeauth"
)

const (
	maxBodyBytes = 2 << 20
	// The first asset load may fetch Apple's restore image and every SAP file.
	// It is deliberately decoupled from a proof request's short deadline: a
	// proof may give up waiting, but the load itself must finish and be cached.
	bundleLoadTimeout = 10 * time.Minute
	// Apple Store otp/1.5 provisioning endpoint; the challenge in the auth
	// response tells us when to use it.
	storeProvisioningURL = "https://auth.itunes.apple.com/auth/v1/otp/1.5/finish"
	// The MD family's current bag value. Kept as the fallback when a caller
	// cannot supply the bag's md-finish-provisioning URL.
	storeProvisioningURLMD = "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/finishMachineProvisioning"
	// The current Configurator user agent used by ipatool 2.8.0 for Store
	// authentication, provisioning, purchases, and download requests.
	storeUserAgent = "Configurator/2.21 (Macintosh; OS X 27.0.1; 26A434) AppleWebKit/0625.2.5.11.6"
)

var buyHostPattern = regexp.MustCompile(`^p[0-9]+-buy\.itunes\.apple\.com$`)

var loadAppleAssets = assets.Load

type bundleLoadState struct {
	done chan struct{}
	err  error
}

type server struct {
	token      string
	httpClient *http.Client

	bundleMu    sync.Mutex
	bundle      assets.Bundle
	bundleReady bool
	bundleLoad  *bundleLoadState
	// bundleLoaded mirrors bundleReady for lock-free health reads: the first
	// asset load can run for minutes while bundleMu is only held briefly.
	bundleLoaded atomic.Bool

	prepared bool

	// Apple's ADI/FairPlay guests hold process-global state and hundreds of
	// megabytes of heap. One proof at a time keeps that bounded; callers wait
	// instead of opening a second set of machines.
	proofMu sync.Mutex
	// Warming assets and the Unicorn runtime does not touch a guest, so it must
	// not hold proofMu: a login arriving during prepare would otherwise wait
	// behind the whole asset load.
	prepareMu sync.Mutex
}

type authHeadersRequest struct {
	DeviceIdentifier string `json:"deviceIdentifier"`
	State            string `json:"state,omitempty"`
	AuthEndpoint     string `json:"authEndpoint,omitempty"`
	Family           string `json:"family,omitempty"`
}

type authActionRequest struct {
	DeviceIdentifier string            `json:"deviceIdentifier"`
	State            string            `json:"state"`
	Action           string            `json:"action"`
	Data             string            `json:"data,omitempty"`
	AuthEndpoint     string            `json:"authEndpoint"`
	IdentityHeaders  map[string]string `json:"identityHeaders,omitempty"`
	Family           string            `json:"family,omitempty"`
	FinishURL        string            `json:"finishUrl,omitempty"`
}

type storeProofRequest struct {
	DeviceIdentifier string `json:"deviceIdentifier"`
	State            string `json:"state"`
	Endpoint         string `json:"endpoint"`
	Family           string `json:"family,omitempty"`
}

type headersResponse struct {
	State       string            `json:"state"`
	Headers     map[string]string `json:"headers"`
	Provisioned bool              `json:"provisioned,omitempty"`
	Family      string            `json:"family,omitempty"`
}

type actionResponse struct {
	State              string            `json:"state"`
	Headers            map[string]string `json:"headers,omitempty"`
	DropMachineHeaders bool              `json:"dropMachineHeaders,omitempty"`
	Family             string            `json:"family,omitempty"`
}

func runServe(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	defaultListen := os.Getenv("ANISETTE_LISTEN")
	if defaultListen == "" {
		defaultListen = "127.0.0.1:8791"
	}
	listen := flags.String("listen", defaultListen, "loopback address to listen on")
	if err := flags.Parse(args); err != nil {
		return err
	}

	if err := validateLoopback(*listen); err != nil {
		return err
	}

	token := os.Getenv("ANISETTE_HELPER_TOKEN")
	if token == "" {
		log.Print("warning: ANISETTE_HELPER_TOKEN is empty; any local process can call this helper")
	}

	client := storeauth.NewHTTPClient(nil)
	client.Timeout = 2 * time.Minute
	// Install after NewHTTPClient: that constructor clones http.DefaultTransport
	// and expects a concrete *http.Transport. Provisioning POSTs must not be
	// retried by the asset transport; only idempotent range reads are.
	installRetryingTransport()

	helper := &server{token: token, httpClient: client}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", helper.handleHealth)
	mux.HandleFunc("/v1/prepare", helper.handlePrepare)
	mux.HandleFunc("/v1/auth/headers", helper.handleAuthHeaders)
	mux.HandleFunc("/v1/auth/action", helper.handleAuthAction)
	mux.HandleFunc("/v1/store/proof", helper.handleStoreProof)

	httpServer := &http.Server{
		Addr:              *listen,
		Handler:           helper.authenticate(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Printf("anisette helper listening on %s", *listen)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve anisette helper: %w", err)
	}

	return nil
}

func validateLoopback(listen string) error {
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: %w", listen, err)
	}

	if host == "localhost" {
		return nil
	}

	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("anisette helper must listen on loopback, got %q", listen)
	}

	return nil
}

func (s *server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" || s.token == "" {
			next.ServeHTTP(w, r)
			return
		}

		presented := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if presented == "" {
			presented = strings.TrimSpace(r.Header.Get("X-Anisette-Token"))
		}

		if subtle.ConstantTimeCompare([]byte(presented), []byte(s.token)) != 1 {
			writeError(w, http.StatusUnauthorized, "invalid helper token")
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"bundleReady": s.bundleLoaded.Load(),
	})
}

func (s *server) handlePrepare(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()

	s.prepareMu.Lock()
	defer s.prepareMu.Unlock()

	if s.prepared {
		writeJSON(w, http.StatusOK, map[string]any{"ready": true})
		return
	}

	if _, err := s.loadBundle(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("load Apple assets: %v", err))
		return
	}

	engine, err := unicorn.New(ctx)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("load Unicorn runtime: %v", err))
		return
	}
	if err := engine.Close(); err != nil {
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("close Unicorn runtime: %v", err))
		return
	}

	s.prepared = true

	writeJSON(w, http.StatusOK, map[string]any{"ready": true})
}

func (s *server) handleAuthHeaders(w http.ResponseWriter, r *http.Request) {
	var request authHeadersRequest
	if err := decodeJSON(w, r, &request); err != nil {
		return
	}

	hardwareID, err := decodeHardwareID(request.DeviceIdentifier)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()

	bundle, err := s.loadBundle(ctx)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("load Apple assets: %v", err))
		return
	}

	state := []byte(request.State)
	family, err := familyForRequest(request.Family, state)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	s.proofMu.Lock()
	defer s.proofMu.Unlock()

	// A provisioned state can mint a fresh Store proof without repeating GSA
	// machine provisioning. If it cannot, fall back to the general Anisette
	// flow, which is what a new device or an expired state needs.
	if len(state) != 0 && request.AuthEndpoint != "" {
		if !isAppleAuthEndpoint(request.AuthEndpoint) {
			writeError(w, http.StatusBadRequest, "auth endpoint is not an Apple authentication URL")
			return
		}

		var headers map[string]string
		var updated []byte
		var proofErr error
		if family == familyMD {
			headers, updated, proofErr = loadStoreMDHeaders(ctx, bundle, state)
		} else {
			headers, updated, proofErr = loadStoreAMDHeaders(ctx, bundle, state, request.AuthEndpoint, hardwareID)
		}
		if proofErr == nil {
			writeJSON(w, http.StatusOK, headersResponse{
				State:       string(updated),
				Headers:     normalizeHeaderMap(headers),
				Provisioned: true,
				Family:      family,
			})
			return
		}
		log.Printf("existing Anisette state could not mint a Store proof; reprovisioning: %v", proofErr)
	}

	headers, updated, err := loadAnisetteHeaders(ctx, s.httpClient, bundle, state, family)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("prepare Apple machine validation: %v", err))
		return
	}

	writeJSON(w, http.StatusOK, headersResponse{
		State:   string(updated),
		Headers: authHeadersForFamily(headers, family),
		Family:  family,
	})
}

func (s *server) handleAuthAction(w http.ResponseWriter, r *http.Request) {
	var request authActionRequest
	if err := decodeJSON(w, r, &request); err != nil {
		return
	}

	hardwareID, err := decodeHardwareID(request.DeviceIdentifier)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	family, err := familyForRequest(request.Family, []byte(request.State))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	switch strings.ToUpper(strings.TrimSpace(request.Action)) {
	case "RP":
		writeJSON(w, http.StatusOK, actionResponse{
			State:              request.State,
			DropMachineHeaders: true,
			Family:             family,
		})
		return
	case "SP":
		// Continue below.
	default:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unsupported Apple machine action %q", request.Action))
		return
	}

	if request.State == "" {
		writeError(w, http.StatusBadRequest, "Anisette state is required for SP provisioning")
		return
	}
	if request.Data == "" {
		writeError(w, http.StatusBadRequest, "Apple provisioning data is required for SP")
		return
	}
	if !isAllowedProofEndpoint(request.AuthEndpoint) {
		writeError(w, http.StatusBadRequest, "proof endpoint is not an allowlisted Apple URL")
		return
	}

	finishURL := strings.TrimSpace(request.FinishURL)
	if finishURL == "" {
		finishURL = storeProvisioningURL
		if family == familyMD {
			finishURL = storeProvisioningURLMD
		}
	}
	if !isAllowedProvisioningURL(finishURL) {
		writeError(w, http.StatusBadRequest, "finish URL is not an allowlisted Apple provisioning URL")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()

	bundle, err := s.loadBundle(ctx)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("load Apple assets: %v", err))
		return
	}

	s.proofMu.Lock()
	defer s.proofMu.Unlock()

	kbsync := ""
	if family == familyAMD {
		kbsyncBytes, err := machine.GenerateKBSync(ctx, bundle, hardwareID, ^uint64(1))
		if err != nil {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("generate Store provisioning kbsync: %v", err))
			return
		}
		kbsync = base64.StdEncoding.EncodeToString(kbsyncBytes)
	}

	identity := identityHeaders(request.IdentityHeaders)

	updated, err := provisionStoreAnisette(
		ctx,
		s.httpClient,
		bundle,
		[]byte(request.State),
		request.Data,
		finishURL,
		storeUserAgent,
		kbsync,
		strings.ToUpper(strings.TrimSpace(request.DeviceIdentifier)),
		hardwareID,
		identity,
		family,
	)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("complete Apple Store provisioning: %v", err))
		return
	}

	var headers map[string]string
	var finalState []byte
	if family == familyMD {
		headers, finalState, err = loadStoreMDHeaders(ctx, bundle, updated)
	} else {
		headers, finalState, err = loadStoreAMDHeaders(ctx, bundle, updated, request.AuthEndpoint, hardwareID)
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("prepare Apple Store proof: %v", err))
		return
	}

	writeJSON(w, http.StatusOK, actionResponse{
		State:   string(finalState),
		Headers: normalizeHeaderMap(headers),
		Family:  family,
	})
}

func (s *server) handleStoreProof(w http.ResponseWriter, r *http.Request) {
	var request storeProofRequest
	if err := decodeJSON(w, r, &request); err != nil {
		return
	}

	hardwareID, err := decodeHardwareID(request.DeviceIdentifier)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if request.State == "" {
		writeError(w, http.StatusBadRequest, "Anisette state is required for a Store proof")
		return
	}
	if !isAllowedCommerceEndpoint(request.Endpoint) {
		writeError(w, http.StatusBadRequest, "endpoint is not an allowlisted Apple commerce URL")
		return
	}
	family, err := familyForRequest(request.Family, []byte(request.State))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()

	bundle, err := s.loadBundle(ctx)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("load Apple assets: %v", err))
		return
	}

	s.proofMu.Lock()
	defer s.proofMu.Unlock()

	var headers map[string]string
	var updated []byte
	if family == familyMD {
		headers, updated, err = loadStoreMDHeaders(ctx, bundle, []byte(request.State))
	} else {
		headers, updated, err = loadStoreAMDHeaders(ctx, bundle, []byte(request.State), request.Endpoint, hardwareID)
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("prepare Apple Store proof: %v", err))
		return
	}

	writeJSON(w, http.StatusOK, headersResponse{
		State:   string(updated),
		Headers: normalizeHeaderMap(headers),
		Family:  family,
	})
}

func (s *server) loadBundle(ctx context.Context) (assets.Bundle, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return assets.Bundle{}, err
	}

	s.bundleMu.Lock()
	if s.bundleReady {
		bundle := s.bundle
		s.bundleMu.Unlock()
		return bundle, nil
	}

	load := s.bundleLoad
	if load == nil {
		load = &bundleLoadState{done: make(chan struct{})}
		s.bundleLoad = load
		go s.loadBundleInBackground(load)
	}
	s.bundleMu.Unlock()

	select {
	case <-load.done:
		s.bundleMu.Lock()
		err := load.err
		bundle := s.bundle
		s.bundleMu.Unlock()
		if err != nil {
			return assets.Bundle{}, err
		}
		return bundle, nil
	case <-ctx.Done():
		return assets.Bundle{}, ctx.Err()
	}
}

func (s *server) loadBundleInBackground(load *bundleLoadState) {
	ctx, cancel := context.WithTimeout(context.Background(), bundleLoadTimeout)
	defer cancel()

	bundle, err := loadAppleAssets(ctx)

	s.bundleMu.Lock()
	if err == nil {
		s.bundle = bundle
		s.bundleReady = true
		s.bundleLoaded.Store(true)
	}
	load.err = err
	if s.bundleLoad == load {
		s.bundleLoad = nil
	}
	close(load.done)
	s.bundleMu.Unlock()
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any) error {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST is required")
		return errors.New("method not allowed")
	}

	decoder := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		log.Printf("invalid JSON body: %v", err)
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return err
	}

	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		writeError(w, http.StatusBadRequest, "request body must contain one JSON object")
		return errors.New("trailing request body")
	}

	return nil
}

func decodeHardwareID(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if len(value) != 12 {
		return nil, errors.New("deviceIdentifier must be 12 hex characters")
	}

	decoded, err := hex.DecodeString(value)
	if err != nil {
		return nil, errors.New("deviceIdentifier must be 12 hex characters")
	}

	return decoded, nil
}

func normalizeFamily(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "":
		return "", nil
	case familyAMD:
		return familyAMD, nil
	case familyMD:
		return familyMD, nil
	default:
		return "", fmt.Errorf("unsupported machine family %q", value)
	}
}

func familyForRequest(requested string, encodedState []byte) (string, error) {
	family, err := normalizeFamily(requested)
	if err != nil {
		return "", err
	}
	if family != "" {
		return family, nil
	}
	if len(encodedState) == 0 {
		return familyAMD, nil
	}

	state, err := decodeAnisetteState(encodedState)
	if err != nil || state.Family != familyMD {
		return familyAMD, nil
	}
	return familyMD, nil
}

func authHeadersForFamily(headers http.Header, family string) map[string]string {
	if family == familyMD {
		return authHeadersFromAnisetteMD(headers)
	}
	return authHeadersFromAnisette(headers)
}

func authHeadersFromAnisette(headers http.Header) map[string]string {
	out := make(map[string]string, len(headers))
	for key, values := range headers {
		value := strings.Join(values, ", ")
		switch strings.ToLower(key) {
		case "x-apple-i-md":
			out["X-Apple-AMD"] = value
		case "x-apple-i-md-m":
			out["X-Apple-AMD-M"] = value
		default:
			out[http.CanonicalHeaderKey(key)] = value
		}
	}
	return out
}

func authHeadersFromAnisetteMD(headers http.Header) map[string]string {
	out := make(map[string]string, len(headers))
	for key, values := range headers {
		value := strings.Join(values, ", ")
		switch strings.ToLower(key) {
		case "x-apple-i-md":
			out["X-Apple-MD"] = value
		case "x-apple-i-md-m":
			out["X-Apple-MD-M"] = value
		default:
			out[http.CanonicalHeaderKey(key)] = value
		}
	}
	return out
}

func normalizeHeaderMap(headers map[string]string) map[string]string {
	out := make(map[string]string, len(headers))
	for key, value := range headers {
		switch strings.ToLower(key) {
		case "x-apple-amd":
			out["X-Apple-AMD"] = value
		case "x-apple-amd-m":
			out["X-Apple-AMD-M"] = value
		case "x-apple-md":
			out["X-Apple-MD"] = value
		case "x-apple-md-m":
			out["X-Apple-MD-M"] = value
		default:
			out[http.CanonicalHeaderKey(key)] = value
		}
	}
	return out
}

func identityHeaders(values map[string]string) http.Header {
	headers := make(http.Header)
	for key, value := range values {
		if !isIdentityHeader(key) {
			continue
		}
		headers.Set(key, value)
	}
	return headers
}

// Only the credential-free identity fields AnisetteHeaders produces may reach
// the Store provisioning request. A caller must not be able to smuggle a
// cookie, password token, DSID, or Authorization header through this path.
func isIdentityHeader(key string) bool {
	switch strings.ToLower(key) {
	case "x-apple-i-client-time",
		"x-apple-i-md-lu",
		"x-apple-i-srl-no",
		"x-apple-i-timezone",
		"x-apple-locale",
		"x-mme-device-id",
		"x-mme-client-info":
		return true
	default:
		return false
	}
}

func isAppleAuthEndpoint(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" ||
		parsed.RawPath != "" || parsed.Opaque != "" || (parsed.Port() != "" && parsed.Port() != "443") {
		return false
	}

	host := strings.ToLower(parsed.Hostname())
	path := strings.TrimRight(parsed.Path, "/")

	if host == "auth.itunes.apple.com" {
		switch path {
		case "/auth/v1/native", "/auth/v1/native/fast":
			return true
		default:
			return false
		}
	}

	if host != "buy.itunes.apple.com" && !buyHostPattern.MatchString(host) {
		return false
	}

	return path == "/WebObjects/MZFinance.woa/wa/authenticate"
}

func isAllowedProofEndpoint(raw string) bool {
	return isAppleAuthEndpoint(raw) || isAllowedCommerceEndpoint(raw)
}

func isAllowedCommerceEndpoint(raw string) bool {
	return isAllowedStoreEndpoint(raw) || isAllowedBuyProductEndpoint(raw)
}

func isAllowedBuyProductEndpoint(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" ||
		parsed.RawPath != "" || parsed.Opaque != "" || parsed.RawQuery != "" ||
		(parsed.Port() != "" && parsed.Port() != "443") {
		return false
	}

	host := strings.ToLower(parsed.Hostname())
	if host != "buy.itunes.apple.com" && !buyHostPattern.MatchString(host) {
		return false
	}

	return parsed.Path == "/WebObjects/MZFinance.woa/wa/buyProduct"
}

func isAllowedProvisioningURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" ||
		parsed.RawPath != "" || parsed.Opaque != "" || parsed.RawQuery != "" ||
		(parsed.Port() != "" && parsed.Port() != "443") {
		return false
	}

	host := strings.ToLower(parsed.Hostname())
	switch host {
	case "auth.itunes.apple.com":
		switch parsed.Path {
		case "/auth/v1/otp/1.5/finish", "/auth/v1/otp/1.0/finish":
			return true
		}
		return false
	case "buy.itunes.apple.com":
		return parsed.Path == "/WebObjects/MZFinance.woa/wa/finishMachineProvisioning"
	}

	if buyHostPattern.MatchString(host) {
		return parsed.Path == "/WebObjects/MZFinance.woa/wa/finishMachineProvisioning"
	}

	return false
}

func isAllowedStoreEndpoint(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" ||
		parsed.RawPath != "" || parsed.Opaque != "" || (parsed.Port() != "" && parsed.Port() != "443") {
		return false
	}

	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil || parsed.ForceQuery || !isAllowedStoreQuery(query) {
		return false
	}

	host := strings.ToLower(parsed.Hostname())
	if host == "downloaddispatch.itunes.apple.com" {
		switch parsed.Path {
		case "/WebObjects/DownloadDispatch.woa/wa/ent/download",
			"/r/redownload",
			"/up/updateProduct":
			return true
		default:
			return false
		}
	}

	if host != "buy.itunes.apple.com" && !buyHostPattern.MatchString(host) {
		return false
	}

	return parsed.Path == "/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct"
}

// Store requests carry the device GUID plus Apple's optional pod routing
// parameters. The proof is bound to the exact URL, so rejecting an extra
// routing parameter after a redirect would leave the redirected request
// without machine validation.
func isAllowedStoreQuery(query url.Values) bool {
	guid := query["guid"]
	if len(guid) != 1 || guid[0] == "" {
		return false
	}

	for key, values := range query {
		switch key {
		case "guid":
		case "Pod":
			if len(values) != 1 || values[0] == "" {
				return false
			}
		default:
			return false
		}
	}

	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
