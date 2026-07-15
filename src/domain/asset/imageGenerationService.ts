import { createHash } from "node:crypto";
import type { ImageProviderRuntimeProfile } from "../../shared/imageProviderContract";
import {
  ImageAssetRepository,
  type CreateImageGenerationJobInput,
  type ImageAssetRecord,
  type ImageGenerationJobRecord,
} from "./imageAssetRepository";
import { ImageAssetStore, type StoredImageFile } from "./imageAssetStore";
import {
  generateResponsesImage,
  ResponsesImageProviderError,
  type GeneratedImageResponse,
} from "./responsesImageProviderClient";

export interface ImageGenerationResult {
  job: ImageGenerationJobRecord;
  asset: ImageAssetRecord;
}

export type ImageGenerationClient = (
  profile: ImageProviderRuntimeProfile,
  prompt: string,
  signal?: AbortSignal,
) => Promise<GeneratedImageResponse>;

export type ImageGenerationProgress = "queued" | "generating" | "ready" | "failed" | "reconciliation_required";
export type ImageGenerationObserver = (progress: ImageGenerationProgress) => void;

const workspaceQueues = new Map<string, Promise<void>>();

export class ImageGenerationService {
  constructor(
    readonly repository: ImageAssetRepository,
    readonly store: ImageAssetStore,
    readonly client: ImageGenerationClient = generateResponsesImage,
  ) {}

  generate(
    input: Omit<CreateImageGenerationJobInput, "providerId" | "modelId" | "size" | "quality" | "background">,
    profile: ImageProviderRuntimeProfile,
    signal?: AbortSignal,
    observer?: ImageGenerationObserver,
  ): Promise<ImageGenerationResult> {
    return this.serialize(() => this.execute(input, profile, signal, observer));
  }

  private async execute(
    input: Omit<CreateImageGenerationJobInput, "providerId" | "modelId" | "size" | "quality" | "background">,
    profile: ImageProviderRuntimeProfile,
    signal?: AbortSignal,
    observer?: ImageGenerationObserver,
  ): Promise<ImageGenerationResult> {
    let job = this.repository.createOrGetJob({
      ...input,
      providerId: profile.providerId,
      modelId: profile.modelId,
      size: profile.defaultSize,
      quality: profile.defaultQuality,
      background: profile.defaultBackground,
    });
    if (job.status === "succeeded") {
      const asset = this.repository.getAssetByJob(job.id);
      if (!asset) throw serviceError("IMAGE_JOB_ASSET_MISSING");
      notify(observer, "ready");
      return { job, asset };
    }
    if (job.status !== "queued") {
      notify(observer, job.status === "reconciliation_required" ? "reconciliation_required" : "failed");
      throw serviceError(`IMAGE_JOB_${job.status.toUpperCase()}`);
    }
    notify(observer, "queued");
    job = this.repository.claim(job.id);
    if (signal?.aborted) {
      this.repository.markFailed(job.id, "IMAGE_JOB_CANCELLED", "图片生成在请求发送前取消。");
      notify(observer, "failed");
      throw serviceError("IMAGE_JOB_CANCELLED");
    }
    job = this.repository.markRequestSent(job.id);
    notify(observer, "generating");
    let generated: GeneratedImageResponse;
    try {
      generated = await this.client(profile, job.prompt, signal);
    } catch (error) {
      if (error instanceof ResponsesImageProviderError && error.outcomeUnknown) {
        this.repository.markReconciliationRequired(job.id, error.code, "图片请求结果未知，禁止自动重试。");
        notify(observer, "reconciliation_required");
      } else {
        const code = error instanceof ResponsesImageProviderError ? error.code : "IMAGE_PROVIDER_RUNTIME_FAILED";
        this.repository.markFailed(job.id, code, "图片模型没有返回可提交的图片资产。");
        notify(observer, "failed");
      }
      throw error;
    }
    let stored: StoredImageFile | null = null;
    try {
      stored = this.store.save(generated.bytes);
      const asset = this.repository.complete(job.id, {
        mimeType: stored.mimeType,
        width: stored.width,
        height: stored.height,
        byteLength: stored.byteLength,
        sha256: stored.sha256,
        relativePath: stored.relativePath,
        providerResponseIdSha256: generated.responseId
          ? createHash("sha256").update(generated.responseId, "utf8").digest("hex")
          : null,
      });
      notify(observer, "ready");
      return { job: this.repository.getRequiredJob(job.id), asset };
    } catch (error) {
      if (stored) this.store.removeCreated(stored);
      const current = this.repository.getRequiredJob(job.id);
      if (current.status === "running") {
        this.repository.markFailed(job.id, "IMAGE_ASSET_COMMIT_FAILED", "图片已返回，但资产提交失败。");
        notify(observer, "failed");
      }
      throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.store.rootPath;
    const previous = workspaceQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    workspaceQueues.set(key, tail);
    void tail.finally(() => {
      if (workspaceQueues.get(key) === tail) workspaceQueues.delete(key);
    });
    return result;
  }
}

function notify(observer: ImageGenerationObserver | undefined, progress: ImageGenerationProgress): void {
  try { observer?.(progress); } catch { /* Progress delivery is never authoritative. */ }
}

function serviceError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
