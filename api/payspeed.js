/**
 * GET /api/payspeed — how fast SFM technicians are paid today, in three steps:
 *
 *   job completed   ClickUp task moved to "done/incurred" (from /api/live, Comp = SFM)
 *   request sent    the "PP:" message posted in the SFM $$Pay$$ Teams chat
 *   payment done    the 👍 reaction on that message
 *
 * A request is matched to its ClickUp job by work order number (ClickUp task name).
 * Read-only on both sides. Cached 45 s per warm instance; ?refresh=1 skips the cache.
 * Phone numbers and payment details in the messages never leave the server.
 */
import { liveJobs } from "./live.js";
import { TEAMS_SETTINGS, chatMessagesSince, paymentRequests } from "../lib/teams.js";

const env = (k, d = "") => (process.env[k] ?? d).trim();
const woKey = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

let lastResult = null;
let lastAt = 0;

function stats(ms) {
  const v = ms.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const q = (p) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null);
  const mid = v.length >> 1;
  const median = !v.length ? null : v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { n: v.length, median, p90: q(0.9), within1h: v.length ? v.filter((x) => x <= 3600000).length / v.length : null };
}

async function build(force) {
  const live = await liveJobs(force);
  if (!live.ok) return live;
  const { since, tz } = live;
  const warnings = [...(live.warnings ?? [])];

  const missing = TEAMS_SETTINGS.filter((k) => !env(k));
  let requests = [];
  if (missing.length) warnings.push(`Teams is not connected yet (missing ${missing.join(", ")}), so request and payment times are empty`);
  else requests = paymentRequests(await chatMessagesSince(since));

  // Only today's activity: sent today, or 👍'd today.
  requests = requests.filter((r) => r.requestedAt >= since || (r.processedAt ?? 0) >= since);

  const jobsByWo = new Map(live.jobs.map((j) => [woKey(j.wo), j]));
  const requested = new Set();
  const rows = requests.map((r) => {
    const job = jobsByWo.get(woKey(r.workOrderNumber));
    if (job) requested.add(job.id);
    return {
      wo: r.workOrderNumber,
      title: job?.title ?? "",
      trade: job?.trade ?? "",
      tech: r.technicianName,
      amount: r.amount,
      completedAt: job?.completedAt ?? null,
      requestedAt: r.requestedAt,
      processedAt: r.processedAt,
      stage: r.processedAt ? "paid" : "requested",
    };
  });
  for (const j of live.jobs)
    if (!requested.has(j.id))
      rows.push({ wo: j.wo, title: j.title, trade: j.trade, tech: "", amount: null, completedAt: j.completedAt, requestedAt: null, processedAt: null, stage: "completed" });
  const last = (r) => Math.max(r.completedAt ?? 0, r.requestedAt ?? 0, r.processedAt ?? 0);
  rows.sort((a, b) => last(b) - last(a));

  // Speeds use positive amounts only (negative = return/reversal), like the Payments Stats app.
  const pay = rows.filter((r) => r.requestedAt && r.amount > 0);
  const now = Date.now();
  const summary = {
    completed: live.jobs.length,
    requested: pay.filter((r) => r.requestedAt >= since).length,
    paid: pay.filter((r) => r.processedAt >= since).length,
    awaitingRequest: rows.filter((r) => r.stage === "completed").length,
    awaitingPayment: pay.filter((r) => !r.processedAt).length,
    oldestAwaitingRequest: Math.max(0, ...rows.filter((r) => r.stage === "completed").map((r) => now - r.completedAt)) || null,
    oldestAwaitingPayment: Math.max(0, ...pay.filter((r) => !r.processedAt).map((r) => now - r.requestedAt)) || null,
    completeToRequest: stats(pay.filter((r) => r.completedAt).map((r) => r.requestedAt - r.completedAt)),
    requestToPaid: stats(pay.filter((r) => r.processedAt).map((r) => r.processedAt - r.requestedAt)),
    completeToPaid: stats(pay.filter((r) => r.processedAt && r.completedAt).map((r) => r.processedAt - r.completedAt)),
  };
  if (requests.length && !rows.some((r) => r.requestedAt && r.completedAt))
    warnings.push("No Teams request matched a ClickUp job today by work order number yet");

  return { ok: true, asOf: now, tz, since, teamsConnected: !missing.length, summary, rows, warnings };
}

export async function GET(request) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  const age = Date.now() - lastAt;
  if (lastResult && (age < 5000 || (!force && age < 45000))) return json({ ...lastResult, cached: true });
  try {
    const result = await build(force);
    if (!result.ok) {
      const { status = 200, ...rest } = result;
      return json(rest, status);
    }
    lastResult = result;
    lastAt = Date.now();
    return json(result);
  } catch (err) {
    if (lastResult) return json({ ...lastResult, cached: true, stale: true, error: String(err?.message ?? err) });
    return json({ ok: false, reason: "error", message: String(err?.message ?? err) }, 502);
  }
}
