/**
 * GET /api/photo?id=<ClickUp task id>&n=<0-based index> — one of the job's after photos
 * (images starting with "A" in the work order's SharePoint folder), as Graph's resized copy.
 *
 * Read-only, behind the dashboard password (middleware.js), limited to tasks in the
 * dashboard's ClickUp space. 404 when the task has no such photo.
 */
import { jobFiles } from "./live.js";
import { photoThumb } from "../lib/sharepoint.js";

const env = (k) => (process.env[k] ?? "").trim();

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const id = q.get("id") ?? "", n = Number(q.get("n") ?? 0);
  const headers = { "cache-control": "private, no-store" };
  if (!env("DASHBOARD_PASSWORD")) return Response.json({ ok: false, reason: "locked" }, { status: 403, headers });
  if (!env("CLICKUP_TOKEN")) return Response.json({ ok: false, reason: "not_configured" }, { status: 503, headers });
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !Number.isInteger(n) || n < 0 || n > 20) return Response.json({ ok: false, reason: "bad_request" }, { status: 400, headers });
  try {
    const photo = (await jobFiles(id)).photos[n];
    if (!photo) return Response.json({ ok: false, reason: "no_photo" }, { status: 404, headers });
    return new Response(await photoThumb(photo), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" } });
  } catch (err) {
    return Response.json({ ok: false, reason: "error", message: String(err?.message ?? err).slice(0, 200) }, { status: 502, headers });
  }
}
