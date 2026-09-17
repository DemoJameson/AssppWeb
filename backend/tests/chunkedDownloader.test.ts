import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ChunkedDownloader,
  readPartSizes,
  removePartFiles,
} from "../src/services/chunkedDownloader.js";

const TEMP_DIR = path.join(os.tmpdir(), "chunked-downloader-test");

beforeAll(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

function destPath(name: string): string {
  return path.join(TEMP_DIR, name, "package.ipa");
}

function writeParts(target: string, sizes: number[]): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  sizes.forEach((size, index) => {
    fs.writeFileSync(`${target}.part${index}`, Buffer.alloc(size));
  });
}

describe("readPartSizes", () => {
  it("reports the size of each part file, 0 for missing ones", () => {
    const target = destPath("read-sizes");
    writeParts(target, [100, 200]);

    expect(readPartSizes(target, 3)).toEqual([100, 200, 0]);
  });

  it("returns zeroes when no parts exist", () => {
    const target = destPath("read-sizes-empty");
    fs.mkdirSync(path.dirname(target), { recursive: true });

    expect(readPartSizes(target, 2)).toEqual([0, 0]);
  });
});

describe("removePartFiles", () => {
  it("removes only the .part siblings of the destination", () => {
    const target = destPath("remove-parts");
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${target}.part0`, Buffer.alloc(10));
    fs.writeFileSync(`${target}.part1`, Buffer.alloc(20));
    fs.writeFileSync(target, Buffer.alloc(5));
    const unrelated = path.join(dir, "other.ipa.part0");
    fs.writeFileSync(unrelated, Buffer.alloc(10));

    removePartFiles(target);

    expect(fs.existsSync(`${target}.part0`)).toBe(false);
    expect(fs.existsSync(`${target}.part1`)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});

describe("ChunkedDownloader.abort", () => {
  it("keeps .part files when asked (pause/resume)", () => {
    const target = destPath("abort-keep");
    writeParts(target, [50, 60]);
    const downloader = new ChunkedDownloader("https://example.com/x", target);

    downloader.abort(true);

    expect(fs.existsSync(`${target}.part0`)).toBe(true);
    expect(fs.existsSync(`${target}.part1`)).toBe(true);
  });

  it("removes .part files by default (delete/timeout)", () => {
    const target = destPath("abort-clean");
    writeParts(target, [50, 60]);
    const downloader = new ChunkedDownloader("https://example.com/x", target);

    downloader.abort();

    expect(fs.existsSync(`${target}.part0`)).toBe(false);
    expect(fs.existsSync(`${target}.part1`)).toBe(false);
  });
});
