import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function isolateE2eUserData(): () => void {
  if (process.env.NOVAX_DESKTOP_E2E_USER_DATA) return () => undefined;
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "novax-playwright-user-data-"));
  process.env.NOVAX_DESKTOP_E2E_USER_DATA = userDataPath;
  return () => {
    const resolved = path.resolve(userDataPath);
    const tempRoot = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("novax-playwright-user-data-")) {
      throw new Error("E2E_USER_DATA_CLEANUP_PATH_REJECTED");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  };
}
