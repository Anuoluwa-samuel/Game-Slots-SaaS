import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { eq } from "drizzle-orm"
import * as schema from "@/server/db/schema"
import { devOverrideAllowed, isPlatformHost, isServableHostname, normalizeHostname, subdomainOf, resolveTenantFromHost } from "@/server/tenant/resolver"
import { assertBelongsToArena, assertSameArena, assertArenaId } from "@/server/tenant/guards"
import { getTenantContextFromRequest, requirePublicTenantFromRequest, requireTenantContextFromRequest } from "@/server/tenant/context"
import { createTestDb } from "../helpers/db"

let ctx: Awaited<ReturnType<typeof createTestDb>>

beforeAll(async () => {
  ctx = await createTestDb()
})
afterAll(async () => {
  await ctx.client.close()
})

/** Every resolution test states the root domain rather than relying on the environment. */
const ROOT = "gameslots.com"
const opts = { root: ROOT } as const

async function createArena(slug: string, status: schema.Arena["status"] = "ACTIVE") {
  const [organization] = await ctx.db.insert(schema.organizations).values({ slug, name: slug, status: "ACTIVE" }).returning()
  const [arena] = await ctx.db
    .insert(schema.arenas)
    .values({ slug, name: slug, organizationId: organization.id, status })
    .returning()
  return arena
}

describe("hostname normalisation", () => {
  it("lowercases and strips the port and trailing dot", () => {
    expect(normalizeHostname("Lekki.GameSlots.com:4000")).toBe("lekki.gameslots.com")
    expect(normalizeHostname("lekki.gameslots.com.")).toBe("lekki.gameslots.com")
  })

  it("rejects anything that is not a bare hostname", () => {
    // A Host header is attacker-controlled; none of these may reach a query.
    expect(normalizeHostname("evil.com/../admin")).toBeNull()
    expect(normalizeHostname("lekki.gameslots.com/path")).toBeNull()
    expect(normalizeHostname("user@evil.com")).toBeNull()
    expect(normalizeHostname("lekki..gameslots.com")).toBeNull()
    expect(normalizeHostname(".gameslots.com")).toBeNull()
    expect(normalizeHostname("lekki arena.com")).toBeNull()
    expect(normalizeHostname("")).toBeNull()
    expect(normalizeHostname(null)).toBeNull()
  })

  it("keeps an IPv6 literal but never treats it as a tenant", () => {
    expect(normalizeHostname("[::1]:4000")).toBe("[::1]")
    expect(subdomainOf("[::1]", "gameslots.com")).toBeNull()
  })
})

describe("subdomain extraction", () => {
  const root = "gameslots.com"

  it("reads a single label beneath the root domain", () => {
    expect(subdomainOf("lekki.gameslots.com", root)).toBe("lekki")
    expect(subdomainOf("ikeja-north.gameslots.com", root)).toBe("ikeja-north")
  })

  it("ignores the root itself and unrelated domains", () => {
    expect(subdomainOf("gameslots.com", root)).toBeNull()
    expect(subdomainOf("gameslots.com.evil.com", root)).toBeNull()
    expect(subdomainOf("notgameslots.com", root)).toBeNull()
  })

  it("refuses nested labels so a.b.root is never read as arena 'a'", () => {
    expect(subdomainOf("a.b.gameslots.com", root)).toBeNull()
  })

  it("refuses reserved platform subdomains", () => {
    for (const reserved of ["www", "api", "admin", "app", "cdn"]) {
      expect(subdomainOf(`${reserved}.gameslots.com`, root), reserved).toBeNull()
    }
  })
})

describe("the platform's own hostname", () => {
  const root = "gameslots.com"

  it("recognises the root domain and its www form", () => {
    expect(isPlatformHost("gameslots.com", root)).toBe(true)
    expect(isPlatformHost("www.gameslots.com", root)).toBe(true)
    expect(isPlatformHost("GAMESLOTS.COM:3000", root)).toBe(true)
  })

  it("refuses a subdomain, so an unresolved arena stays a dead end", () => {
    // The welcome page must not appear at every name wildcard DNS accepts:
    // a typo, a decommissioned arena and a probe all deserve the same 404.
    expect(isPlatformHost("lekki.gameslots.com", root)).toBe(false)
    expect(isPlatformHost("nosucharena.gameslots.com", root)).toBe(false)
    expect(isPlatformHost("www.lekki.gameslots.com", root)).toBe(false)
  })

  it("refuses an arena's own custom domain and any unrelated host", () => {
    expect(isPlatformHost("lekkiarena.com", root)).toBe(false)
    expect(isPlatformHost("gameslots.com.evil.com", root)).toBe(false)
    expect(isPlatformHost("notgameslots.com", root)).toBe(false)
  })

  it("refuses a missing or malformed host rather than defaulting open", () => {
    expect(isPlatformHost(null, root)).toBe(false)
    expect(isPlatformHost("", root)).toBe(false)
    expect(isPlatformHost("..gameslots.com", root)).toBe(false)
  })
})

