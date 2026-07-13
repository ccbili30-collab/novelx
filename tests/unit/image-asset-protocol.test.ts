import { describe, expect, it } from "vitest";
import { createImageAssetProtocolHandler } from "../../src/main/imageAssetProtocol";

describe("Image asset protocol", () => {
  it("serves only a resolved managed image by opaque asset id", async () => {
    const bytes = Buffer.from([137, 80, 78, 71]);
    const handler = createImageAssetProtocolHandler((assetId) => {
      expect(assetId).toBe("asset-1");
      return { bytes, mimeType: "image/png", sha256: "a".repeat(64) };
    });

    const response = await handler(new Request("novax-asset://image/asset-1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("rejects traversal, non-image hosts, and non-GET methods before resolving", async () => {
    let calls = 0;
    const handler = createImageAssetProtocolHandler(() => {
      calls += 1;
      throw new Error("must not resolve");
    });

    expect((await handler(new Request("novax-asset://other/asset-1"))).status).toBe(404);
    expect((await handler(new Request("novax-asset://image/a/b"))).status).toBe(404);
    expect((await handler(new Request("novax-asset://image/a%2Fb"))).status).toBe(404);
    expect((await handler(new Request("novax-asset://image/asset-1", { method: "POST" }))).status).toBe(405);
    expect(calls).toBe(0);
  });
});
