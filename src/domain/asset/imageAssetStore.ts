import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { imageSize } from "image-size";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 40_000_000;
const MANAGED_PATH_PATTERN = /^\.novax\/assets\/images\/[a-f0-9]{64}\.(png|jpg|webp)$/;

export interface StoredImageFile {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  relativePath: string;
  absolutePath: string;
  created: boolean;
}

export class ImageAssetStore {
  readonly rootPath: string;
  readonly imagesPath: string;
  readonly temporaryPath: string;

  constructor(workspaceRoot: string) {
    this.rootPath = path.resolve(workspaceRoot);
    this.imagesPath = path.join(this.rootPath, ".novax", "assets", "images");
    this.temporaryPath = path.join(this.rootPath, ".novax", "assets", "tmp");
  }

  save(bytesInput: Uint8Array): StoredImageFile {
    const bytes = Buffer.from(bytesInput);
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw storeError("IMAGE_ASSET_SIZE_INVALID");
    const mimeType = detectMimeType(bytes);
    if (!mimeType) throw storeError("IMAGE_ASSET_MIME_INVALID");
    let dimensions: ReturnType<typeof imageSize>;
    try { dimensions = imageSize(bytes); } catch { throw storeError("IMAGE_ASSET_CONTENT_INVALID"); }
    const width = dimensions.width ?? 0;
    const height = dimensions.height ?? 0;
    if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
      throw storeError("IMAGE_ASSET_DIMENSIONS_INVALID");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const extension = mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp";
    const relativePath = `.novax/assets/images/${sha256}.${extension}`;
    const absolutePath = this.resolveManagedPath(relativePath);
    fs.mkdirSync(this.imagesPath, { recursive: true });
    fs.mkdirSync(this.temporaryPath, { recursive: true });
    if (fs.existsSync(absolutePath)) {
      if (hashFile(absolutePath) !== sha256) throw storeError("IMAGE_ASSET_HASH_CONFLICT");
      return { mimeType, width, height, byteLength: bytes.length, sha256, relativePath, absolutePath, created: false };
    }
    const temporary = path.join(this.temporaryPath, `${randomUUID()}.tmp`);
    let created = true;
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      try {
        fs.renameSync(temporary, absolutePath);
      } catch (error) {
        if (!fs.existsSync(absolutePath) || hashFile(absolutePath) !== sha256) throw error;
        created = false;
      }
      return { mimeType, width, height, byteLength: bytes.length, sha256, relativePath, absolutePath, created };
    } catch {
      throw storeError("IMAGE_ASSET_WRITE_FAILED");
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* retain the primary result */ }
    }
  }

  resolveManagedPath(relativePath: string): string {
    const portable = relativePath.replace(/\\/g, "/");
    if (!MANAGED_PATH_PATTERN.test(portable)) throw storeError("IMAGE_ASSET_PATH_INVALID");
    const target = path.resolve(this.rootPath, ...portable.split("/"));
    const prefix = `${path.resolve(this.imagesPath)}${path.sep}`;
    if (!target.startsWith(prefix)) throw storeError("IMAGE_ASSET_PATH_INVALID");
    return target;
  }

  removeCreated(file: StoredImageFile): void {
    if (!file.created) return;
    const target = this.resolveManagedPath(file.relativePath);
    if (fs.existsSync(target) && hashFile(target) === file.sha256) fs.rmSync(target, { force: true });
  }

  recoverTemporaryFiles(): number {
    if (!fs.existsSync(this.temporaryPath)) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(this.temporaryPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
      fs.rmSync(path.join(this.temporaryPath, entry.name), { force: true });
      removed += 1;
    }
    return removed;
  }
}

function detectMimeType(bytes: Buffer): StoredImageFile["mimeType"] | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function hashFile(target: string): string {
  return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function storeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
