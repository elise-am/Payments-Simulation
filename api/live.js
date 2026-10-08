/**
 * GET /api/live — today's work orders that reached "done/incurred" in ClickUp.
 *
 * ClickUp is read, never written: every request below is a GET (same rule as the
 * Escalations Dashboard). The token stays on the server; the browser only ever sees
 * the shaped JSON this returns.
 *
 * Settings (Vercel → Project → Settings → Environment Variables):
 *   CLICKUP_TOKEN        personal API token (required)
 *   CLICKUP_SPACE_NAME   space to read, found by name (default "Vista")
 *   CLICKUP_TEAM_ID      optional; workspace id (found automatically from the space name)
 *   CLICKUP_SPACE_IDS    optional; space ids instead of the name
 *   CLICKUP_FOLDER_IDS   optional; narrow to these folder ids
 *   CLICKUP_LIST_IDS     optional; narrow to these list ids
 *   CLICKUP_DONE_STATUS  status that means the job is completed (default "done/incurred")
 *   CLICKUP_FIELD_TRADE  custom field holding the trade (default "Trade")
 *   CLICKUP_FIELD_FM     custom field holding the client / FM (default "FM")
 *   CLICKUP_FIELD_COST   custom field holding the cost (default "Cost")
 *   CLICKUP_FIELD_DESCRIPTION  field the job title is written from (default "WO Description", else the task description)
 *   CLICKUP_FIELD_STORE  custom field holding the store / site name (default "Store")
 *   CLICKUP_FIELD_QUOTE  custom field holding the client quote; its work list gives the 3 steps shown (default "Client Quote")
 *   CLICKUP_FIELD_TECH   fallback for the technician's name until a Teams request names one (default "Tech Name")
 *   CLICKUP_FIELD_COMP   custom field naming the company a job belongs to (default "Comp")
 *   CLICKUP_COMP_VALUE   only jobs whose Comp is this value are shown (default "SFM")
 *   APP_TZ               time zone that defines "today" (default America/New_York)
 *   ANTHROPIC_API_KEY    optional; turns descriptions into short job titles and quotes into 3 steps
 *   Sign-off sheet: the task's PDF attachment (lib/signoff.js); its signature image is served by /api/signature
 *   PAYMENTS_GRAPH_* + TEAMS_PAY_CHAT_ID  optional; the technician's name from the Teams payment request (lib/teams.js)
 *   DASHBOARD_PASSWORD   required before any real data is served (see middleware.js)
 *
 * ?refresh=1 skips the 45-second cache (the page's Refresh button sends it).
 */
import Anthropic from "@anthropic-ai/sdk";
import { TEAMS_SETTINGS, chatMessagesSince, paymentRequests } from "../lib/teams.js";
import { readSignoff } from "../lib/signoff.js";

const API = "https://api.clickup.com/api/v2";
const env = (k, d = "") => (process.env[k] ?? d).trim();
const list = (k) => env(k).split(",").map((s) => s.trim()).filter(Boolean);
const woKey = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const letters = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");

// Warm-instance caches. A cold start rebuilds them; nothing here is a source of truth.
let lastResult = null;
let lastAt = 0;
const doneAtCache = new Map(); // task id → ms the task entered its done status
const titleCache = new Map(); // task id + description/quote hash → { title, steps }
let aiError = ""; // last AI title failure, reported in warnings

