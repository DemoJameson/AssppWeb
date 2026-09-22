// Command macdecrypt turns an App Store macOS package into an installable one.
//
// Apple serves a macOS download as a FairPlay-encrypted .pkg: the bytes are not
// a xar archive at all until they have been decrypted, and the only thing that
// can decrypt them is Apple's own StoreAgent, driven by the `dpInfo` blob that
// arrives in the download response's sinfs plus the hardware id the download was
// requested with. ipatool does the same thing by emulating StoreAgent; this
// command is that path, reduced to a single file.
//
// This directory is its own module, and its path sits under
// github.com/majd/ipatool/v2/ on purpose: the emulation, the Mach-O loader and
// the Unicorn binding all live in that module's internal packages, which Go
// only lets packages under its own path import. The dependency itself comes
// from the module proxy at the version pinned in go.mod.
//
//	macdecrypt -in encrypted.pkg -out app.pkg \
//	           -hardware-id 05ca1a6f5004 -dp-info <base64|@file>
//
// Progress goes to stdout as one `progress <written> <total>` line per step, so
// a caller can drive a progress bar; errors go to stderr, prefixed with the
// command name.
//
// Environment: XDG_CACHE_HOME (or HOME) decides where the Apple assets and the
// Unicorn runtime are cached — point it at a persistent directory so a container
// only downloads them once.
package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/majd/ipatool/v2/internal/sap/assets"
	"github.com/majd/ipatool/v2/internal/sap/machine"
)

const decryptTimeout = 30 * time.Minute

// How much output between progress reports. Decryption runs at a couple of MB/s
// (a 67 MB package takes about half a minute), so this lands a report every
// second or two on the sizes where anyone is waiting.
const progressStep = 4 << 20

// progressWriter reports how far the decrypted output has got. `total` is the
// encrypted input's size: StoreAgent's stream is a byte-for-byte transform, so
// the two share a length.
type progressWriter struct {
	destination io.Writer
	total       int64
	written     int64
	reported    int64
}

func (w *progressWriter) Write(data []byte) (int, error) {
	written, err := w.destination.Write(data)
	w.written += int64(written)

	if w.total > 0 && w.written-w.reported >= progressStep {
		w.reported = w.written
		fmt.Printf("progress %d %d\n", w.written, w.total)
	}

	return written, err
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "macdecrypt: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	inputPath := flag.String("in", "", "encrypted package to read")
	outputPath := flag.String("out", "", "decrypted package to write")
	hardwareHex := flag.String("hardware-id", "", "hardware id the download was requested with, hex encoded")
	dpInfoArgument := flag.String("dp-info", "", "dpInfo from the download response's sinfs (base64, or @<path>)")

	flag.Parse()

	for name, value := range map[string]string{
		"-in":          *inputPath,
		"-out":         *outputPath,
		"-hardware-id": *hardwareHex,
		"-dp-info":     *dpInfoArgument,
	} {
		if value == "" {
			return fmt.Errorf("%s is required", name)
		}
	}

	hardwareID, err := hex.DecodeString(*hardwareHex)
	if err != nil {
		return fmt.Errorf("hardware id is not hex: %w", err)
	}

	dpInfo, err := readDPInfo(*dpInfoArgument)
	if err != nil {
		return err
	}

	source, err := os.Open(*inputPath)
	if err != nil {
		return fmt.Errorf("open encrypted package: %w", err)
	}
	defer source.Close()

	info, err := source.Stat()
	if err != nil {
		return fmt.Errorf("measure encrypted package: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), decryptTimeout)
	defer cancel()

	// Apple's own machinery, emulated: the SAP assets are the same four files
	// the signing path uses, plus the StoreAgent image the decryption runs in.
	bundle, err := assets.Load(ctx)
	if err != nil {
		return fmt.Errorf("load Apple SAP assets: %w", err)
	}

	agent, err := machine.OpenStoreAgent(ctx, bundle, hardwareID, dpInfo)
	if err != nil {
		return fmt.Errorf("open Apple StoreAgent: %w", err)
	}
	defer func() {
		_ = agent.Close()
	}()

	destination, err := os.Create(*outputPath)
	if err != nil {
		return fmt.Errorf("create decrypted package: %w", err)
	}

	written, decryptErr := agent.Decrypt(
		ctx,
		&progressWriter{destination: destination, total: info.Size()},
		source,
	)

	closeErr := destination.Close()

	if decryptErr != nil {
		_ = os.Remove(*outputPath)

		return fmt.Errorf("decrypt with Apple StoreAgent: %w", decryptErr)
	}

	if closeErr != nil {
		return fmt.Errorf("close decrypted package: %w", closeErr)
	}

	if err := checkArchiveMagic(*outputPath); err != nil {
		return err
	}

	// A closing report even when the package never filled a whole step, so a
	// caller driving a bar always sees it reach the end.
	fmt.Printf("progress %d %d\n", written, info.Size())

	fmt.Printf("decrypted %d bytes to %s\n", written, *outputPath)

	return nil
}

// readDPInfo accepts the blob inline (base64) or from a file, because it is
// small enough to pass on a command line but also arrives from a request.
func readDPInfo(argument string) ([]byte, error) {
	encoded := argument

	if len(argument) > 0 && argument[0] == '@' {
		fromFile, err := os.ReadFile(argument[1:])
		if err != nil {
			return nil, fmt.Errorf("read dpInfo file: %w", err)
		}

		encoded = string(fromFile)
	}

	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("dpInfo is not base64: %w", err)
	}

	if len(decoded) == 0 {
		return nil, errors.New("dpInfo is empty")
	}

	return decoded, nil
}

// checkArchiveMagic fails fast when the decryption produced nothing usable —
// a hardware id that does not match the dpInfo yields bytes that are still
// ciphertext, and the caller should see that here rather than downstream.
func checkArchiveMagic(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open decrypted package: %w", err)
	}
	defer file.Close()

	magic := make([]byte, 4)

	// ReadFull, because a plain Read may legally return fewer bytes than asked
	// even on a file this size — a short read would read as "not xar" for the
	// wrong reason.
	if _, err := io.ReadFull(file, magic); err != nil {
		return fmt.Errorf("read decrypted package: %w", err)
	}

	if string(magic) != "xar!" {
		return fmt.Errorf("decrypted package is not a xar archive (starts with % x)", magic)
	}

	return nil
}
