import { randomUUID } from "node:crypto";
import { canonicalAuditHash } from "../audit/canonicalAuditHash";
import type { WorkspaceDatabase } from "../workspace/workspaceRepository";

export type ImageGenerationPurpose = "character_portrait" | "scene" | "world_map";
export type ImageGenerationJobStatus = "queued" | "running" | "succeeded" | "failed" | "reconciliation_required";
export type ImageAssetStatus = "ready" | "stale";

export interface CreateImageGenerationJobInput {
  idempotencyKey: string;
  providerId: string;
  modelId: string;
  title: string;
  purpose: ImageGenerationPurpose;
  prompt: string;
  size: string;
  quality: "auto" | "low" | "medium" | "high";
  background: "auto" | "transparent" | "opaque";
  sourceResourceIds: string[];
  sourceVersionIds: string[];
}

export interface ImageGenerationJobRecord extends CreateImageGenerationJobInput {
  id: string;
  requestSha256: string;
  promptSha256: string;
  status: ImageGenerationJobStatus;
  requestSentAt: string | null;
  providerResponseIdSha256: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImageAssetRecord {
  id: string;
  jobId: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  relativePath: string;
  status: ImageAssetStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedImageAssetRecord {
  asset: ImageAssetRecord;
  title: string;
  purpose: ImageGenerationPurpose;
  sourceResourceIds: string[];
  sourceVersionIds: string[];
}

export interface ShowcaseImageJobRecord {
  jobId: string;
  title: string;
  purpose: ImageGenerationPurpose;
  status: ImageGenerationJobStatus;
  sourceResourceIds: string[];
  sourceVersionIds: string[];
  asset: ImageAssetRecord | null;
  createdAt: string;
  updatedAt: string;
}

export class ImageAssetRepository {
  constructor(readonly workspace: WorkspaceDatabase) {}

  createOrGetJob(input: CreateImageGenerationJobInput): ImageGenerationJobRecord {
    const normalized = normalizeJobInput(input);
    this.assertSourcesExist(normalized.sourceResourceIds, normalized.sourceVersionIds);
    const requestSha256 = canonicalAuditHash(normalized);
    const existing = this.getJobByIdempotencyKey(normalized.idempotencyKey);
    if (existing) {
      if (existing.requestSha256 !== requestSha256) throw repositoryError("IMAGE_JOB_IDEMPOTENCY_CONFLICT");
      return existing;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.workspace.db.prepare(`
        INSERT INTO image_generation_jobs (
          id, idempotency_key, request_sha256, provider_id, model_id, title, purpose,
          prompt, prompt_sha256, size, quality, background, source_resource_ids_json, source_version_ids_json,
          status, request_sent_at, provider_response_id_sha256, error_code, error_message,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        id, normalized.idempotencyKey, requestSha256, normalized.providerId, normalized.modelId,
        normalized.title, normalized.purpose, normalized.prompt, canonicalAuditHash(normalized.prompt),
        normalized.size, normalized.quality, normalized.background,
        JSON.stringify(normalized.sourceResourceIds), JSON.stringify(normalized.sourceVersionIds), now, now,
      );
    } catch (error) {
      const concurrent = this.getJobByIdempotencyKey(normalized.idempotencyKey);
      if (concurrent?.requestSha256 === requestSha256) return concurrent;
      throw error;
    }
    return this.getRequiredJob(id);
  }

  getRequiredJob(id: string): ImageGenerationJobRecord {
    const row = this.workspace.db.prepare("SELECT * FROM image_generation_jobs WHERE id = ?").get(id);
    if (!row) throw repositoryError("IMAGE_JOB_NOT_FOUND");
    return mapJob(row);
  }

  getJobByIdempotencyKey(key: string): ImageGenerationJobRecord | null {
    const row = this.workspace.db.prepare("SELECT * FROM image_generation_jobs WHERE idempotency_key = ?").get(key);
    return row ? mapJob(row) : null;
  }

  claim(jobId: string): ImageGenerationJobRecord {
    const result = this.workspace.db.prepare(`
      UPDATE image_generation_jobs SET status = 'running', updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(new Date().toISOString(), jobId);
    if (result.changes !== 1) throw repositoryError("IMAGE_JOB_NOT_QUEUED");
    return this.getRequiredJob(jobId);
  }

  markRequestSent(jobId: string): ImageGenerationJobRecord {
    const now = new Date().toISOString();
    const result = this.workspace.db.prepare(`
      UPDATE image_generation_jobs SET request_sent_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND request_sent_at IS NULL
    `).run(now, now, jobId);
    if (result.changes !== 1) throw repositoryError("IMAGE_JOB_REQUEST_ALREADY_SENT");
    return this.getRequiredJob(jobId);
  }

  markFailed(jobId: string, code: string, message: string): ImageGenerationJobRecord {
    return this.markTerminal(jobId, "failed", code, message, null);
  }

  markReconciliationRequired(jobId: string, code: string, message: string): ImageGenerationJobRecord {
    return this.markTerminal(jobId, "reconciliation_required", code, message, null);
  }

  complete(jobId: string, input: Omit<ImageAssetRecord, "id" | "jobId" | "status" | "createdAt" | "updatedAt"> & {
    providerResponseIdSha256?: string | null;
  }): ImageAssetRecord {
    validateAssetInput(input);
    const assetId = randomUUID();
    const now = new Date().toISOString();
    this.workspace.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getAssetByJob(jobId);
      if (existing) {
        this.workspace.db.exec("ROLLBACK");
        return existing;
      }
      const job = this.getRequiredJob(jobId);
      if (job.status !== "running" || !job.requestSentAt) throw repositoryError("IMAGE_JOB_NOT_COMPLETABLE");
      this.workspace.db.prepare(`
        INSERT INTO image_assets (
          id, job_id, mime_type, width, height, byte_length, sha256, relative_path,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
      `).run(
        assetId, jobId, input.mimeType, input.width, input.height, input.byteLength,
        input.sha256, input.relativePath, now, now,
      );
      const updated = this.workspace.db.prepare(`
        UPDATE image_generation_jobs SET status = 'succeeded', provider_response_id_sha256 = ?,
          error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(input.providerResponseIdSha256 ?? null, now, jobId);
      if (updated.changes !== 1) throw repositoryError("IMAGE_JOB_NOT_COMPLETABLE");
      this.workspace.db.exec("COMMIT");
      return this.getRequiredAsset(assetId);
    } catch (error) {
      if (this.workspace.db.isTransaction) this.workspace.db.exec("ROLLBACK");
      throw error;
    }
  }

  getAssetByJob(jobId: string): ImageAssetRecord | null {
    const row = this.workspace.db.prepare("SELECT * FROM image_assets WHERE job_id = ?").get(jobId);
    return row ? mapAsset(row) : null;
  }

  getRequiredAsset(assetId: string): ImageAssetRecord {
    const row = this.workspace.db.prepare("SELECT * FROM image_assets WHERE id = ?").get(assetId);
    if (!row) throw repositoryError("IMAGE_ASSET_NOT_FOUND");
    return mapAsset(row);
  }

  listPublishedAssets(limit = 500): PublishedImageAssetRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw repositoryError("IMAGE_ASSET_LIST_LIMIT_INVALID");
    }
    const rows = this.workspace.db.prepare(`
      SELECT
        assets.*,
        jobs.title AS job_title,
        jobs.purpose AS job_purpose,
        jobs.source_resource_ids_json AS job_source_resource_ids_json,
        jobs.source_version_ids_json AS job_source_version_ids_json
      FROM image_assets assets
      INNER JOIN image_generation_jobs jobs ON jobs.id = assets.job_id
      WHERE jobs.status = 'succeeded'
      ORDER BY assets.created_at DESC, assets.id DESC
      LIMIT ?
    `).all(limit);
    return rows.map((row) => {
      const value = row as Record<string, unknown>;
      return {
        asset: mapAsset(row),
        title: String(value.job_title),
        purpose: String(value.job_purpose) as ImageGenerationPurpose,
        sourceResourceIds: readStringArray(value.job_source_resource_ids_json),
        sourceVersionIds: readStringArray(value.job_source_version_ids_json),
      };
    });
  }

  listShowcaseJobs(limit = 1_000): ShowcaseImageJobRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw repositoryError("IMAGE_JOB_LIST_LIMIT_INVALID");
    }
    const rows = this.workspace.db.prepare(`
      SELECT
        jobs.id AS job_id,
        jobs.title AS job_title,
        jobs.purpose AS job_purpose,
        jobs.status AS job_status,
        jobs.source_resource_ids_json AS job_source_resource_ids_json,
        jobs.source_version_ids_json AS job_source_version_ids_json,
        jobs.created_at AS job_created_at,
        jobs.updated_at AS job_updated_at,
        assets.id AS asset_id,
        assets.mime_type AS asset_mime_type,
        assets.width AS asset_width,
        assets.height AS asset_height,
        assets.byte_length AS asset_byte_length,
        assets.sha256 AS asset_sha256,
        assets.relative_path AS asset_relative_path,
        assets.status AS asset_status,
        assets.created_at AS asset_created_at,
        assets.updated_at AS asset_updated_at
      FROM image_generation_jobs jobs
      LEFT JOIN image_assets assets ON assets.job_id = jobs.id
      ORDER BY jobs.created_at DESC, jobs.id DESC
      LIMIT ?
    `).all(limit);
    return rows.map((row) => {
      const value = row as Record<string, unknown>;
      const jobId = String(value.job_id);
      return {
        jobId,
        title: String(value.job_title),
        purpose: String(value.job_purpose) as ImageGenerationPurpose,
        status: String(value.job_status) as ImageGenerationJobStatus,
        sourceResourceIds: readStringArray(value.job_source_resource_ids_json),
        sourceVersionIds: readStringArray(value.job_source_version_ids_json),
        asset: value.asset_id === null || value.asset_id === undefined ? null : {
          id: String(value.asset_id),
          jobId,
          mimeType: String(value.asset_mime_type) as ImageAssetRecord["mimeType"],
          width: Number(value.asset_width),
          height: Number(value.asset_height),
          byteLength: Number(value.asset_byte_length),
          sha256: String(value.asset_sha256),
          relativePath: String(value.asset_relative_path),
          status: String(value.asset_status) as ImageAssetStatus,
          createdAt: String(value.asset_created_at),
          updatedAt: String(value.asset_updated_at),
        },
        createdAt: String(value.job_created_at),
        updatedAt: String(value.job_updated_at),
      };
    });
  }

  recoverInterruptedJobs(): { requeued: number; reconciliationRequired: number } {
    const now = new Date().toISOString();
    const requeued = this.workspace.db.prepare(`
      UPDATE image_generation_jobs SET status = 'queued', updated_at = ?
      WHERE status = 'running' AND request_sent_at IS NULL
    `).run(now).changes;
    const reconciliationRequired = this.workspace.db.prepare(`
      UPDATE image_generation_jobs SET status = 'reconciliation_required',
        error_code = 'IMAGE_PROVIDER_OUTCOME_UNKNOWN',
        error_message = '图片请求可能已经发送，必须人工核对后才能重试。', updated_at = ?
      WHERE status = 'running' AND request_sent_at IS NOT NULL
    `).run(now).changes;
    return { requeued: Number(requeued), reconciliationRequired: Number(reconciliationRequired) };
  }

  private assertSourcesExist(resourceIds: string[], versionIds: string[]): void {
    const findResource = this.workspace.db.prepare("SELECT 1 FROM resources WHERE id = ?");
    for (const resourceId of resourceIds) {
      if (!findResource.get(resourceId)) throw repositoryError("IMAGE_JOB_SOURCE_RESOURCE_NOT_FOUND");
    }
    const findVersion = this.workspace.db.prepare(`
      SELECT 1 FROM (
        SELECT id FROM resource_revisions
        UNION ALL SELECT id FROM document_versions
        UNION ALL SELECT id FROM assertion_versions
        UNION ALL SELECT id FROM creative_document_revisions
        UNION ALL SELECT id FROM creative_relation_versions
        UNION ALL SELECT id FROM constraint_profile_versions
        UNION ALL SELECT id FROM project_file_versions
      ) versions WHERE id = ? LIMIT 1
    `);
    for (const versionId of versionIds) {
      if (!findVersion.get(versionId)) throw repositoryError("IMAGE_JOB_SOURCE_VERSION_NOT_FOUND");
    }
  }

  private markTerminal(
    jobId: string,
    status: "failed" | "reconciliation_required",
    code: string,
    message: string,
    providerResponseIdSha256: string | null,
  ): ImageGenerationJobRecord {
    const result = this.workspace.db.prepare(`
      UPDATE image_generation_jobs SET status = ?, error_code = ?, error_message = ?,
        provider_response_id_sha256 = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(status, code.slice(0, 160), message.slice(0, 1000), providerResponseIdSha256, new Date().toISOString(), jobId);
    if (result.changes !== 1) throw repositoryError("IMAGE_JOB_NOT_RUNNING");
    return this.getRequiredJob(jobId);
  }
}

function normalizeJobInput(input: CreateImageGenerationJobInput): CreateImageGenerationJobInput {
  const normalized = {
    idempotencyKey: required(input.idempotencyKey, "idempotencyKey", 240),
    providerId: required(input.providerId, "providerId", 120),
    modelId: required(input.modelId, "modelId", 200),
    title: required(input.title, "title", 240),
    purpose: input.purpose,
    prompt: required(input.prompt, "prompt", 50_000),
    size: required(input.size, "size", 20),
    quality: input.quality,
    background: input.background,
    sourceResourceIds: normalizeIds(input.sourceResourceIds),
    sourceVersionIds: normalizeIds(input.sourceVersionIds),
  };
  if (!(["character_portrait", "scene", "world_map"] as const).includes(normalized.purpose)) {
    throw repositoryError("IMAGE_JOB_PURPOSE_INVALID");
  }
  if (!/^\d{2,4}x\d{2,4}$/.test(normalized.size)) throw repositoryError("IMAGE_JOB_SIZE_INVALID");
  const [width, height] = normalized.size.split("x").map(Number);
  if (width! < 256 || width! > 4096 || height! < 256 || height! > 4096) throw repositoryError("IMAGE_JOB_SIZE_INVALID");
  if (!(["auto", "low", "medium", "high"] as const).includes(normalized.quality)) throw repositoryError("IMAGE_JOB_QUALITY_INVALID");
  if (!(["auto", "transparent", "opaque"] as const).includes(normalized.background)) throw repositoryError("IMAGE_JOB_BACKGROUND_INVALID");
  if (normalized.sourceResourceIds.length === 0 || normalized.sourceVersionIds.length === 0) {
    throw repositoryError("IMAGE_JOB_SOURCE_REQUIRED");
  }
  return normalized;
}

function normalizeIds(values: string[]): string[] {
  const normalized = [...new Set(values.map((value) => required(value, "sourceId", 240)))].sort();
  if (normalized.length > 100) throw repositoryError("IMAGE_JOB_SOURCE_LIMIT_EXCEEDED");
  return normalized;
}

function validateAssetInput(input: {
  mimeType: ImageAssetRecord["mimeType"];
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  relativePath: string;
  providerResponseIdSha256?: string | null;
}): void {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw repositoryError("IMAGE_ASSET_SHA256_INVALID");
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height)
    || input.width < 1 || input.height < 1 || input.width > 16_384 || input.height > 16_384) {
    throw repositoryError("IMAGE_ASSET_DIMENSIONS_INVALID");
  }
  if (!Number.isInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > 100_000_000) {
    throw repositoryError("IMAGE_ASSET_SIZE_INVALID");
  }
  const extension = input.mimeType === "image/png" ? "png" : input.mimeType === "image/jpeg" ? "jpg"
    : input.mimeType === "image/webp" ? "webp" : null;
  if (!extension || input.relativePath !== `.novax/assets/images/${input.sha256}.${extension}`) {
    throw repositoryError("IMAGE_ASSET_PATH_INVALID");
  }
  if (input.providerResponseIdSha256 !== null && input.providerResponseIdSha256 !== undefined
    && !/^[a-f0-9]{64}$/.test(input.providerResponseIdSha256)) {
    throw repositoryError("IMAGE_PROVIDER_RESPONSE_ID_INVALID");
  }
}

function required(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw repositoryError(`IMAGE_JOB_${field.toUpperCase()}_INVALID`);
  return normalized;
}

function mapJob(row: unknown): ImageGenerationJobRecord {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    idempotencyKey: String(value.idempotency_key),
    requestSha256: String(value.request_sha256),
    providerId: String(value.provider_id),
    modelId: String(value.model_id),
    title: String(value.title),
    purpose: String(value.purpose) as ImageGenerationPurpose,
    prompt: String(value.prompt),
    promptSha256: String(value.prompt_sha256),
    size: String(value.size),
    quality: String(value.quality) as ImageGenerationJobRecord["quality"],
    background: String(value.background) as ImageGenerationJobRecord["background"],
    sourceResourceIds: readStringArray(value.source_resource_ids_json),
    sourceVersionIds: readStringArray(value.source_version_ids_json),
    status: String(value.status) as ImageGenerationJobStatus,
    requestSentAt: nullableString(value.request_sent_at),
    providerResponseIdSha256: nullableString(value.provider_response_id_sha256),
    errorCode: nullableString(value.error_code),
    errorMessage: nullableString(value.error_message),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

function mapAsset(row: unknown): ImageAssetRecord {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id), jobId: String(value.job_id),
    mimeType: String(value.mime_type) as ImageAssetRecord["mimeType"],
    width: Number(value.width), height: Number(value.height), byteLength: Number(value.byte_length),
    sha256: String(value.sha256), relativePath: String(value.relative_path),
    status: String(value.status) as ImageAssetStatus,
    createdAt: String(value.created_at), updatedAt: String(value.updated_at),
  };
}

function readStringArray(value: unknown): string[] {
  const parsed = JSON.parse(String(value)) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw repositoryError("IMAGE_JOB_SOURCE_DATA_INVALID");
  }
  return parsed;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function repositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
