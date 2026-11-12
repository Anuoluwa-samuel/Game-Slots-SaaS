import "server-only"
import { and, eq, isNull, sql } from "drizzle-orm"
import { db, schema } from "@/server/db"
import { env } from "@/server/env"

/**
 * Turns a request hostname into an arena.
 *
 * The Host header is attacker-controlled, so it is only ever used to *select*
 * a public tenant, never to prove access to one. A host is accepted only when
 * it matches a verified custom domain or a real arena slug beneath the
 * configured root domain; an unrecognised host resolves to nothing rather
 * than falling back to "whichever arena happens to be first".
 */

/** Subdomains that belong to the platform and can never be an arena slug. */
export const RESERVED_SUBDOMAINS = new Set([
  "www",
  "app",
  "admin",
  "api",
  "auth",
  "static",
  "assets",
  "cdn",
  "mail",
  "smtp",
  "ftp",
  "status",
  "docs",
  "support",
  "billing",
  "dashboard",
  "platform",
  "localhost",
])

export type TenantSource = "custom-domain" | "subdomain" | "dev-override" | "single-arena"

export interface ResolvedTenant {
  arena: schema.Arena
  source: TenantSource
}

/**
 * Lowercases, drops the port and a trailing dot, and rejects anything that is
 * not a plain hostname. Returns null for input that cannot be a host, so a
 * caller can never accidentally treat `evil.com/../x` as a name to look up.
 */
export function normalizeHostname(raw: string | null | undefined): string | null {
  if (!raw) return null
  let host = raw.trim().toLowerCase()
  if (!host) return null
  // Strip the port. IPv6 literals arrive bracketed, e.g. `[::1]:4000`.
  if (host.startsWith("[")) {
    const close = host.indexOf("]")
    if (close === -1) return null
    host = host.slice(0, close + 1)
  } else {
    const colon = host.indexOf(":")
    if (colon !== -1) host = host.slice(0, colon)
  }
  if (host.endsWith(".")) host = host.slice(0, -1)
  if (!host) return null
  if (host.startsWith("[")) return host // IPv6 literal, never a tenant host
  if (!/^[a-z0-9.-]+$/.test(host)) return null
  if (host.includes("..") || host.startsWith(".") || host.startsWith("-")) return null
  return host
}

/** The domain arena subdomains hang off, e.g. `gameslots.com`. */
export function rootDomain(): string {
  if (env.APP_ROOT_DOMAIN) return env.APP_ROOT_DOMAIN.toLowerCase()
  const fromAppUrl = normalizeHostname(new URL(env.APP_URL).host)
  return fromAppUrl ?? "localhost"
}

/**
 * Whether a hostname is the platform's own, rather than any arena's.
 *
 * True only for the root domain itself and its `www` form — `gameslots.com`,
 * `www.gameslots.com`, or `localhost` in development. This is where the
 * welcome and sign-up pages live, because it is the address an operator
 * reaches before they have an arena at all.
 *
 * Deliberately narrow. A subdomain that matches no arena is *not* the platform
 * host: it stays the dead end `subdomainOf` makes it, so a typo, a decommissioned
 * arena or a wildcard-DNS probe gets a 404 rather than an infinite supply of
 * marketing pages at every name anyone cares to try.
 */
export function isPlatformHost(rawHost: string | null | undefined, root = rootDomain()): boolean {
  const host = normalizeHostname(rawHost)
  if (!host) return false
  return host === root || host === `www.${root}`
}

/**
 * Whether a request may name its tenant directly, with `?__arena=` or the
 * `x-arena-slug` header. Never in production: it would let anyone pick a
 * tenant with a query string. Takes the flag as an argument so the rule is
 * testable without reloading the environment module.
 */
export function devOverrideAllowed(isProd: boolean = env.isProd): boolean {
  return !isProd
}

/**
 * Extracts the arena slug from `{slug}.{root}`. Returns null when the host is
 * the root itself, a reserved subdomain, or a deeper name — one label only, so
 * `a.b.gameslots.com` is not silently read as arena `a`.
 */
