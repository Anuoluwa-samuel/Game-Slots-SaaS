# Deployment

Game Slots runs as four containers on one server: Postgres, a one-shot
migration, the Next.js app, and Caddy terminating TLS in front. It is written
for an Oracle Cloud Ampere A1 instance, and nothing in it is Oracle-specific
beyond the object storage endpoint — the same compose file runs on any host
with Docker.

## Why one server

Two arenas and a few hundred bookings a month do not need a cluster, and a
cluster would add a control plane to patch, a registry to run and a second
failure mode to debug. One instance with a volume, a nightly backup and a
tested restore is a better position than three nodes nobody has restored from.

The things that would change this are real but not yet true: a second region,
a release cadence that cannot tolerate a few seconds of downtime, or enough
tenants that one Postgres is the bottleneck.

## The instance

An **Ampere A1** shape. Oracle's Always Free tier covers 4 OCPUs and 24 GB of
memory, which is more than this needs; the app is comfortable in 1 GB.

- **Image:** Oracle Linux 9 or Ubuntu 24.04, arm64.
- **Boot volume:** 50 GB is ample. Postgres and uploads both live on it unless
  uploads go to Object Storage, which they should.
- **Ingress:** open 80 and 443 in the instance's security list *and* in
  `firewalld`/`ufw` on the host. Oracle images block ports at both layers, and
  forgetting the host firewall is the usual reason a correct security list
  still times out.
- **Never open 5432.** The compose file does not publish it; the database is
  reachable only from the app's network.

## DNS

Two records, both pointing at the instance's public IP:

```
A     gameslots.com        <instance-ip>
A     *.gameslots.com      <instance-ip>
```

The wildcard is what makes `{arena}.gameslots.com` work for arenas that do not
exist yet. A venue bringing its own domain adds its own A record pointing here,
and verifies it in the admin before it will be served.

## TLS

Certificates are issued **on demand** rather than listed, because the set of
hostnames is not known at deploy time. Caddy asks the app before issuing — see
`/api/internal/tls-check`, which answers from the same rules that decide whose
storefront to serve:

- the platform root and its `www` form;
- a subdomain matching a live arena;
- a custom domain that arena has **verified**.

Anything else gets a 404 and no certificate. Without that gate, on-demand TLS
would attempt issuance for any hostname somebody pointed at this IP, which is
how a stranger's DNS record exhausts your certificate authority rate limit.

The `caddy-data` volume holds the issued certificates. Losing it means
re-issuing every tenant's certificate at once, which the rate limits will not
enjoy — so it is in the backup set below.

## Object storage

Uploads belong in **OCI Object Storage**, not on the instance disk, so that
replacing the container or the instance does not lose them.

1. Create a bucket and set its visibility to **public** (objects are served
   directly to browsers).
2. Create a **Customer Secret Key** under your user — that is the access key
   and secret pair OCI's S3-compatible endpoint uses. It is not the same thing
   as an API signing key.
3. Set:

```
STORAGE_DRIVER=s3
STORAGE_ENDPOINT=https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
STORAGE_REGION=<region>
STORAGE_BUCKET=<bucket>
STORAGE_ACCESS_KEY_ID=<customer secret key id>
STORAGE_SECRET_ACCESS_KEY=<customer secret key>
```

`STORAGE_DRIVER=local` in production is refused unless `ALLOW_LOCAL_UPLOADS=1`
says the upload directory is a persistent volume. The refusal exists because
local uploads fail silently: everything works until the container is replaced,
and then every image is a broken link.

## Environment

Copy `.env.example` to `.env` **on the server** and fill it in. It is read by
the app and the migration container, and it is in `.dockerignore` so it is
never baked into an image.

Required in production, beyond the storage keys above:

