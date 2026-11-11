// The provisioning flow below is adapted from ipatool v2.8.0's
// internal/storeauth (MIT, Copyright (c) 2021 Majd Alfhaily). The functional
// change is that the caller supplies an already-loaded assets.Bundle: a
// long-lived helper must not re-read and SHA-256-verify the 167 MB asset set
// for every proof.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/majd/ipatool/v2/internal/sap/assets"
	"github.com/majd/ipatool/v2/internal/sap/machine"
	"github.com/majd/ipatool/v2/internal/store/emulator"
	"github.com/majd/ipatool/v2/internal/store/profile"
	"howett.net/plist"
)

const (
	anisetteLimit      = 1 << 20
	machineDSID        = ^uint64(1)
	machineStartURL    = "https://gsa.apple.com/grandslam/MidService/startMachineProvisioning"
	machineFinishURL   = "https://gsa.apple.com/grandslam/MidService/finishMachineProvisioning"
	anisetteClientInfo = "<MacBookPro13,3> <Mac OS X;10.12.6;16G29> <com.apple.AuthKit/1 (com.apple.akd/1.0)>"
	anisetteUserAgent  = "akd/1.0 CFNetwork/811.5.4 Darwin/16.7.0"

	storeAnisetteDSID = ^uint64(0)
	appleRootURL      = "https://www.apple.com/appleca/AppleIncRootCertificate.cer"
	rootSizeLimit     = 64 << 10

	familyAMD = "amd"
	familyMD  = "md"
)

type anisetteState struct {
	Identifier, Provisioning []byte
	RoutingInfo              uint64
	Family                   string `json:"family,omitempty"`
}

type machineProvisioningEnvelope struct {
	Response map[string]any `plist:"Response"`
}

// loadAnisetteHeaders provisions a local software identity when necessary and
// returns a fresh machine-validation proof.
func loadAnisetteHeaders(ctx context.Context, client *http.Client, bundle assets.Bundle, encoded []byte, family string) (http.Header, []byte, error) {
	if ctx == nil {
		return nil, nil, errors.New("anisette context is nil")
	}
	if client == nil {
		return nil, nil, errors.New("anisette HTTP client is nil")
	}

	state, err := decodeAnisetteState(encoded)
	if err != nil {
		return nil, nil, err
	}

	// Store provisioning replaces the ADI database. If its proof cannot be
	// reused, start general machine provisioning from the persisted identity.
	state.Provisioning = nil
	state.RoutingInfo = 0

	adi, err := machine.OpenModernADI(ctx, bundle, state.Identifier, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("open anisette runtime: %w", err)
	}
	defer func() { _ = adi.Close() }()

	if err = provisionMachine(ctx, client, state, adi); err != nil {
		return nil, nil, err
	}

	mid, otp, err := adi.RequestOTP(machineDSID)
	if err != nil {
		return nil, nil, fmt.Errorf("generate anisette proof: %w", err)
	}

	state.Provisioning, err = adi.State()
	if err != nil {
		return nil, nil, fmt.Errorf("read anisette state: %w", err)
	}
	state.Family = family

	updated, err := json.Marshal(state)
	if err != nil {
		return nil, nil, errors.New("encode anisette state")
	}

	return anisetteHeaders(state, otp, mid), updated, nil
}

func provisionMachine(ctx context.Context, client *http.Client, state *anisetteState, adi *machine.ModernADI) error {
	start, err := sendMachineProvisioning(ctx, client, machineStartURL, state.Identifier, map[string]any{})
	if err != nil {
		return err
	}

	spim, err := decodeProvisioningField(start, "spim")
	if err != nil {
		return err
	}

	cpim, session, err := adi.StartProvisioning(machineDSID, spim)
	if err != nil {
		return fmt.Errorf("start anisette provisioning: %w", err)
	}

	finish, err := sendMachineProvisioning(ctx, client, machineFinishURL, state.Identifier, map[string]any{
		"cpim": base64.StdEncoding.EncodeToString(cpim),
	})
	if err != nil {
		return err
	}

	ptm, err := decodeProvisioningField(finish, "ptm")
	if err != nil {
		return err
	}

	trustKey, err := decodeProvisioningField(finish, "tk")
	if err != nil {
		return err
	}

	routing, err := provisioningString(finish, "X-Apple-I-MD-RINFO")
	if err != nil {
		return err
	}

	state.RoutingInfo, err = strconv.ParseUint(routing, 10, 64)
	if err != nil || state.RoutingInfo == 0 {
		return errors.New("decode anisette routing information")
	}

	if err = adi.EndProvisioning(session, ptm, trustKey); err != nil {
		return fmt.Errorf("finish anisette provisioning: %w", err)
	}

	return nil
}

