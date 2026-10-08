/**
 * Reads the SFM "$$Pay$$" Teams chat through Microsoft Graph (read-only, app-only).
 *
 * Same app registration and rules as the Vendor CRM's payment sync (VR - CRM,
 * src/lib/payments): client-credentials token, GET /chats/{id}/messages, a 👍
 * reaction means the payment was processed, and the parser below is a port of
 * the CRM's parser.ts so both apps read a message the same way.
 *
 * Settings (Vercel → Project → Settings → Environment Variables):
 *   PAYMENTS_GRAPH_TENANT_ID, PAYMENTS_GRAPH_CLIENT_ID, PAYMENTS_GRAPH_CLIENT_SECRET
 *                        the CRM's "VR payments" app registration (needs Chat.Read.All, application)
 *   TEAMS_PAY_CHAT_ID    the SFM payments chat id (PaymentChatSource.chatId where label = 'SFM')
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const env = (k, d = "") => (process.env[k] ?? d).trim();

export const TEAMS_SETTINGS = ["PAYMENTS_GRAPH_TENANT_ID", "PAYMENTS_GRAPH_CLIENT_ID", "PAYMENTS_GRAPH_CLIENT_SECRET", "TEAMS_PAY_CHAT_ID"];

let token = null; // { value, until }
export async function accessToken() {
  if (token && token.until > Date.now() + 60000) return token.value;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env("PAYMENTS_GRAPH_TENANT_ID"))}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("PAYMENTS_GRAPH_CLIENT_ID"),
      client_secret: env("PAYMENTS_GRAPH_CLIENT_SECRET"),
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Microsoft sign-in failed (${res.status})`);
  const j = await res.json();
  token = { value: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return token.value;
}

// The chat-messages endpoint allows about 10 requests per 10 seconds; pace every call.
const GAP_MS = 1100;
let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graphGet(url) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429 && attempt < 4) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) ? after * 1000 : 2 ** attempt * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Teams ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.json();
  }
}

/** Every message in the payments chat created or changed (edited, reacted to) since `sinceMs`. */
export async function chatMessagesSince(sinceMs) {
  const chat = encodeURIComponent(env("TEAMS_PAY_CHAT_ID"));
  let url = `${GRAPH}/chats/${chat}/messages?$top=50&$orderby=lastModifiedDateTime%20desc&$filter=lastModifiedDateTime%20gt%20${new Date(sinceMs).toISOString()}`;
  const out = [];
  for (let page = 0; url && page < 40; page++) {
    const body = await graphGet(url);
    out.push(...(body.value ?? []));
    url = body["@odata.nextLink"];
  }
  return out;
}

/** Payment requests from chat messages: when sent, when 👍'd, and the parsed fields. */
export function paymentRequests(messages) {
  const out = [];
  for (const m of messages) {
    if (m.messageType !== "message" || m.deletedDateTime) continue;
    const p = parsePaymentMessage(m.body?.contentType, m.body?.content ?? "");
    if (!p) continue;
    // Graph returns the literal emoji; older docs say "like". Earliest 👍 = processed.
    const ups = (m.reactions ?? []).filter((r) => r.reactionType === "👍" || r.reactionType === "like").map((r) => Date.parse(r.createdDateTime));
    out.push({
      id: m.id,
      ...p,
      requestedAt: Date.parse(m.createdDateTime),
      processedAt: ups.length ? Math.min(...ups) : null,
      requestedBy: m.from?.user?.displayName ?? null,
    });
  }
  return out;
}

/* ── Parser: port of VR - CRM src/lib/payments/parser.ts ──
   {PPR|PP}: {Name} / {Phone} / {Method} / {Method detail} / {WorkOrderRef} / ${Amount}[ // {note}] */

const MESSAGE_PREFIX_RE = /^PPR?\s*:\s*/i;
const NOTE_RE = /(?<!:)\s*\/\/\s*(.+)$/;
const DOLLAR_AMOUNT_RE = /(?:-\s*)?\$\s*-?\d[\d,]*(?:\.\d+)?|-?\d[\d,]*(?:\.\d+)?\s*\$/;
const BARE_AMOUNT_RE = /^-?\d[\d,]*(?:\.\d+)?$/;
const digitCount = (s) => (s.match(/\d/g) ?? []).length;

function stripHtml(html) {
  return html
    .replace(/<a[^>]*>(.*?)<\/a>/gi, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function splitWorkOrderRef(reference) {
  const segments = reference.split("-").map((s) => s.trim());
  if (segments.length <= 2) return { workOrderNumber: reference.trim(), clientCode: null };
  return { workOrderNumber: segments.slice(0, -2).join("-"), clientCode: segments.slice(-2).join("-") };
}

export function parsePaymentMessage(contentType, content) {
  const text = contentType === "html" ? stripHtml(content) : String(content).trim();
  if (!MESSAGE_PREFIX_RE.test(text)) return null;
  const withoutPrefix = text.replace(MESSAGE_PREFIX_RE, "");

  const noteMatch = withoutPrefix.match(NOTE_RE);
  const note = noteMatch ? noteMatch[1].trim() : null;
  const core = noteMatch ? withoutPrefix.slice(0, noteMatch.index).trim() : withoutPrefix;
  const parts = core.split(/\s*\/\s*/).map((p) => p.trim());

  if (parts.length >= 3 && digitCount(parts[1]) < 7 && digitCount(parts[2]) >= 7) parts.splice(0, 2, `${parts[0]}/${parts[1]}`);
  if (parts.length < 5) return null;

  const [technicianName, phone, paymentMethod] = parts;

  let amountIndex = -1;
  for (let i = parts.length - 1; i >= 3; i--) {
    if (DOLLAR_AMOUNT_RE.test(parts[i])) {
      amountIndex = i;
      break;
    }
  }
  if (amountIndex === -1 && BARE_AMOUNT_RE.test(parts[parts.length - 1])) amountIndex = parts.length - 1;
  if (amountIndex === -1) return null;

  const amountSegment = parts[amountIndex];
  const dollarMatch = amountSegment.match(DOLLAR_AMOUNT_RE);
  const amount = parseFloat((dollarMatch ? dollarMatch[0] : amountSegment).replace(/[$,\s]/g, ""));
  if (Number.isNaN(amount)) return null;

  const glued = !!dollarMatch && dollarMatch.index !== undefined && /[A-Za-z0-9]/.test(amountSegment.slice(0, dollarMatch.index));
  if (!glued && amountIndex < 4) return null;
  const reference = glued ? amountSegment.slice(0, dollarMatch.index).replace(/[\s\-]+$/, "") : parts[amountIndex - 1] ?? "";
  if (!technicianName || !phone || !reference) return null;

  const trailing = parts.slice(amountIndex + 1).filter(Boolean).join(" / ");
  const fullNote = [note, trailing].filter(Boolean).join(" / ") || null;
  const { workOrderNumber, clientCode } = splitWorkOrderRef(reference);
  return { technicianName, phone, paymentMethod, workOrderNumber, clientCode, amount, note: fullNote };
}
