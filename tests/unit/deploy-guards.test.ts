import { describe, it, expect, vi, beforeEach } from "vitest"
import { S3StorageAdapter } from "@/server/storage/s3"
import { assertSafeBootstrapAdmin } from "@/server/db/baseline"

// vi.mock is hoisted above these imports, so the adapter sees the mocked SDK.
const send = vi.fn()
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(public readonly config: unknown) {}
    send(command: unknown) {
      return send(command)
    }
  },
  PutObjectCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
  DeleteObjectCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}))

const config = {
  endpoint: "https://ns.compat.objectstorage.uk-london-1.oraclecloud.com",
  region: "uk-london-1",
  bucket: "game-slots-media",
  accessKeyId: "key",
  secretAccessKey: "secret",
}

describe("S3StorageAdapter", () => {
  beforeEach(() => send.mockReset())

  it("uploads under the given key and returns the object's public url", async () => {
    const adapter = new S3StorageAdapter(config)
    const out = await adapter.put("content/f1.jpg", Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")
    expect(out).toEqual({ url: `${config.endpoint}/${config.bucket}/content/f1.jpg` })
    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> }).input
    expect(input.Bucket).toBe(config.bucket)
    expect(input.Key).toBe("content/f1.jpg")
    expect(input.ContentType).toBe("image/jpeg")
    // Keys carry a UUID and are never reused, so objects are immutable.
    expect(input.CacheControl).toContain("immutable")
  })

  it("serves from a separate public url when one is configured", async () => {
    const adapter = new S3StorageAdapter({ ...config, publicBaseUrl: "https://media.gameslots.com/" })
    const out = await adapter.put("content/f2.png", Buffer.from([0x89]), "image/png")
    // Trailing slash trimmed, so the url never doubles up.
    expect(out.url).toBe("https://media.gameslots.com/content/f2.png")
  })

  it("addresses buckets by path, which is what OCI's S3 endpoint accepts", () => {
    const adapter = new S3StorageAdapter(config)
    const client = (adapter as unknown as { client: { config: { forcePathStyle: boolean } } }).client
    expect(client.config.forcePathStyle).toBe(true)
  })

  it("deletes by key and never claims a local path", async () => {
    const adapter = new S3StorageAdapter(config)
    await adapter.delete("content/f1.jpg")
    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> }).input
    expect(input).toMatchObject({ Bucket: config.bucket, Key: "content/f1.jpg" })
    expect(adapter.localPath()).toBeNull()
  })
})

describe("first production admin", () => {
  it("refuses the development defaults and weak passwords", () => {
    expect(() => assertSafeBootstrapAdmin(undefined, "a-very-strong-password")).toThrow(/BOOTSTRAP_ADMIN_EMAIL/)
    expect(() => assertSafeBootstrapAdmin("admin@gameslots.local", "a-very-strong-password")).toThrow(/BOOTSTRAP_ADMIN_EMAIL/)
    expect(() => assertSafeBootstrapAdmin("owner@example.com", undefined)).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/)
    expect(() => assertSafeBootstrapAdmin("owner@example.com", "ChangeMe123!")).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/)
    expect(() => assertSafeBootstrapAdmin("owner@example.com", "short1!")).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/)
  })
  it("accepts a real email and a strong password", () => {
    expect(() => assertSafeBootstrapAdmin("owner@example.com", "correct-horse-battery-staple")).not.toThrow()
  })
})
