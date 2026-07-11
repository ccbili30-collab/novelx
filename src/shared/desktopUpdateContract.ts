import { z } from "zod";

export const desktopUpdateStateSchema = z.object({
  kind: z.enum([
    "not_configured",
    "idle",
    "checking",
    "available",
    "downloading",
    "downloaded",
    "up_to_date",
    "error",
  ]),
  currentVersion: z.string().trim().min(1).max(80),
  availableVersion: z.string().trim().min(1).max(80).nullable(),
  progress: z.number().min(0).max(100).nullable(),
  message: z.string().trim().min(1).max(500),
  canCheck: z.boolean(),
  canDownload: z.boolean(),
  canInstall: z.boolean(),
}).strict();

export type DesktopUpdateState = z.infer<typeof desktopUpdateStateSchema>;