| | |
|---|---|
| `APP_URL` | `https://gameslots.com` |
| `APP_ROOT_DOMAIN` | `gameslots.com` — the domain arena subdomains hang off |
| `POSTGRES_PASSWORD` | compose builds `DATABASE_URL` from this |
| `SESSION_SECRET` | 32+ random bytes |
| `QR_SECRET` | 32+ random bytes; per-arena ticket keys derive from it |
| `CREDENTIALS_KEY` | 32+ random bytes; encrypts arena payment credentials |
| `CRON_SECRET` | authorises the housekeeping endpoint |
| `ACME_EMAIL` | where Let's Encrypt sends expiry warnings |
| `PAYMENT_PROVIDER` | `paystack`; `mock` is refused in production |
| `BOOTSTRAP_ADMIN_*` | the platform owner, created on first migration |
| `BOOTSTRAP_ARENA_OWNER_*` | the default arena's owner — a different person |

Generate the secrets with `openssl rand -hex 32`. Rotating `CREDENTIALS_KEY`
makes stored payment credentials unreadable and each arena has to re-enter
them, so treat it as the one that does not rotate casually.

## Deploying

```bash
git pull
docker compose up -d --build
```

`migrate` runs to completion before `app` starts, so the first request never
races a migration and a failed migration stops the deploy rather than leaving
a half-upgraded database serving traffic.

Watch it land:

```bash
docker compose logs -f migrate app
```

## The scheduled job

`/api/cron/housekeeping` expires stale holds, syncs session lifecycle and
re-verifies stranded payments. It needs `Authorization: Bearer $CRON_SECRET`
and accepts GET or POST.

A systemd timer on the host is the simplest scheduler that reports failures:

```ini
# /etc/systemd/system/gameslots-housekeeping.service
[Unit]
Description=Game Slots housekeeping

[Service]
Type=oneshot
EnvironmentFile=/opt/game-slots/.env
ExecStart=/usr/bin/curl -fsS -X POST -H "Authorization: Bearer ${CRON_SECRET}" https://gameslots.com/api/cron/housekeeping
```

```ini
# /etc/systemd/system/gameslots-housekeeping.timer
[Unit]
Description=Run Game Slots housekeeping daily

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now gameslots-housekeeping.timer
```

`Persistent=true` so a run missed while the instance was down happens on the
next boot rather than being skipped.

## Backups

Three things are worth keeping, and only the first is interesting:

1. **The database.** Everything that matters is in it.
2. **`caddy-data`** — the issued certificates, per the rate-limit note above.
3. **Uploads**, unless they are in Object Storage, which replicates them.

```bash
# /etc/cron.daily/gameslots-backup
docker compose -f /opt/game-slots/docker-compose.yml exec -T db \
  pg_dump -U gameslots gameslots | gzip > /opt/game-slots/backups/$(date +%F).sql.gz
find /opt/game-slots/backups -name '*.sql.gz' -mtime +14 -delete
```

Copy them off the instance — an OCI Object Storage bucket with a lifecycle
rule, or anywhere that is not this server. A backup on the machine it is
backing up is not a backup.

**Restore, and test it:**

```bash
gunzip -c backups/2026-01-01.sql.gz | \
  docker compose exec -T db psql -U gameslots -d gameslots
```

A restore nobody has run is a plan, not a backup. Run one against a scratch
database before you need it.

## Health and monitoring

`GET /api/health` touches the database, so it reports what a request would
actually find rather than that the process exists. The container's own
healthcheck uses it, so an unhealthy container is one that cannot serve.

Logs are structured JSON on stdout:

```bash
docker compose logs -f app
docker compose logs app | grep '"level":"error"'
```

For anything beyond that, ship them somewhere — OCI Logging, or any collector
that reads container stdout.

## Rolling back

Images are built from the working tree, so a rollback is a checkout and a
rebuild:

```bash
git checkout <previous-tag>
docker compose up -d --build
```

**Migrations do not roll back.** The chain is forward-only by design, so
reverting code that expects a newer schema works only while the older code
tolerates the newer schema — which is the usual case for added columns and not
the case for dropped ones. Before deploying a migration that removes anything,
know what the previous release does without it.

## Moving off this host

The things that tie the app to anywhere are configuration: `STORAGE_ENDPOINT`
for uploads, `DATABASE_URL` for data, and DNS. The storage adapter speaks the
S3 API rather than any provider's own, which is what made moving here a change
of configuration rather than of code. Keep it that way.
