# Game Slots — production image.
#
# Multi-stage so the thing that ships carries no compiler, no devDependencies
# and no source: `output: "standalone"` in next.config.mjs produces a server
# with only the modules it actually imports.
#
# Node 24 on Alpine. Oracle's Ampere A1 instances are arm64, and every stage
# here builds natively on either architecture — `docker build` on an Apple
# Silicon Mac produces an arm64 image that runs on A1 unchanged.

# ---------------------------------------------------------------- deps
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` from the lockfile: a deploy must install what was tested, not
# whatever the registry considers current today.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------- build
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build runs `tsc` and lints nothing it has not type-checked: a type error
# fails the image rather than shipping.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------------------------------------------------------------- migrate
# Carries the source and devDependencies so `tsx` can run the migration
# script. Compose runs this to completion before the app starts, which makes
# migrating an explicit step with its own logs rather than a side effect of
# the first request.
FROM node:24-alpine AS migrate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
CMD ["npm", "run", "db:migrate"]

# ---------------------------------------------------------------- runtime
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# An unprivileged user: a process that only needs to read its own bundle and
# talk to Postgres has no reason to be able to write to its image.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# The health endpoint touches the database, so an unhealthy container is one
# that cannot serve a request rather than one whose process merely exists.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