export function subdomainOf(host: string, root = rootDomain()): string | null {
  if (host === root) return null
  if (!host.endsWith(`.${root}`)) return null
  const label = host.slice(0, -(root.length + 1))
  if (!label || label.includes(".")) return null
  if (RESERVED_SUBDOMAINS.has(label)) return null
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(label)) return null
  return label
}

async function arenaBySlug(slug: string) {
  const database = await db()
  return database.query.arenas.findFirst({
    where: and(eq(schema.arenas.slug, slug), isNull(schema.arenas.deletedAt)),
  })
}

/** Only a VERIFIED domain resolves: an unverified row is a claim, not proof. */
async function arenaByCustomDomain(host: string) {
  const database = await db()
  const domain = await database.query.arenaDomains.findFirst({
    where: and(sql`lower(${schema.arenaDomains.hostname}) = ${host}`, eq(schema.arenaDomains.status, "VERIFIED")),
  })
  if (!domain) return undefined
  const database2 = await db()
  return database2.query.arenas.findFirst({
    where: and(eq(schema.arenas.id, domain.arenaId), isNull(schema.arenas.deletedAt)),
  })
}

/**
 * The single-arena escape hatch. A deployment that has exactly one arena — the
 * shape every installation has before it takes its second tenant — keeps
 * working on any hostname. With two or more arenas it returns nothing, so a
 * misconfigured host fails loudly instead of leaking whichever arena sorts
 * first.
 */
async function soleArena() {
  const database = await db()
  const arenas = await database.query.arenas.findMany({ where: isNull(schema.arenas.deletedAt), limit: 2 })
  return arenas.length === 1 ? arenas[0] : undefined
}

export interface ResolveOptions {
  /**
   * Development-only slug override, from `?__arena=` or the `x-arena-slug`
   * header. Honoured only when `allowDevOverride` is true.
   */
  devSlug?: string | null
  /** Root domain to read subdomains against. Defaults to the configured one. */
  root?: string
  /** Defaults to "not production". Passed explicitly by tests. */
  allowDevOverride?: boolean
}

/** Resolves the arena a request is addressed to, or null when none matches. */
export async function resolveTenantFromHost(
  rawHost: string | null | undefined,
  options: ResolveOptions = {}
): Promise<ResolvedTenant | null> {
  if (options.devSlug && (options.allowDevOverride ?? devOverrideAllowed())) {
    const arena = await arenaBySlug(options.devSlug.toLowerCase())
    if (arena) return { arena, source: "dev-override" }
    return null
  }

  const host = normalizeHostname(rawHost)
  if (host) {
    const byDomain = await arenaByCustomDomain(host)
    if (byDomain) return { arena: byDomain, source: "custom-domain" }

    const slug = subdomainOf(host, options.root ?? rootDomain())
    if (slug) {
      const arena = await arenaBySlug(slug)
      // A subdomain that looks like a tenant but matches no arena is a dead
      // end, not a reason to fall through to the sole-arena rule.
      return arena ? { arena, source: "subdomain" } : null
    }
  }

  const only = await soleArena()
  return only ? { arena: only, source: "single-arena" } : null
}

/**
 * Whether this deployment would serve a hostname at all.
 *
 * Asked by the TLS terminator before it issues a certificate. A multi-tenant
 * platform cannot list its certificates up front — arenas appear whenever
 * somebody registers one, and a venue may later point its own domain here — so
 * the set of hostnames worth a certificate is a query rather than a config
 * file.
 *
 * Narrow on purpose. Answering yes to anything would let a stranger aim their
 * DNS at this server and burn the certificate authority's rate limit on
 * hostnames nobody here serves. An unverified custom domain is a claim rather
 * than proof and gets nothing, which is the same rule tenant resolution
 * applies when deciding whose storefront to serve.
 */
export async function isServableHostname(rawHost: string | null | undefined, root = rootDomain()): Promise<boolean> {
  const host = normalizeHostname(rawHost)
  if (!host) return false
  if (host === root || host === `www.${root}`) return true

  const slug = subdomainOf(host, root)
  if (slug) {
    const arena = await arenaBySlug(slug)
    return Boolean(arena && arena.status !== "ARCHIVED")
  }

  return Boolean(await arenaByCustomDomain(host))
}
