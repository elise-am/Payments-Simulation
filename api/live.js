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
 *   CLICKUP_FIELD_COMP   custom field naming the company a job belongs to (default "Comp")
 *   CLICKUP_COMP_VALUE   only jobs whose Comp is this value are shown (default "SFM")
 *   APP_TZ               time zone that defines "today" (default America/New_York)
 *   ANTHROPIC_API_KEY    optional; turns descriptions into short job titles
 *   DASHBOARD_PASSWORD   required before any real data is served (see middleware.js)
 *
 * ?refresh=1 skips the 45-second cache (the page's Refresh button sends it).
 */
import Anthropic from "@anthropic-ai/sdk";

const API = "https://api.clickup.com/api/v2";
const env = (k, d = "") => (process.env[k] ?? d).trim();
const list = (k) => env(k).split(",").map((s) => s.trim()).filter(Boolean);
const letters = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");

// Warm-instance caches. A cold start rebuilds them; nothing here is a source of truth.
let lastResult = null;
let lastAt = 0;
const doneAtCache = new Map(); // task id → ms the task entered its done status
const titleCache = new Map(); // task id + description hash → short title
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

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

/** Short job titles from work-order descriptions, in one request per batch of 25. */
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
              properties: { titles: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id", "title"], additionalProperties: false } } },
              required: ["titles"],
              additionalProperties: false,
            },
          },
        },
        system:
          "You write job titles for a facilities-maintenance payments dashboard. For each work order, read the description and write what was wrong, in plain words, as a short title of 3 to 7 words, sentence case, no period. Name the equipment and the problem (for example: Rooftop unit not cooling, Leak under the prep sink, Walk-in cooler holding at 48°F). Leave out client names, store numbers, addresses, people, prices and work-order numbers. If a description is empty or says nothing about the problem, return an empty title.",
        messages: [{ role: "user", content: JSON.stringify(batch.map((b) => ({ id: b.id, description: b.description }))) }],
      });
      if (response.stop_reason === "refusal") continue;
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      for (const t of JSON.parse(text).titles ?? []) if (t.title) out.set(t.id, t.title.trim());
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) aiError = "AI titles: rate limited";
      else if (err instanceof Anthropic.APIError) aiError = `AI titles: API error ${err.status}: ${String(err.message).slice(0, 200)}`;
      else aiError = "AI titles failed: " + String(err?.message ?? err).slice(0, 200);
      console.warn(aiError);
    }
  }
  return out;
}

async function build() {
  const tz = env("APP_TZ", "America/New_York");
  const since = startOfToday(tz);
  const doneStatus = letters(env("CLICKUP_DONE_STATUS", "done/incurred"));
  const names = { trade: env("CLICKUP_FIELD_TRADE", "Trade"), fm: env("CLICKUP_FIELD_FM", "FM"), cost: env("CLICKUP_FIELD_COST", "Cost"), desc: env("CLICKUP_FIELD_DESCRIPTION", "WO Description") };

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

  // Titles: cached per description; new ones go to Claude in one batch.
  const descOf = (t) => safeDescription(fieldText(field(t, names.desc)) || t.text_content || t.description || "").slice(0, 6000); // titles only need the opening of long descriptions
  const keyOf = (t) => t.id + ":" + hash(descOf(t));
  const missing = today.filter(([t]) => !titleCache.has(keyOf(t)) && descOf(t)).map(([t]) => ({ id: t.id, description: descOf(t) }));
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
      const k = keyOf(t);
      return {
        id: t.id,
        wo: t.name,
        title: titleCache.get(k) || firstSentence(descOf(t)) || (fieldText(field(t, names.trade)) ? fieldText(field(t, names.trade)) + " job" : "Work order"),
        titleFromAi: titleCache.has(k),
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
  if (!env("ANTHROPIC_API_KEY")) warnings.push("ANTHROPIC_API_KEY is not set, so titles use the first sentence of the description");

  const statusesSeen = [...new Set(updated.map((t) => t.status?.status).filter(Boolean))].sort();
  if (updated.length && !doneAny.length) warnings.push(`No task updated today is in "${env("CLICKUP_DONE_STATUS", "done/incurred")}". Statuses seen today: ${statusesSeen.join(", ")}`);
  for (const t of updated) for (const f of t.custom_fields ?? []) seen.add(f.name);
  return { ok: true, source: "clickup", asOf: Date.now(), tz, since, space: scope?.spaceNames ?? scope?.spaceIds, jobs, warnings, fieldsSeen: [...seen].sort(), statusesSeen, tasksReadToday: updated.length };
}

export async function GET(request) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
  if (!env("DASHBOARD_PASSWORD")) return json({ ok: false, reason: "locked", message: "Set DASHBOARD_PASSWORD before the dashboard serves real data." });
  const missing = ["CLICKUP_TOKEN"].filter((k) => !env(k));
  if (missing.length) return json({ ok: false, reason: "not_configured", missing });

  const force = new URL(request.url).searchParams.get("refresh") === "1";
  const age = Date.now() - lastAt;
  if (lastResult && (age < 5000 || (!force && age < 45000))) return json({ ...lastResult, cached: true });
  try {
    lastResult = await build();
    lastAt = Date.now();
    return json(lastResult);
  } catch (err) {
    if (lastResult) return json({ ...lastResult, cached: true, stale: true, error: String(err?.message ?? err) });
    return json({ ok: false, reason: "error", message: String(err?.message ?? err) }, 502);
  }
}
