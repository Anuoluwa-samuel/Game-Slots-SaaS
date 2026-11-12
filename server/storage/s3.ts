import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import type { StorageAdapter } from "./index"

/**
 * Object storage over the S3 API.
 *
 * Written for Oracle Cloud Infrastructure Object Storage, which exposes an
 * S3-compatible endpoint, but the same adapter serves any S3 implementation —
 * AWS, MinIO, Cloudflare R2 — by pointing `STORAGE_ENDPOINT` at it. That is
 * the reason to speak S3 rather than OCI's native API: it keeps the host a
 * configuration detail instead of a code dependency, which is what made moving
 * off the previous host a small change rather than a rewrite.
 *
 * `@aws-sdk/client-s3` is a dependency rather than hand-rolled requests
 * because the hard part of S3 is SigV4 request signing, and a signing bug is
 * the kind that fails silently or leaks credentials. This is not a wheel worth
 * reinventing.
 *
 * Files are served from a public bucket, so the URL on the media row is the
 * object's own. Keys already contain a UUID and are never reused, so objects
 * are immutable and can be cached for a year.
 */
export interface S3StorageConfig {
  /** e.g. https://<namespace>.compat.objectstorage.uk-london-1.oraclecloud.com */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Where the public reads the objects from, when that differs from the endpoint. */
  publicBaseUrl?: string
}

export class S3StorageAdapter implements StorageAdapter {
  readonly name = "s3"
  private readonly client: S3Client
  private readonly bucket: string
  private readonly publicBaseUrl: string

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // OCI's S3 endpoint addresses buckets by path rather than by a
      // bucket-named subdomain; virtual-host style requests 404 there.
      forcePathStyle: true,
    })
    this.publicBaseUrl = (config.publicBaseUrl ?? `${config.endpoint}/${config.bucket}`).replace(/\/+$/, "")
  }

  async put(key: string, data: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      })
    )
    return { url: `${this.publicBaseUrl}/${key}` }
  }

  async delete(key: string) {
    // S3 deletes are idempotent: removing an object that is not there
    // succeeds, which is the behaviour the caller wants when retrying.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  localPath() {
    return null
  }
}