describe("tenant resolution", () => {
  it("falls back to the only arena while the database has just one", async () => {
    const resolved = await resolveTenantFromHost("localhost:4000")
    expect(resolved?.source).toBe("single-arena")
    expect(resolved?.arena.slug).toBe("main")
  })

  it("stops falling back as soon as a second arena exists", async () => {
    await createArena("lekki")
    expect(await resolveTenantFromHost("localhost:4000", opts)).toBeNull()
  })

  it("resolves an arena from its subdomain", async () => {
    const resolved = await resolveTenantFromHost("lekki.gameslots.com", opts)
    expect(resolved?.source).toBe("subdomain")
    expect(resolved?.arena.slug).toBe("lekki")
  })

  it("does not fall through to another arena when the subdomain matches nothing", async () => {
    expect(await resolveTenantFromHost("nosucharena.gameslots.com", opts)).toBeNull()
  })

  it("resolves a verified custom domain", async () => {
    const lekki = (await ctx.db.query.arenas.findFirst({ where: eq(schema.arenas.slug, "lekki") }))!
    await ctx.db.insert(schema.arenaDomains).values({ arenaId: lekki.id, hostname: "book.lekkiarena.com", status: "VERIFIED" })
    const resolved = await resolveTenantFromHost("Book.LekkiArena.com:443", opts)
    expect(resolved?.source).toBe("custom-domain")
    expect(resolved?.arena.id).toBe(lekki.id)
  })

  it("ignores a custom domain that has not been verified", async () => {
    const lekki = (await ctx.db.query.arenas.findFirst({ where: eq(schema.arenas.slug, "lekki") }))!
    await ctx.db.insert(schema.arenaDomains).values({ arenaId: lekki.id, hostname: "unverified.example.com", status: "PENDING" })
    expect(await resolveTenantFromHost("unverified.example.com", opts)).toBeNull()
  })

  it("resolves an arena that is suspended or still in onboarding — status gating is a separate decision", async () => {
    await createArena("pending-arena", "PENDING_SETUP")
    const resolved = await resolveTenantFromHost("pending-arena.gameslots.com", opts)
    expect(resolved?.arena.status).toBe("PENDING_SETUP")
  })

  it("honours the dev slug override outside production", async () => {
    const resolved = await resolveTenantFromHost("localhost:4000", { ...opts, devSlug: "lekki" })
    expect(resolved?.source).toBe("dev-override")
    expect(resolved?.arena.slug).toBe("lekki")
  })

  it("ignores the dev slug override in production", async () => {
    // The override is the one way a request names its own tenant, so it must
    // be impossible to reach on a production deployment.
    expect(devOverrideAllowed(true)).toBe(false)
    expect(devOverrideAllowed(false)).toBe(true)
    const resolved = await resolveTenantFromHost("localhost:4000", { ...opts, devSlug: "lekki", allowDevOverride: false })
    expect(resolved).toBeNull()
  })
})

describe("tenant guards", () => {
  const arenaA = "11111111-1111-1111-1111-111111111111"
  const arenaB = "22222222-2222-2222-2222-222222222222"

  it("returns a row that belongs to the arena", () => {
    expect(assertBelongsToArena({ arenaId: arenaA, id: "x" }, arenaA)).toEqual({ arenaId: arenaA, id: "x" })
  })

  it("reports another arena's row as not found, never as forbidden", () => {
    // "Forbidden" would confirm the id exists, which is how an attacker
    // enumerates another arena's bookings.
    expect(() => assertBelongsToArena({ arenaId: arenaB }, arenaA, "Booking")).toThrowError(/Booking not found/)
    try {
      assertBelongsToArena({ arenaId: arenaB }, arenaA, "Booking")
    } catch (err) {
      expect((err as { code: string }).code).toBe("NOT_FOUND")
    }
  })

  it("treats a missing row the same as another arena's row", () => {
    expect(() => assertBelongsToArena(null, arenaA, "Ticket")).toThrowError(/Ticket not found/)
    expect(() => assertBelongsToArena(undefined, arenaA, "Ticket")).toThrowError(/Ticket not found/)
  })

  it("refuses to relate rows from different arenas", () => {
    expect(() => assertSameArena({ arenaId: arenaA }, { arenaId: arenaB }, "booking→session")).toThrowError(/different arenas/)
    expect(() => assertSameArena({ arenaId: arenaA }, { arenaId: null }, "booking→session")).toThrowError(/different arenas/)
    expect(() => assertSameArena({ arenaId: arenaA }, { arenaId: arenaA }, "booking→session")).not.toThrow()
  })

  it("refuses an empty arena scope rather than running an unscoped query", () => {
    expect(() => assertArenaId(undefined, "listBookings")).toThrowError(/Tenant scope missing/)
    expect(() => assertArenaId("", "listBookings")).toThrowError(/Tenant scope missing/)
    expect(assertArenaId(arenaA, "listBookings")).toBe(arenaA)
  })
})

