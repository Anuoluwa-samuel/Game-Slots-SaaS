import "server-only"

/**
 * Tenant resolution and the guards that keep one arena's data out of
 * another's request. See docs/MULTI_TENANCY.md.
 */
export {
  getTenantContext,
  getTenantContextFromRequest,
  requireTenantContext,
  requireTenantContextFromRequest,
  requirePublicTenant,
  requirePublicTenantFromRequest,
  type TenantContext,
} from "./context"
export { requirePublicTenantForPage, requireTenantContextForPage, requirePublicTenantOrPlatformHome } from "./page"
export { assertBelongsToArena, assertSameArena, assertArenaId } from "./guards"
export {
  normalizeHostname,
  rootDomain,
  subdomainOf,
  isPlatformHost,
  isServableHostname,
  resolveTenantFromHost,
  RESERVED_SUBDOMAINS,
  type ResolvedTenant,
  type TenantSource,
} from "./resolver"
