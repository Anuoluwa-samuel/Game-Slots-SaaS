/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
]

const privateHeaders = [{ key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" }]

const nextConfig = {
  // Produces .next/standalone: a self-contained server with only the modules
  // it actually imports, which is what keeps the container image small enough
  // to be worth rebuilding on every deploy.
  output: "standalone",
  // Type errors fail the build — no silent shipping of broken code.
  typescript: { ignoreBuildErrors: false },
  images: { unoptimized: true },
  // Keep the embedded Postgres (WASM) and node-postgres out of the bundler.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  poweredByHeader: false,
  // Dev only: let phones on the local network load dev assets from this Mac.
  allowedDevOrigins: ["172.20.10.3", "192.168.*.*", "10.*.*.*", "172.*.*.*"],
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // Pages that show one person's account or one arena's admin data. Next
      // already renders them on demand; this states that no shared cache may
      // keep a copy, which matters in front of a CDN where "no-cache" still
      // permits storage. Applied at the routing layer because the renderer
      // sets its own Cache-Control afterwards.
      { source: "/account/:path*", headers: privateHeaders },
      { source: "/admin/:path*", headers: privateHeaders },
      { source: "/tickets/:path*", headers: privateHeaders },
      { source: "/checkout/:path*", headers: privateHeaders },
    ]
  },
}

export default nextConfig