/**
 * The context layer end to end, driven by a real Request. The root domain in
 * tests is `localhost` (derived from APP_URL), so `{slug}.localhost` is the
 * subdomain form here.
 */
describe("tenant context from a request", () => {
  const req = (host: string, path = "http://localhost:4000/api/sessions") =>
    new Request(path, { headers: { host } })

  it("resolves the arena named by the hostname", async () => {
    const tenant = await getTenantContextFromRequest(req("lekki.localhost"))
    expect(tenant?.arena.slug).toBe("lekki")
  })

  it("prefers x-forwarded-host, which is what a proxy sets", async () => {
    const request = new Request("http://localhost:4000/api/sessions", {
      headers: { host: "internal-lb.example.com", "x-forwarded-host": "lekki.localhost" },
    })
    const tenant = await getTenantContextFromRequest(request)
    expect(tenant?.arena.slug).toBe("lekki")
  })

  it("refuses an address that matches no arena", async () => {
    await expect(requireTenantContextFromRequest(req("evil.com"))).rejects.toMatchObject({ code: "ARENA_NOT_FOUND" })
  })

  it("serves an active arena to the public", async () => {
    const tenant = await requirePublicTenantFromRequest(req("lekki.localhost"))
    expect(tenant.arena.status).toBe("ACTIVE")
  })

  it("hides an arena that has not launched behind the same 404 as a missing one", async () => {
    // PENDING_SETUP must not be distinguishable from "no such arena", or an
    // unlaunched tenant becomes discoverable by probing subdomains.
    await expect(requirePublicTenantFromRequest(req("pending-arena.localhost"))).rejects.toMatchObject({
      code: "ARENA_NOT_FOUND",
    })
  })

  it("answers 503 for a suspended arena, which does exist", async () => {
    await createArena("suspended-arena", "SUSPENDED")
    await expect(requirePublicTenantFromRequest(req("suspended-arena.localhost"))).rejects.toMatchObject({
      code: "ARENA_UNAVAILABLE",
      status: 503,
    })
  })

  it("still reaches a suspended or unlaunched arena for admin surfaces", async () => {
    const tenant = await requireTenantContextFromRequest(req("pending-arena.localhost"))
    expect(tenant.arena.status).toBe("PENDING_SETUP")
  })

  it("honours the dev override on a request outside production", async () => {
    const request = new Request("http://localhost:4000/api/sessions?__arena=lekki", { headers: { host: "localhost" } })
    const tenant = await getTenantContextFromRequest(request)
    expect(tenant?.source).toBe("dev-override")
    expect(tenant?.arena.slug).toBe("lekki")
  })
})

describe("which hostnames deserve a certificate", () => {
  /**
   * The TLS terminator asks this before issuing. Saying yes to anything would
   * let a stranger point their DNS here and spend the certificate authority's
   * rate limit on hostnames this deployment does not serve.
   */
  it("serves the platform root and its www form", async () => {
    expect(await isServableHostname(ROOT, ROOT)).toBe(true)
    expect(await isServableHostname(`www.${ROOT}`, ROOT)).toBe(true)
  })

  it("serves a live arena's subdomain", async () => {
    const arena = await createArena("cert-live")
    expect(arena.status).toBe("ACTIVE")
    expect(await isServableHostname(`cert-live.${ROOT}`, ROOT)).toBe(true)
  })

  it("refuses a subdomain that matches no arena", async () => {
    expect(await isServableHostname(`nosucharena.${ROOT}`, ROOT)).toBe(false)
  })

  it("refuses a custom domain until it is verified", async () => {
    // An unverified row is a claim, not proof — the same rule that decides
    // whose storefront to serve decides who gets a certificate.
    const arena = await createArena("cert-domains")
    await ctx.db.insert(schema.arenaDomains).values({ arenaId: arena.id, hostname: "cert-pending.example.com", status: "PENDING" })
    await ctx.db.insert(schema.arenaDomains).values({ arenaId: arena.id, hostname: "cert-ok.example.com", status: "VERIFIED" })
    expect(await isServableHostname("cert-pending.example.com", ROOT)).toBe(false)
    expect(await isServableHostname("cert-ok.example.com", ROOT)).toBe(true)
  })

  it("refuses a missing or malformed host rather than defaulting open", async () => {
    for (const bad of [null, "", "..evil.com", "evil.com/path"]) {
      expect(await isServableHostname(bad, ROOT), String(bad)).toBe(false)
    }
  })
})