async function cuGet(path) {
  const res = await fetch(API + path, {
    method: "GET",
    headers: { Authorization: env("CLICKUP_TOKEN"), accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ClickUp ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Midnight today in APP_TZ, as epoch ms. */
function startOfToday(tz) {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = asUtc - now.getTime(); // tz offset at this moment
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset;
}

function field(task, name) {
  const want = letters(name);
  return (task.custom_fields ?? []).find((f) => letters(f.name) === want) ?? null;
}

/** A custom field's value as the text a person reads in ClickUp. */
function fieldText(f) {
  if (!f || f.value === undefined || f.value === null || f.value === "") return "";
  const v = f.value;
  const opt = (x) => {
    const o = (f.type_config?.options ?? []).find((o) => o.id === x || String(o.orderindex) === String(x));
    return o?.name ?? o?.label ?? "";
  };
  if (f.type === "drop_down") return opt(v);
  if (f.type === "labels") return Array.isArray(v) ? v.map(opt).filter(Boolean).join(", ") : "";
  if (f.type === "users") return Array.isArray(v) ? v.map((u) => u.username ?? "").filter(Boolean).join(", ") : "";
  return typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
}

function fieldNumber(f) {
  if (!f || f.value === undefined || f.value === null || f.value === "") return null;
  const n = typeof f.value === "number" ? f.value : Number(String(fieldText(f) || f.value).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Workspace and space ids: from settings when given, else found by the space's name (cached per instance). */
let scope = null;
async function resolveScope() {
  if (scope) return scope;
  const spaceName = letters(env("CLICKUP_SPACE_NAME", "Vista"));
  let teamIds = list("CLICKUP_TEAM_ID");
  if (!teamIds.length) teamIds = ((await cuGet("/team")).teams ?? []).map((t) => String(t.id));
  let spaceIds = list("CLICKUP_SPACE_IDS");
  for (const teamId of teamIds) {
    if (spaceIds.length) { scope = { teamId, spaceIds }; break; }
    const spaces = (await cuGet(`/team/${encodeURIComponent(teamId)}/space?archived=false`)).spaces ?? [];
    const hit = spaces.filter((sp) => letters(sp.name) === spaceName);
    if (hit.length) { scope = { teamId, spaceIds: hit.map((sp) => String(sp.id)), spaceNames: hit.map((sp) => sp.name) }; break; }
  }
  if (!scope) throw new Error(`No ClickUp space named "${env("CLICKUP_SPACE_NAME", "Vista")}" found for this token`);
  return scope;
}

async function allTasksUpdatedSince(ms) {
  const { teamId, spaceIds } = await resolveScope();
  const tasks = [];
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ include_closed: "true", subtasks: "true", order_by: "updated", date_updated_gt: String(ms), page: String(page) });
    for (const id of spaceIds) q.append("space_ids[]", id);
    for (const id of list("CLICKUP_FOLDER_IDS")) q.append("project_ids[]", id);
    for (const id of list("CLICKUP_LIST_IDS")) q.append("list_ids[]", id);
    const r = await cuGet(`/team/${encodeURIComponent(teamId)}/task?${q}`);
    tasks.push(...(r.tasks ?? []));
    if (r.last_page !== false || !(r.tasks ?? []).length) break;
  }
  return tasks;
}

/** When the task entered its current status: date_done when ClickUp sets it, else the time-in-status report. */
async function doneAt(task) {
  if (doneAtCache.has(task.id)) return doneAtCache.get(task.id);
  let ms = Number(task.date_done) || 0;
  if (!ms) {
    try {
      const r = await cuGet(`/task/${encodeURIComponent(task.id)}/time_in_status`);
      ms = Number(r.current_status?.total_time?.since) || 0;
    } catch {
      ms = 0;
    }
  }
  if (ms) doneAtCache.set(task.id, ms);
  return ms;
}

/**
 * Descriptions sometimes hold pasted payment requests ("PP:/PPR: name / phone / ACH / Rout: …").
 * Drop those lines and any account, routing, card or phone numbers before the text is shown
 * or sent anywhere, so bank details can never reach the page or the AI.
 */
function safeDescription(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(pp|ppr)\s*:/i.test(line) && !/\b(rout|routing|acct|account|aba|iban|swift|card)\b/i.test(line))
    .join("\n")
    .replace(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, "") // phone numbers
    .replace(/\d[\d\s-]{5,}\d/g, "") // long digit runs (accounts, routing, cards)
    .replace(/[ \t]+/g, " ")
    .trim();
}

function firstSentence(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const s = t.split(/(?<=[.!?])\s/)[0];
  return s.length > 70 ? s.slice(0, 67).replace(/\s+\S*$/, "") + "…" : s;
}

/** The quote's work list only: prices and the "Incurred" totals are cut before it is shown or sent anywhere. */
function safeQuote(text) {
  return safeDescription(String(text ?? "").split(/^\s*(?:incurred|total)\b/im)[0])
    .split("\n")
    .filter((l) => !/\$\s*\d/.test(l))
    .join("\n")
    .trim();
}

/** Without AI: the work list's lines (after "Required is to"), repair and install steps first, in quote order. */
function quoteSteps(quote) {
  const lines = quote.split("\n").map((l) => l.replace(/^[\s•*\-–\d.)]+/, "").trim()).filter((l) => l.length > 3 && l.length < 90);
  const at = lines.findIndex((l) => /^required\b/i.test(l));
  const work = (at >= 0 ? lines.slice(at + 1) : lines.slice(1)).filter((l) => !/:$/.test(l));
  const main = work.filter((l) => /^(supply and )?(install|replac|repair|rebuil|reseal|swap|fix)/i.test(l));
  const tests = work.filter((l) => /^(test|verify)/i.test(l));
  const pick = new Set([...main, ...tests, ...work].slice(0, 3));
  return work.filter((l) => pick.has(l));
}

/** "Tyler Morgan" → "Tyler M." */
const shortName = (s) => {
  const w = String(s ?? "").trim().split(/\s+/).filter(Boolean);
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  return w.length > 1 ? `${cap(w[0])} ${w[w.length - 1][0].toUpperCase()}.` : w[0] ? cap(w[0]) : "";
};

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

/** Short job titles from work-order descriptions, and the 3 main steps from each client quote, in one request per batch of 25. */
async function aiTitles(items) {
  const out = new Map();
  if (!env("ANTHROPIC_API_KEY") || !items.length) return out;
  const client = new Anthropic();
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    try {
      // Claude Haiku 4.5: the cheapest current model, plenty for a 3-7 word title.
      const response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 4000,
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { titles: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, steps: { type: "array", items: { type: "string" } } }, required: ["id", "title", "steps"], additionalProperties: false } } },
              required: ["titles"],
              additionalProperties: false,
            },
          },
        },
        system:
          "You write job titles for a facilities-maintenance payments dashboard. For each work order, read the description and write what was wrong, in plain words, as a short title of 3 to 7 words, sentence case, no period. Name the equipment and the problem (for example: Rooftop unit not cooling, Leak under the prep sink, Walk-in cooler holding at 48°F). Leave out client names, store numbers, addresses, people, prices and work-order numbers. If a description is empty or says nothing about the problem, return an empty title. " +
          "Each work order may also have a quote listing the work to be done. From it, pick the 3 main steps that fixed the problem (the repair or replacement itself, the test that proves it works, then the next most important), skipping routine ones like inspecting, shutting off water or power, or cleaning up. Write each as a finished result in past tense, 3 to 7 words, sentence case, no period (for example: Failed contactor replaced, Supply air back down to 41°F, Filters replaced on both units). Leave out prices. With no quote or no work list, return an empty steps array.",
        messages: [{ role: "user", content: JSON.stringify(batch.map((b) => ({ id: b.id, description: b.description, quote: b.quote }))) }],
      });
      if (response.stop_reason === "refusal") continue;
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      for (const t of JSON.parse(text).titles ?? []) out.set(t.id, { title: (t.title ?? "").trim(), steps: (t.steps ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3) });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) aiError = "AI titles: rate limited";
      else if (err instanceof Anthropic.APIError) aiError = `AI titles: API error ${err.status}: ${String(err.message).slice(0, 200)}`;
      else aiError = "AI titles failed: " + String(err?.message ?? err).slice(0, 200);
      console.warn(aiError);
    }
  }
  return out;
}