func sendMachineProvisioning(ctx context.Context, client *http.Client, endpoint string, identifier []byte, values map[string]any) (map[string]any, error) {
	body, err := plist.Marshal(map[string]any{
		"Header":  map[string]any{},
		"Request": values,
	}, plist.XMLFormat)
	if err != nil {
		return nil, errors.New("encode anisette provisioning request")
	}

	localUserID, deviceID := anisetteIdentityHeaders(identifier)
	send := func() (*http.Response, error) {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if requestErr != nil {
			return nil, fmt.Errorf("create anisette provisioning request: %w", requestErr)
		}
		request.Header.Set("Accept", "*/*")
		request.Header.Set("Connection", "close")
		request.Header.Set("Content-Type", "text/x-xml-plist")
		request.Header.Set("User-Agent", anisetteUserAgent)
		request.Header.Set("X-Apple-I-MD-LU", localUserID)
		request.Header.Set("X-MMe-Client-Info", anisetteClientInfo)
		request.Header.Set("X-Mme-Device-Id", deviceID)

		return client.Do(request)
	}

	response, err := send()
	if isUnknownAuthority(err) {
		if rootErr := installAppleRoot(ctx, client); rootErr != nil {
			return nil, fmt.Errorf("install Apple provisioning root: %w", rootErr)
		}

		response, err = send()
	}
	if err != nil {
		return nil, fmt.Errorf("send anisette provisioning request: %w", err)
	}
	defer response.Body.Close()

	data, err := io.ReadAll(io.LimitReader(response.Body, anisetteLimit+1))
	if err != nil {
		return nil, fmt.Errorf("read anisette provisioning response: %w", err)
	}
	if response.StatusCode != http.StatusOK || len(data) > anisetteLimit {
		return nil, fmt.Errorf("anisette provisioning returned HTTP %d", response.StatusCode)
	}

	var envelope machineProvisioningEnvelope
	if _, err = plist.Unmarshal(data, &envelope); err != nil || envelope.Response == nil {
		return nil, errors.New("decode anisette provisioning response")
	}

	return envelope.Response, nil
}

func decodeAnisetteState(encoded []byte) (*anisetteState, error) {
	if len(encoded) == 0 {
		identifier := make([]byte, 16)
		if _, err := rand.Read(identifier); err != nil {
			return nil, fmt.Errorf("generate anisette identity: %w", err)
		}

		return &anisetteState{Identifier: identifier}, nil
	}

	var state anisetteState
	if json.Unmarshal(encoded, &state) != nil || len(state.Identifier) != 16 || len(state.Provisioning) > anisetteLimit {
		return nil, errors.New("invalid persisted anisette state")
	}

	return &state, nil
}

func anisetteHeaders(state *anisetteState, otp, mid []byte) http.Header {
	localUserID, deviceID := anisetteIdentityHeaders(state.Identifier)
	now := time.Now()
	headers := make(http.Header)
	headers.Set("X-Apple-I-Client-Time", now.UTC().Format("2006-01-02T15:04:05Z"))
	headers.Set("X-Apple-I-MD", base64.StdEncoding.EncodeToString(otp))
	headers.Set("X-Apple-I-MD-M", base64.StdEncoding.EncodeToString(mid))
	headers.Set("X-Apple-I-MD-RINFO", strconv.FormatUint(state.RoutingInfo, 10))
	headers.Set("X-Apple-I-MD-LU", localUserID)
	headers.Set("X-Apple-I-SRL-NO", "0")
	headers.Set("X-Apple-I-TimeZone", now.Location().String())
	headers.Set("X-Apple-Locale", "en_US")
	headers.Set("X-Mme-Device-Id", deviceID)
	headers.Set("X-MMe-Client-Info", anisetteClientInfo)

	return headers
}

