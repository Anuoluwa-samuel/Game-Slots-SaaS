import "server-only"
import { env } from "@/server/env"
import { LocalStorageAdapter } from "./local"
import { S3StorageAdapter } from "./s3"

/**
 * Object storage abstraction. Files are never stored in the database.
 *
 * `local` is disk, for development and for a single server that keeps its
 * volume. `s3` is any S3-compatible object store — Oracle Cloud Object
 * Storage, MinIO, R2 — which is what a deployment behind more than one server,
 * or one whose disk is not durable, needs.
 */
export interface StorageAdapter {
  readonly name: string
  put(key: string, data: Buffer, contentType: string): Promise<{ url: string }>
  delete(key: string): Promise<void>
  /** Absolute filesystem path or null when not locally served. */
  localPath(key: string): string | null
}

let cached: StorageAdapter | undefined
export function getStorage(): StorageAdapter {
  if (cached) return cached
  if (env.STORAGE_DRIVER === "s3") {
    cached = new S3StorageAdapter({
      endpoint: env.STORAGE_ENDPOINT!,
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET!,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY!,
      publicBaseUrl: env.STORAGE_PUBLIC_URL,
    })
  } else {
    cached = new LocalStorageAdapter(env.UPLOAD_DIR, "/api/media/files")
  }
  return cached
}
