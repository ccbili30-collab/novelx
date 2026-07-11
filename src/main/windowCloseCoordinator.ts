import { BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import {
  desktopIpcChannels,
  workspaceFlushCompleteSchema,
} from "../shared/ipcContract";

export function installWindowCloseCoordinator(window: BrowserWindow): void {
  let allowClose = false;
  let flushPending = false;
  let activeRequestId: string | null = null;
  let resolveFlush: ((success: boolean) => void) | null = null;

  const onFlushComplete = (event: Electron.IpcMainEvent, payload: unknown) => {
    if (event.sender !== window.webContents) return;
    const parsed = workspaceFlushCompleteSchema.safeParse(payload);
    if (!parsed.success || parsed.data.requestId !== activeRequestId) return;
    resolveFlush?.(parsed.data.success);
  };
  ipcMain.on(desktopIpcChannels.workspaceFlushComplete, onFlushComplete);

  window.on("close", (event) => {
    if (allowClose || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
    event.preventDefault();
    if (flushPending) return;
    flushPending = true;

    void requestRendererFlush(window, (requestId, resolve) => {
      activeRequestId = requestId;
      resolveFlush = resolve;
    }).then(async (success) => {
      activeRequestId = null;
      resolveFlush = null;
      flushPending = false;
      if (!success) return;
      allowClose = true;
      window.close();
    }).catch(async () => {
      activeRequestId = null;
      resolveFlush = null;
      flushPending = false;
      if (window.isDestroyed()) return;
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        title: "草稿尚未确认保存",
        message: "novelx 未能确认当前草稿已经保存。",
        detail: "返回编辑器重试可以避免丢失最近输入。",
        buttons: ["返回编辑器", "仍然退出"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response === 1) {
        allowClose = true;
        window.close();
      }
    });
  });

  window.once("closed", () => {
    ipcMain.removeListener(desktopIpcChannels.workspaceFlushComplete, onFlushComplete);
    resolveFlush?.(false);
  });
}

function requestRendererFlush(
  window: BrowserWindow,
  bind: (requestId: string, resolve: (success: boolean) => void) => void,
): Promise<boolean> {
  const requestId = randomUUID();
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("WORKSPACE_FLUSH_TIMEOUT"));
    }, 10_000);
    bind(requestId, (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(success);
    });
    window.webContents.send(desktopIpcChannels.workspaceFlushRequest, { requestId });
  });
}
