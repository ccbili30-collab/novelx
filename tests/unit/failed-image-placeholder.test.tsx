import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FailedImagePlaceholder } from "../../src/renderer/src/features/assets/FailedImagePlaceholder";

describe("failed image placeholder", () => {
  it("renders the bundled visual as an explicit false image state", () => {
    const html = renderToStaticMarkup(createElement(FailedImagePlaceholder, { label: "角色图生成失败" }));

    expect(html).toContain('data-image-present="false"');
    expect(html).toContain("角色图生成失败");
    expect(html).toContain("没有图片内容");
    expect(html).toContain("image-generation-failed");
  });
});