func anisetteIdentityHeaders(identifier []byte) (string, string) {
	digest := sha256.Sum256(identifier)
	encoded := hex.EncodeToString(identifier)
	deviceID := encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]

	return hex.EncodeToString(digest[:]), deviceID
}

func provisioningString(values map[string]any, key string) (string, error) {
	value, ok := values[key].(string)
	if !ok || !headerValue(value, 32768) {
		return "", fmt.Errorf("missing anisette %s", key)
	}

	return value, nil
}

func decodeProvisioningField(values map[string]any, key string) ([]byte, error) {
	value, err := provisioningString(values, key)
	if err != nil {
		return nil, err
	}

	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(decoded) == 0 || len(decoded) > anisetteLimit {
		return nil, fmt.Errorf("decode anisette %s", key)
	}

	return decoded, nil
}

func headerValue(value string, limit int) bool {
	if value == "" || len(value) > limit {
		return false
	}

	for _, character := range value {
		if character < ' ' || character > '~' {
			return false
		}
	}

	return true
}

// provisionStoreAnisette completes the Store-specific ADI provisioning action
// returned by auth.itunes.apple.com.
func provisionStoreAnisette(ctx context.Context, client *http.Client, bundle assets.Bundle, encoded []byte, challenge, endpoint, userAgent, kbsync, guid string, hardwareID []byte, identity http.Header, family string) ([]byte, error) {
	if client == nil {
		return nil, errors.New("anisette HTTP client is nil")
	}

	state, err := decodeAnisetteState(encoded)
	if err != nil {
		return nil, err
	}

	spim, err := base64.StdEncoding.DecodeString(strings.TrimSpace(challenge))
	if err != nil || len(spim) == 0 || len(spim) > anisetteLimit {
		return nil, errors.New("decode Apple Store provisioning data")
	}

	adi, err := machine.OpenModernADI(ctx, bundle, state.Identifier, nil)
	if err != nil {
		return nil, fmt.Errorf("open local anisette runtime: %w", err)
	}

	defer func() { _ = adi.Close() }()

	cpim, session, err := adi.StartProvisioning(storeAnisetteDSID, spim)
	if err != nil {
		return nil, fmt.Errorf("start Apple Store provisioning: %w", err)
	}

	payload := map[string]any{"clientData": base64.StdEncoding.EncodeToString(cpim)}
	if kbsync != "" {
		payload["kbsync"] = kbsync
	}
	if guid != "" {
		payload["guid"] = guid
	}

	settingValue, transportValue, keyBag, err := finishStoreProvisioning(ctx, client, payload, endpoint, userAgent, identity)
	if err != nil {
		return nil, err
	}

	settingInfo, err := decodeStoreProvisioningValue(settingValue, "settingInfo")
	if err != nil {
		return nil, err
	}

	transportKey, err := decodeStoreProvisioningValue(transportValue, "transportKey")
	if err != nil {
		return nil, err
	}

	if err = adi.EndProvisioning(session, settingInfo, transportKey); err != nil {
		return nil, fmt.Errorf("finish Apple Store provisioning (setting info %d bytes, transport key %d bytes): %w", len(settingInfo), len(transportKey), err)
	}

	if len(keyBag) != 0 {
		if err = adi.ImportKeyBag(hardwareID, keyBag); err != nil {
			return nil, fmt.Errorf("import Apple Store FairPlay keybag: %w", err)
		}
	}

	state.Provisioning, err = adi.State()
	if err != nil {
		return nil, fmt.Errorf("persist Apple Store provisioning: %w", err)
	}
	state.Family = family

	updated, err := json.Marshal(state)
	if err != nil {
		return nil, errors.New("encode anisette state")
	}

	return updated, nil
}

