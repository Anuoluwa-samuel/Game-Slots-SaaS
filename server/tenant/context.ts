import "server-only"
import { cache } from "react"
import { headers } from "next/headers"
import { AppError } from "@/server/http/errors"
import type { schema } from "@/server/db"
import { logger } from "@/server/observability/logger"
import { devOverrideAllowed, resolveTenantFromHost, type ResolvedTenant, type TenantSource } from "./resolver"

/**
 * The arena a request is addressed to.
 *
 * Deliberately free of `next/navigation`: this module is on the path of the
 * session loader, which runs in scripts and tests as well as in requests. The
 * page-rendering helpers live in `./page` for that reason.
 *
 * This is the *addressing* half of multi-tenancy: which arena's storefront is
 * being viewed. It is not, on its own, permission to read or write that
 * arena's data — authorisation resolves the arena from the caller's
 * membership and compares the two.
 */
export interface TenantContext {
  arena: schema.Arena
  arenaId: string
  source: TenantSource
}

const DEV_SLUG_HEADER = "x-arena-slug"
const DEV_SLUG_PARAM = "__arena"

function toContext(resolved: ResolvedTenant): TenantContext {
  return { arena: resolved.arena, arenaId: resolved.arena.id, source: resolved.source }
}

/**
 * Behind a proxy the original host is in `x-forwarded-host`; Caddy and most
 * load balancers set it. `host` is the direct value.
 */
function hostFrom(get: (name: string) => string | null) {
  return get("x-forwarded-host") ?? get("host")
}

/** Dev-only slug override so a second tenant can be exercised over plain localhost. */
function devSlugFrom(get: (name: string) => string | null, url?: string) {
  if (!devOverrideAllowed()) return null
  const fromHeader = get(DEV_SLUG_HEADER)
  if (fromHeader) return fromHeader
  if (!url) return null
  try {
    return new URL(url).searchParams.get(DEV_SLUG_PARAM)
  } catch {
    return null
  }
}

/**
 * The tenant for the current request, or null when the hostname matches no
 * arena. Memoised per request, so resolving it in a layout and again in a
 * page costs one query.
 */
export const getTenantContext = cache(async (): Promise<TenantContext | null> => {
  const store = await headers()
  const get = (name: string) => store.get(name)
  const resolved = await resolveTenantFromHost(hostFrom(get), { devSlug: devSlugFrom(get) })
  return resolved ? toContext(resolved) : null
})

/** Same resolution for handlers that hold the Request rather than the header store. */
export async function getTenantContextFromRequest(req: Request): Promise<TenantContext | null> {
  const get = (name: string) => req.headers.get(name)
  const resolved = await resolveTenantFromHost(hostFrom(get), { devSlug: devSlugFrom(get, req.url) })
  return resolved ? toContext(resolved) : null
}

/**
 * The tenant, or a 404. Use for surfaces that exist for any arena the
 * operator can reach — including one still in onboarding.
 */
export async function requireTenantContext(): Promise<TenantContext> {
  const tenant = await getTenantContext()
  if (!tenant) throw arenaNotFound()
  return tenant
}

export async function requireTenantContextFromRequest(req: Request): Promise<TenantContext> {
  const tenant = await getTenantContextFromRequest(req)
  if (!tenant) throw arenaNotFound()
  return tenant
}

/**
 * The tenant for a customer-facing page. An arena that has not launched, has
 * been suspended or archived is not browsable, and says so without revealing
 * which of those it is.
 */
export async function requirePublicTenant(): Promise<TenantContext> {
  return assertPublic(await requireTenantContext())
}

export async function requirePublicTenantFromRequest(req: Request): Promise<TenantContext> {
  return assertPublic(await requireTenantContextFromRequest(req))
}

function assertPublic(tenant: TenantContext): TenantContext {
  if (tenant.arena.status === "ACTIVE") return tenant
  logger.warn("tenant.not_public", { arenaId: tenant.arenaId, status: tenant.arena.status })
  if (tenant.arena.status === "SUSPENDED") {
    throw new AppError("ARENA_UNAVAILABLE", "This arena is temporarily unavailable", { status: 503 })
  }
  // PENDING_SETUP and ARCHIVED are indistinguishable from "no such arena" on
  // purpose: an unlaunched tenant should not be discoverable by probing.
  throw arenaNotFound()
}

function arenaNotFound() {
  return new AppError("ARENA_NOT_FOUND", "No arena is configured for this address")
}