/* ── Sign-off sheets: the PDF attached to the task, read for the manager's name and signature ── */

const signoffCache = new Map(); // task id → { at, result }; result null = no sign-off sheet yet
const SIGNOFF_RECHECK_MS = 3 * 60 * 1000;

/** The task's PDF attachments, sign-off sheets and work-order-named files first, newest first. */
function signoffCandidates(task) {
  const wo = woKey(task.name);
  const score = (a) => (/sign/i.test(a.title ?? "") ? 2 : 0) + (wo && woKey(a.title).includes(wo) ? 1 : 0);
  return (task.attachments ?? [])
    .filter((a) => a.url && (letters(a.extension) === "pdf" || /\.pdf$/i.test(a.title ?? "")))
    .sort((a, b) => score(b) - score(a) || Number(b.date) - Number(a.date))
    .slice(0, 3);
}

async function download(url) {
  const host = new URL(url).hostname;
  const res = await fetch(url, {
    method: "GET",
    headers: /(^|\.)clickup(-attachments)?\.com$/.test(host) ?{ Authorization: env("CLICKUP_TOKEN") } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`attachment ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error("attachment too large");
  return buf;
}

/**
 * { manager, signedAt, png } for a task's sign-off sheet, or null when none is attached yet.
 * Pass the task when it is at hand (with its attachments); otherwise it is read from ClickUp.
 * Cached per task; a task without a sheet is checked again after a few minutes.
 */
export async function signoffFor(taskId, task = null) {
  const hit = signoffCache.get(taskId);
  if (hit && (hit.result || Date.now() - hit.at < SIGNOFF_RECHECK_MS)) return hit.result;
  if (!task?.attachments?.length) task = await cuGet(`/task/${encodeURIComponent(taskId)}`);
  const { spaceIds } = await resolveScope();
  if (!spaceIds.includes(String(task.space?.id))) throw new Error("task outside the dashboard's space");
  let result = null;
  for (const a of signoffCandidates(task)) {
    try {
      const s = readSignoff(await download(a.url));
      if (s.isSignoff || s.png) { result = { manager: s.manager, signedAt: Number(a.date) || null, png: s.png }; break; }
    } catch (err) {
      console.warn("Sign-off read failed:", String(err?.message ?? err));
    }
  }
  signoffCache.set(taskId, { at: Date.now(), result });
  return result;
}

async function build() {
  const tz = env("APP_TZ", "America/New_York");
  const since = startOfToday(tz);
  const doneStatus = letters(env("CLICKUP_DONE_STATUS", "done/incurred"));
  const names = { trade: env("CLICKUP_FIELD_TRADE", "Trade"), fm: env("CLICKUP_FIELD_FM", "FM"), cost: env("CLICKUP_FIELD_COST", "Cost"), desc: env("CLICKUP_FIELD_DESCRIPTION", "WO Description"), store: env("CLICKUP_FIELD_STORE", "Store"), quote: env("CLICKUP_FIELD_QUOTE", "Client Quote") };
  const techField = env("CLICKUP_FIELD_TECH", "Tech Name");

  const updated = await allTasksUpdatedSince(since);
  // Only this company's jobs (Comp = SFM), checked before the per-task completion-time calls.
  const compField = env("CLICKUP_FIELD_COMP", "Comp"), compValue = letters(env("CLICKUP_COMP_VALUE", "SFM"));
  const isComp = (t) => fieldText(field(t, compField)).split(",").some((v) => letters(v) === compValue);
  const doneAny = updated.filter((t) => letters(t.status?.status) === doneStatus);
  const done = doneAny.filter(isComp);

  // Completion times, a few at a time (ClickUp allows ~100 requests a minute per token).
  const withTimes = [];
  for (let i = 0; i < done.length; i += 5) {
    const chunk = done.slice(i, i + 5);
    const times = await Promise.all(chunk.map(doneAt));
    chunk.forEach((t, k) => withTimes.push([t, times[k]]));
  }
  const today = withTimes.filter(([, ms]) => ms >= since);

  // Technician names from today's Teams payment requests, by work order (latest request wins).
  const techByWo = new Map();
  let teamsError = "";
  if (TEAMS_SETTINGS.every((k) => env(k)) && today.length) {
    try {
      const reqs = paymentRequests(await chatMessagesSince(since)).sort((a, b) => a.requestedAt - b.requestedAt);
      for (const r of reqs) if (r.technicianName) techByWo.set(woKey(r.workOrderNumber), r.technicianName);
    } catch (err) {
      teamsError = "Teams names unavailable: " + String(err?.message ?? err).slice(0, 200);
    }
  }

  // Sign-off sheets: a few new lookups per refresh (each is a task read plus a PDF download).
  let signoffError = "";
  const toCheck = today.filter(([t]) => { const h = signoffCache.get(t.id); return !h || (!h.result && Date.now() - h.at >= SIGNOFF_RECHECK_MS); }).slice(0, 8);
  for (let i = 0; i < toCheck.length; i += 4)
    await Promise.all(toCheck.slice(i, i + 4).map(([t]) => signoffFor(t.id, t).catch((err) => { signoffError = "Sign-off sheets: " + String(err?.message ?? err).slice(0, 200); })));

  // Titles and steps: cached per description + quote; new ones go to Claude in one batch.
  const descOf = (t) => safeDescription(fieldText(field(t, names.desc)) || t.text_content || t.description || "").slice(0, 6000); // titles only need the opening of long descriptions
  const quoteOf = (t) => safeQuote(fieldText(field(t, names.quote))).slice(0, 4000);
  const keyOf = (t) => t.id + ":" + hash(descOf(t) + "\u0000" + quoteOf(t));
  const missing = today.filter(([t]) => !titleCache.has(keyOf(t)) && (descOf(t) || quoteOf(t))).map(([t]) => ({ id: t.id, description: descOf(t), quote: quoteOf(t) }));
  const fresh = await aiTitles(missing);
  if (fresh.size) aiError = "";
  for (const [t] of today) {
    const k = keyOf(t);
    if (fresh.has(t.id)) titleCache.set(k, fresh.get(t.id));
  }

  const seen = new Set();
  const jobs = today
    .map(([t, ms]) => {
      for (const f of t.custom_fields ?? []) seen.add(f.name);
      const k = keyOf(t), ai = titleCache.get(k);
      const teamsTech = techByWo.get(woKey(t.name));
      return {
        id: t.id,
        wo: t.name,
        title: ai?.title || firstSentence(descOf(t)) || (fieldText(field(t, names.trade)) ? fieldText(field(t, names.trade)) + " job" : "Work order"),
        titleFromAi: !!ai?.title,
        store: fieldText(field(t, names.store)),
        steps: ai?.steps?.length ? ai.steps : quoteSteps(quoteOf(t)),
        tech: shortName(teamsTech || fieldText(field(t, techField))),
        techFromTeams: !!teamsTech,
        signoff: (({ result } = {}) => result && { manager: shortName(result.manager), signedAt: result.signedAt, signature: !!result.png })(signoffCache.get(t.id)),
        trade: fieldText(field(t, names.trade)),
        fm: fieldText(field(t, names.fm)),
        cost: fieldNumber(field(t, names.cost)),
        completedAt: ms,
        status: t.status?.status ?? "",
        list: t.list?.name ?? "",
        url: t.url ?? "",
      };
    })
    .sort((a, b) => b.completedAt - a.completedAt);

  const warnings = [];
  for (const [k, n] of Object.entries(names)) if (jobs.length && !jobs.some((j) => j[k] !== "" && j[k] !== null)) warnings.push(`No value found in the "${n}" field on any of today's tasks`);
  if (doneAny.length && !doneAny.some((t) => field(t, compField))) warnings.push(`No "${compField}" field found on today's completed tasks, so none are shown`);
  if (aiError) warnings.push(aiError);
  if (teamsError) warnings.push(teamsError);
  if (signoffError) warnings.push(signoffError);
  if (!env("ANTHROPIC_API_KEY")) warnings.push("ANTHROPIC_API_KEY is not set, so titles use the first sentence of the description");

  const statusesSeen = [...new Set(updated.map((t) => t.status?.status).filter(Boolean))].sort();
  if (updated.length && !doneAny.length) warnings.push(`No task updated today is in "${env("CLICKUP_DONE_STATUS", "done/incurred")}". Statuses seen today: ${statusesSeen.join(", ")}`);
  for (const t of updated) for (const f of t.custom_fields ?? []) seen.add(f.name);
  return { ok: true, source: "clickup", asOf: Date.now(), tz, since, space: scope?.spaceNames ?? scope?.spaceIds, jobs, warnings, fieldsSeen: [...seen].sort(), statusesSeen, tasksReadToday: updated.length };
}

/** Today's ClickUp jobs, cached 45 s per warm instance. Also used by /api/payspeed. */
export async function liveJobs(force = false) {
  if (!env("DASHBOARD_PASSWORD")) return { ok: false, reason: "locked", message: "Set DASHBOARD_PASSWORD before the dashboard serves real data." };
  const missing = ["CLICKUP_TOKEN"].filter((k) => !env(k));
  if (missing.length) return { ok: false, reason: "not_configured", missing };

  const age = Date.now() - lastAt;
  if (lastResult && (age < 5000 || (!force && age < 45000))) return { ...lastResult, cached: true };
  try {
    lastResult = await build();
    lastAt = Date.now();
    return lastResult;
  } catch (err) {
    if (lastResult) return { ...lastResult, cached: true, stale: true, error: String(err?.message ?? err) };
    return { ok: false, reason: "error", message: String(err?.message ?? err), status: 502 };
  }
}

export async function GET(request) {
  const body = await liveJobs(new URL(request.url).searchParams.get("refresh") === "1");
  const { status = 200, ...rest } = body;
  return Response.json(rest, { status, headers: { "cache-control": "private, no-store" } });
}
