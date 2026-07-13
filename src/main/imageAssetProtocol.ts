import { protocol } from "electron";
import type { WorkspaceSession } from "./workspaceIpc";

const IMAGE_ASSET_SCHEME = "novax-asset";

export function registerImageAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: IMAGE_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  }]);
}

export function registerImageAssetProtocol(session: WorkspaceSession): () => void {
  protocol.handle(IMAGE_ASSET_SCHEME, createImageAssetProtocolHandler((assetId) => session.readImageAsset(assetId)));
  return () => protocol.unhandle(IMAGE_ASSET_SCHEME);
}

export function createImageAssetProtocolHandler(resolve: (assetId: string) => {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sha256: string;
}): (request: Request) => Response {
  return (request) => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.protocol !== `${IMAGE_ASSET_SCHEME}:` || url.hostname !== "image" || parts.length !== 1 || url.search || url.hash) {
        return new Response(null, { status: 404 });
      }
      const assetId = decodeURIComponent(parts[0]!);
      if (!assetId || assetId.length > 240 || /[\\/\0]/u.test(assetId)) return new Response(null, { status: 404 });
      const asset = resolve(assetId);
      return new Response(new Uint8Array(asset.bytes), {
        status: 200,
        headers: {
          "content-type": asset.mimeType,
          "content-length": String(asset.bytes.byteLength),
          "cache-control": "private, max-age=31536000, immutable",
          etag: `"${asset.sha256}"`,
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}
