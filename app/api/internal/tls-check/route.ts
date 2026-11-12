import { NextResponse } from "next/server"
import { isServableHostname } from "@/server/tenant"

/**
 * Caddy's on-demand TLS check: may a certificate be issued for this hostname?
 *
 * Caddy asks before issuing, and issues only on a 200. The decision itself
 * lives in the tenant resolver, which is the module that already knows which
 * hostnames this deployment answers to — see `isServableHostname` for why it
 * is deliberately narrow.
 *
 * Unauthenticated on purpose: it is reachable only from inside the container
 * network, and it reveals nothing a request to the hostname would not. It
 * takes no action and returns no data, only a status.
 */
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const domain = new URL(req.url).searchParams.get("domain")
  return (await isServableHostname(domain))
    ? new NextResponse("ok", { status: 200 })
    : new NextResponse("unknown host", { status: 404 })
}
