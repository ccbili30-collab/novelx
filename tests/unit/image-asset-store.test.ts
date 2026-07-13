import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImageAssetStore } from "../../src/domain/asset/imageAssetStore";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
let root = "";
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("ImageAssetStore", () => {
  it("validates, hashes, atomically stores, and deduplicates an image", () => {
    const store = createStore();
    const first = store.save(ONE_PIXEL_PNG);
    expect(first).toMatchObject({ mimeType: "image/png", width: 1, height: 1, created: true });
    expect(fs.readFileSync(first.absolutePath)).toEqual(ONE_PIXEL_PNG);
    expect(store.save(ONE_PIXEL_PNG)).toMatchObject({ sha256: first.sha256, relativePath: first.relativePath, created: false });
  });

  it("rejects invalid bytes, oversized content, and path traversal", () => {
    const store = createStore();
    expect(() => store.save(Buffer.from("not-image"))).toThrowError(expect.objectContaining({ code: "IMAGE_ASSET_MIME_INVALID" }));
    expect(() => store.save(Buffer.alloc(25 * 1024 * 1024 + 1))).toThrowError(expect.objectContaining({ code: "IMAGE_ASSET_SIZE_INVALID" }));
    expect(() => store.resolveManagedPath(".novax/assets/images/../../workspace.db"))
      .toThrowError(expect.objectContaining({ code: "IMAGE_ASSET_PATH_INVALID" }));
  });

  it("removes only files created by the failed transaction and recovers temporary files", () => {
    const store = createStore();
    const first = store.save(ONE_PIXEL_PNG);
    store.removeCreated(first);
    expect(fs.existsSync(first.absolutePath)).toBe(false);
    fs.mkdirSync(store.temporaryPath, { recursive: true });
    fs.writeFileSync(path.join(store.temporaryPath, "crash.tmp"), "partial", "utf8");
    fs.writeFileSync(path.join(store.temporaryPath, "keep.txt"), "keep", "utf8");
    expect(store.recoverTemporaryFiles()).toBe(1);
    expect(fs.existsSync(path.join(store.temporaryPath, "keep.txt"))).toBe(true);
  });
});

function createStore() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-image-asset-store-"));
  return new ImageAssetStore(root);
}