func finishStoreProvisioning(ctx context.Context, client *http.Client, payload map[string]any, endpoint, userAgent string, identity http.Header) (string, string, []byte, error) {
	body, err := plist.Marshal(payload, plist.XMLFormat)
	if err != nil {
		return "", "", nil, errors.New("encode Apple Store provisioning request")
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", "", nil, fmt.Errorf("create Apple Store provisioning request: %w", err)
	}

	for key, values := range identity {
		if !strings.EqualFold(key, "X-Apple-I-MD") && !strings.EqualFold(key, "X-Apple-I-MD-M") && !strings.EqualFold(key, "X-Apple-I-MD-RINFO") {
			request.Header[key] = append([]string(nil), values...)
		}
	}

	request.Header.Set("Accept", "*/*")
	request.Header.Set("Content-Type", "application/x-apple-plist")
	request.Header.Set("User-Agent", userAgent)

	response, err := client.Do(request)
	if err != nil {
		return "", "", nil, fmt.Errorf("send Apple Store provisioning request: %w", err)
	}

	defer response.Body.Close()

	data, err := io.ReadAll(io.LimitReader(response.Body, anisetteLimit+1))
	if err != nil || len(data) > anisetteLimit {
		return "", "", nil, errors.New("read Apple Store provisioning response")
	}

	if response.StatusCode != http.StatusOK {
		return "", "", nil, fmt.Errorf("apple Store provisioning returned HTTP %d", response.StatusCode)
	}

	var result map[string]any
	if _, err = plist.Unmarshal(data, &result); err != nil {
		return "", "", nil, errors.New("decode Apple Store provisioning response")
	}

	settingInfo, ok := result["settingInfo"].(string)
	if !ok || !headerValue(settingInfo, anisetteLimit) {
		return "", "", nil, errors.New("apple Store provisioning response is missing settingInfo")
	}

	transportKey, ok := result["transportKey"].(string)
	if !ok || !headerValue(transportKey, anisetteLimit) {
		return "", "", nil, errors.New("apple Store provisioning response is missing transportKey")
	}

	keyBag, ok := result["keybag"].([]byte)
	if !ok || len(keyBag) == 0 || len(keyBag) > anisetteLimit {
		if encoded, stringOK := result["keybag"].(string); stringOK {
			keyBag, _ = base64.StdEncoding.DecodeString(encoded)
		}
	}

	if len(keyBag) > anisetteLimit {
		return "", "", nil, errors.New("apple Store provisioning response contains an invalid keybag")
	}

	return settingInfo, transportKey, append([]byte(nil), keyBag...), nil
}

func decodeStoreProvisioningValue(value, key string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(decoded) == 0 || len(decoded) > anisetteLimit {
		return nil, fmt.Errorf("decode Apple Store provisioning %s", key)
	}

	return decoded, nil
}

// loadStoreAMDHeaders executes AppleMediaServices' type-2 anisette flow and
// its com.apple.adid dependency entirely inside the pinned Unicorn runtimes.
func loadStoreAMDHeaders(ctx context.Context, bundle assets.Bundle, encoded []byte, endpoint string, hardwareID []byte) (map[string]string, []byte, error) {
	if ctx == nil {
		return nil, nil, errors.New("store AMD context is nil")
	}

	state, err := decodeAnisetteState(encoded)
	if err != nil {
		return nil, nil, err
	}

	if len(state.Provisioning) == 0 {
		return nil, nil, errors.New("store AMD state is not provisioned")
	}

	adi, err := machine.OpenModernADI(ctx, bundle, state.Identifier, state.Provisioning)
	if err != nil {
		return nil, nil, fmt.Errorf("open Store AMD service: %w", err)
	}

	defer func() { _ = adi.Close() }()

	prepared, err := profile.Load(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("load Store AMD framework profile: %w", err)
	}

	framework, err := emulator.Open(ctx, bundle.AppleMediaServices, prepared)
	if err != nil {
		return nil, nil, fmt.Errorf("open Store AMD framework: %w", err)
	}

	defer func() { _ = framework.Close() }()

	headers, err := framework.StoreAMDHeaders(endpoint, hardwareID, func(service string, request []byte) ([]byte, error) {
		if service != "com.apple.adid" {
			return nil, fmt.Errorf("unsupported Store AMD XPC service %s", service)
		}

		return adi.ExchangeXPC(request)
	})
	if err != nil {
		return nil, nil, fmt.Errorf("run Store AMD framework: %w", err)
	}

	state.Provisioning, err = adi.State()
	if err != nil {
		return nil, nil, fmt.Errorf("persist Store AMD state: %w", err)
	}
	state.Family = familyAMD

	updated, err := json.Marshal(state)
	if err != nil {
		return nil, nil, errors.New("encode Store AMD state")
	}

	return headers, updated, nil
}

