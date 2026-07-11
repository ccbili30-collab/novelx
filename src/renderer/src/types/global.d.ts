import type { DesktopApi } from "../../../shared/ipcContract";

declare global {
  interface Window {
    novaxDesktop: DesktopApi;
  }
}

export {};

