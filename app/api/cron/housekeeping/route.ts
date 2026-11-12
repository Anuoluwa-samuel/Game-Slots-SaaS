import { route, ok } from "@/server/http/response"
import { env } from "@/server/env"
import { unauthorized } from "@/server/http/errors"
import { safeEqual } from "@/server/auth/tokens"
import { expireStaleBookings } from "@/server/services/bookings"
import { syncSessionLifecycle } from "@/server/services/sessions"
import { reconcilePendingPayments } from "@/server/services/payments"

/**
 * Scheduled job: release expired holds, persist session lifecycle transitions, and re-verify stuck pending payments.
 * Accepts GET and POST so any scheduler can call it — a systemd timer, a
 * container sidecar, cron. Both need `Authorization: Bearer $CRON_SECRET`.
 */
const handler = route(async (req) => {
  const auth = req.headers.get("authorization") ?? ""
  if (!env.CRON_SECRET || !safeEqual(auth, `Bearer ${env.CRON_SECRET}`)) throw unauthorized("Invalid cron secret")
  const [holds, lifecycle] = await Promise.all([expireStaleBookings(), syncSessionLifecycle()])
  // After holds are released, so a late payment re-claims a slot through the normal path.
  const payments = await reconcilePendingPayments()
  return ok({ holds, lifecycle, payments })
})

export const GET = handler
export const POST = handler
