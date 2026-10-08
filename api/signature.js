/**
 * GET /api/signature?id=<ClickUp task id> — the site manager's signature from the task's
 * sign-off sheet PDF (ClickUp attachment or SharePoint folder), as a PNG whose alpha is the ink (the page tints it with the theme's ink color).
 *
 * Read-only, behind the dashboard password (middleware.js), and limited to tasks in the
 * dashboard's ClickUp space. 404 when the task has no sign-off sheet or no signature in it.
 */
import { jobFiles } from "./live.js";

const env = (k) => (process.env[k] ?? "").trim();

export async function GET(request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const headers = { "cache-control": "private, no-store" };
  if (!env("DASHBOARD_PASSWORD")) return Response.json({ ok: false, reason: "locked" }, { status: 403, headers });
  if (!env("CLICKUP_TOKEN")) return Response.json({ ok: false, reason: "not_configured" }, { status: 503, headers });
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return Response.json({ ok: false, reason: "bad_id" }, { status: 400, headers });
  try {
    const s = (await jobFiles(id)).signoff;
    if (!s?.png) return Response.json({ ok: false, reason: "no_signature" }, { status: 404, headers });
    return new Response(s.png, { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
  } catch (err) {
    return Response.json({ ok: false, reason: "error", message: String(err?.message ?? err).slice(0, 200) }, { status: 502, headers });
  }
}
