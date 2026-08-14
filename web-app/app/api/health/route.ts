import { checkAllServices } from "../../lib/health";

// Live health data — never cache this route.
export const dynamic = "force-dynamic";

/** Checks every backend service in parallel and reports their status. */
export async function GET() {
  const results = await checkAllServices();
  return Response.json({ checkedAt: new Date().toISOString(), results });
}
