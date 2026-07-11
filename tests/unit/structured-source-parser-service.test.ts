import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { SourceLibraryRepository } from "../../src/domain/import/sourceLibraryRepository";
import { StructuredSourceParserService } from "../../src/domain/import/structuredSourceParserService";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";

let workspace: WorkspaceDatabase | null = null;
let root = "";
afterEach(() => { workspace?.close(); workspace = null; if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("StructuredSourceParserService", () => {
  it("parses DOCX paragraphs with stable paragraph locators", () => {
    const { sources, parser } = setup();
    const filePath = path.join(root, "novel.docx");
    fs.writeFileSync(filePath, zipSync({ "word/document.xml": strToU8(`<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>`) }));
    const source = sources.register({ filePath, rightsAttestation: "user_owned" });
    expect(parser.parse(source.id)[0]).toMatchObject({ locator: { kind: "docx_paragraphs", start: 1, end: 2 }, content: "第一段\n\n第二段" });
  });

  it("parses EPUB in spine order and preserves chapter paths", () => {
    const { sources, parser } = setup();
    const filePath = path.join(root, "novel.epub");
    fs.writeFileSync(filePath, zipSync({
      "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`),
      "OEBPS/content.opf": strToU8(`<?xml version="1.0"?><package><manifest><item id="c1" href="chapter1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>`),
      "OEBPS/chapter1.xhtml": strToU8(`<html><body><h1>潮汐</h1><p>海岸开始沉降。</p></body></html>`),
    }));
    const source = sources.register({ filePath, rightsAttestation: "licensed" });
    expect(parser.parse(source.id)[0]).toMatchObject({ locator: { kind: "epub_spine", spineIndex: 0, chapterPath: "OEBPS/chapter1.xhtml" } });
    expect(parser.parse(source.id)[0]!.content).toContain("海岸开始沉降");
  });

  it("registers image dimensions without inventing an image description", () => {
    const { sources, parser } = setup();
    const filePath = path.join(root, "portrait.png");
    fs.writeFileSync(filePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const source = sources.register({ filePath, rightsAttestation: "user_owned" });
    const [chunk] = parser.parse(source.id);
    expect(chunk).toMatchObject({ locator: { kind: "image", width: 1, height: 1, format: "png" } });
    expect(chunk!.content).not.toMatch(/人物|角色|头像/);
  });
});

function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "novelx-structured-source-"));
  workspace = openWorkspace(root);
  return { sources: new SourceLibraryRepository(workspace), parser: new StructuredSourceParserService(workspace) };
}
