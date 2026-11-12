# Operations

## Running it locally

```bash
npm install
npm run db:seed     # two arenas, with staff, customers, bookings and tickets
npm run dev         # http://localhost:4000
```

The seed prints its accounts. Reach the two arenas at `main.localhost:4000`
and `lekki.localhost:4000`, or with an `x-arena-slug` header outside
production.

**The embedded database allows one process at a time.** Never run a script that
opens it while the dev server is running — PGlite holds an exclusive lock, and
a second attachment leaves the directory unopenable with
`RuntimeError: Aborted()`. Stop the server first, or take the data over HTTP.

## Migrations

```bash
npm run db:generate   # diff schema.ts into a new migration
npm run db:migrate    # apply pending migrations + baseline rows
```

Migrations run automatically on boot. Before a production migration:

1. Take a backup and confirm it restores.
2. Apply it to staging with production-shaped data.
3. Run `scripts/dev/tenancy-report.ts` before and after — it prints rows with
   no tenant and any cross-tenant relationship, and works against an
   unmigrated database too.
4. Check locking behaviour and expected duration for large tables.
5. Apply, re-run the report, watch error rates.

Two migrations in this sequence refuse to proceed rather than guess, and that
is deliberate:

- `0005` leaves `arena_id` null where more than one arena exists instead of
  attributing rows by assumption.
- `0011` refuses to drop the legacy identity columns if any active user would
  be left with neither a membership nor a platform role.

`scripts/dev/attribute-orphan-customers.ts` is the remedy for the first, and
prints what it would do before `--apply`.

## Backups and recovery

- Managed Postgres with automated backups and point-in-time recovery.
- **A backup that has never been restored is not a backup.** Restore into a
  scratch database on a schedule and run the tenancy report against it.
- Uploads live in object storage; back that up on its own schedule. A database
  restored to an earlier point will reference objects the store still holds,
  which is the safe direction.

## Housekeeping

`/api/cron/housekeeping` (authenticated with `CRON_SECRET`) releases expired
holds, reconciles pending payments with the provider, and applies time-derived
session transitions. These sweep every arena by design — they move already
expired state and read no tenant data.

## What to watch

| Signal | Why |
| --- | --- |
| `authz.no_membership`, `authz.permission_denied` | A spike means either a broken client or someone probing tenant boundaries |
| `tenant.cross_tenant_access_denied` | Should be ~zero; anything sustained is an attack or a bug |
| `payment.webhook_bad_signature` | Forgery attempts, or a rotated key nobody updated |
| `payment.webhook_replay` | Normal at low volume (provider retries); a spike is not |
| `payment.amount_mismatch` | Always investigate — it is either tampering or a provider change |
| `platform.impersonation_started` | Every one should match a support ticket |
| `RATE_LIMITED` responses | Per arena; a single tenant saturating is worth a call |
| `http.unhandled` | Unexpected errors, with a correlation id and no secrets |

## Secrets

`SESSION_SECRET`, `QR_SECRET`, `CREDENTIALS_KEY`, `CRON_SECRET`, the payment
provider keys and the email provider key. All required in production; the app
refuses to start without them.

Rotating `CREDENTIALS_KEY` makes stored payment credentials unreadable and
every arena must reconnect its account — which is the safe direction to fail,
but plan it. Rotating `QR_SECRET` invalidates every unused QR code.

## Incidents

- **Suspend an arena** from Platform → Arenas. Its storefront closes
  immediately; its operators keep admin access so they can put things right.
- **Look inside an arena** with impersonation. Read-only, 30 minutes, reason
  recorded, banner visible throughout.
- **Revoke a person's access** by removing their membership — their identity
  and their access to other arenas survive.
