import { describe, expect, it } from "vitest";
import { createMainWindowOptions } from "../../src/main/createMainWindow";

describe("main window security contract", () => {
  it("keeps the renderer isolated from Node.js and unsafe browser capabilities", () => {
    const options = createMainWindowOptions("C:\\novax\\preload.js");

    expect(options.webPreferences).toMatchObject({
      preload: "C:\\novax\\preload.js",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });

  it("defines a stable minimum workbench size without showing an unready window", () => {
    const options = createMainWindowOptions("C:\\novax\\preload.js");

    expect(options).toMatchObject({
      width: 1440,
      height: 900,
      minWidth: 1100,
      minHeight: 700,
      show: false,
    });
  });
});