// loadStoreMDHeaders mints the StoreAgent/MD header family from the same ADI
// provisioning state. It is the counterpart of AppleMediaServices' AMD proof:
// Apple names the family it expects in X-Apple-MD-Action.
func loadStoreMDHeaders(ctx context.Context, bundle assets.Bundle, encoded []byte) (map[string]string, []byte, error) {
	if ctx == nil {
		return nil, nil, errors.New("store MD context is nil")
	}

	state, err := decodeAnisetteState(encoded)
	if err != nil {
		return nil, nil, err
	}

	if len(state.Provisioning) == 0 {
		return nil, nil, errors.New("store MD state is not provisioned")
	}

	adi, err := machine.OpenModernADI(ctx, bundle, state.Identifier, state.Provisioning)
	if err != nil {
		return nil, nil, fmt.Errorf("open Store MD service: %w", err)
	}

	defer func() { _ = adi.Close() }()

	mid, otp, err := adi.RequestOTP(storeAnisetteDSID)
	if err != nil {
		return nil, nil, fmt.Errorf("generate Store MD proof: %w", err)
	}

	state.Provisioning, err = adi.State()
	if err != nil {
		return nil, nil, fmt.Errorf("persist Store MD state: %w", err)
	}
	state.Family = familyMD

	updated, err := json.Marshal(state)
	if err != nil {
		return nil, nil, errors.New("encode Store MD state")
	}

	return map[string]string{
		"X-Apple-MD":   base64.StdEncoding.EncodeToString(otp),
		"X-Apple-MD-M": base64.StdEncoding.EncodeToString(mid),
	}, updated, nil
}

func isUnknownAuthority(err error) bool {
	var unknown x509.UnknownAuthorityError

	return errors.As(err, &unknown)
}

func installAppleRoot(ctx context.Context, client *http.Client) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, appleRootURL, nil)
	if err != nil {
		return fmt.Errorf("create Apple root request: %w", err)
	}

	downloader := &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}},
		Timeout:   15 * time.Second,
		CheckRedirect: func(request *http.Request, _ []*http.Request) error {
			if request.URL.Scheme != "https" || request.URL.Hostname() != "www.apple.com" {
				return errors.New("apple root redirect is not trusted")
			}

			return nil
		},
	}

	response, err := downloader.Do(request)
	if err != nil {
		return fmt.Errorf("download Apple root: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download Apple root: HTTP %d", response.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(response.Body, rootSizeLimit+1))
	if err != nil {
		return fmt.Errorf("read Apple root: %w", err)
	}
	if len(data) > rootSizeLimit {
		return errors.New("apple root exceeds size limit")
	}

	certificate, err := x509.ParseCertificate(data)
	if err != nil {
		return fmt.Errorf("parse Apple root: %w", err)
	}
	if !validAppleRoot(certificate, time.Now()) {
		return errors.New("downloaded Apple root is invalid")
	}

	roots, _ := x509.SystemCertPool()
	if roots == nil {
		roots = x509.NewCertPool()
	}
	roots.AddCert(certificate)

	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		return errors.New("apple authentication transport is unsupported")
	}
	updated := transport.Clone()
	updated.TLSClientConfig = transport.TLSClientConfig.Clone()
	updated.TLSClientConfig.RootCAs = roots
	updated.TLSClientConfig.MinVersion = tls.VersionTLS12
	transport.CloseIdleConnections()
	client.Transport = updated

	return nil
}

func validAppleRoot(certificate *x509.Certificate, now time.Time) bool {
	if certificate == nil || !certificate.IsCA || !certificate.BasicConstraintsValid ||
		certificate.KeyUsage&x509.KeyUsageCertSign == 0 || certificate.Subject.CommonName != "Apple Root CA" ||
		!bytes.Equal(certificate.RawSubject, certificate.RawIssuer) || now.Before(certificate.NotBefore) || now.After(certificate.NotAfter) {
		return false
	}

	for _, organization := range certificate.Subject.Organization {
		if organization == "Apple Inc." {
			return true
		}
	}

	return false
}
