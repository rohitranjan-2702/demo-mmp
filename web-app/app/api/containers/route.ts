import { listProjectContainers } from "../../lib/docker";

// Live container state — never cache this route.
export const dynamic = "force-dynamic";

/** Lists every one of this project's docker-compose containers with their
 *  current run state, for the /logs page's container picker. */
export async function GET() {
  const containers = await listProjectContainers();
  return Response.json({ checkedAt: new Date().toISOString(), containers });
}
