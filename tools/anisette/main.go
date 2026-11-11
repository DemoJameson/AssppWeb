// Command anisette provides Apple's machine-validation data for the browser.
//
// Apple's App Store authentication now asks for Anisette/AMD headers alongside
// the browser's SAP signature. The password never reaches this process: the
// helper only receives a device identifier, an opaque provisioning state, the
// public Apple endpoint, and Apple's machine-action challenge. The browser still
// signs the credential-bearing request body and sends it directly to Apple.
//
// This directory is its own module, deliberately under
// github.com/majd/ipatool/v2/ so it may import that module's internal packages
// (ADI, Store framework, and asset extraction). The dependency comes from the
// module proxy at the version pinned in go.mod.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/majd/ipatool/v2/internal/sap/assets"
	"github.com/majd/ipatool/v2/internal/sap/unicorn"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "anisette: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return usageError()
	}

	switch args[0] {
	case "serve":
		return runServe(args[1:])
	case "prepare-assets":
		return runPrepareAssets(args[1:])
	case "help", "-h", "--help":
		printUsage()
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func usageError() error {
	printUsage()
	return fmt.Errorf("a command is required")
}

func printUsage() {
	fmt.Fprintln(os.Stderr, `usage:
  anisette serve [-listen 127.0.0.1:8791]
  anisette prepare-assets [-unicorn]

serve needs ANISETTE_HELPER_TOKEN when exposed beyond loopback. The helper
caches Apple's assets and the Unicorn runtime under the OS user cache directory
(XDG_CACHE_HOME on Linux, HOME/Library/Caches on macOS, LocalAppData on
Windows).`)
}

func runPrepareAssets(args []string) error {
	flags := flag.NewFlagSet("prepare-assets", flag.ContinueOnError)
	withUnicorn := flags.Bool("unicorn", false, "also download and verify the Unicorn runtime")
	if err := flags.Parse(args); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	installRetryingTransport()

	if _, err := assets.Load(ctx); err != nil {
		return fmt.Errorf("load Apple assets: %w", err)
	}

	if *withUnicorn {
		engine, err := unicorn.New(ctx)
		if err != nil {
			return fmt.Errorf("load Unicorn runtime: %w", err)
		}
		if err := engine.Close(); err != nil {
			return fmt.Errorf("close Unicorn runtime: %w", err)
		}
	}

	fmt.Println("Apple assets ready")
	return nil
}
