/**
 * Reads a work order's SharePoint folder (the "Sharepoint Link" field on the ClickUp task)
 * through Microsoft Graph, read-only and app-only, with the same app registration as Teams
 * (lib/teams.js). The app needs Files.Read.All or Sites.Selected (application) for this;
 * until it has it, Graph answers 403 and the dashboard shows a warning instead of photos.
 *
 * In each folder: after photos are the images whose names start with "A" (A (1).jpg …),
 * and the sign-off sheet is a PDF (often so.pdf).
 */
import { TEAMS_SETTINGS, accessToken } from "./teams.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const env = (k) => (process.env[k] ?? "").trim();

export const sharepointConfigured = () => TEAMS_SETTINGS.slice(0, 3).every((k) => env(k));

async function graph(path, { raw = false } = {}) {
  const res = await fetch(GRAPH + path, { method: "GET", headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(20000) });
  if (res.status === 403 || res.status === 401) throw new Error(`SharePoint ${res.status}: the Microsoft app needs Files.Read.All or Sites.Selected to read the folders`);
  if (!res.ok) throw new Error(`SharePoint ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

/** Graph's id for a sharing link: "u!" + base64url of the URL. */
const shareId = (url) => "u!" + Buffer.from(url.trim()).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");

const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The folder's files: { photos: after photos (A…), pdfs: sign-off candidates first }. */
export async function folderFiles(link) {
  const url = String(link ?? "").match(/https?:\/\/\S+/)?.[0];
  if (!url) return { photos: [], pdfs: [] };
  const items = [];
  let next = `/shares/${shareId(url)}/driveItem/children?$select=id,name,file,parentReference,lastModifiedDateTime&$top=200`;
  for (let page = 0; next && page < 5; page++) {
    const r = await graph(next);
    items.push(...(r.value ?? []));
    next = r["@odata.nextLink"]?.replace(GRAPH, "");
  }
  const file = (i) => ({ driveId: i.parentReference?.driveId, id: i.id, name: i.name, at: Date.parse(i.lastModifiedDateTime) || null });
  const photos = items
    .filter((i) => i.file && /^a/i.test(i.name) && (/^image\//.test(i.file.mimeType ?? "") || /\.(jpe?g|png|heic|webp)$/i.test(i.name)))
    .sort((a, b) => natural.compare(a.name, b.name))
    .map(file);
  const score = (n) => (/sign|^so[\s._-]/i.test(n) ? 2 : 0) + (/^sml\b/i.test(n) ? -1 : 0);
  const pdfs = items
    .filter((i) => i.file && /\.pdf$/i.test(i.name))
    .sort((a, b) => score(b.name) - score(a.name))
    .map(file);
  return { photos, pdfs };
}

export const fileContent = (f) => graph(`/drives/${encodeURIComponent(f.driveId)}/items/${encodeURIComponent(f.id)}/content`, { raw: true });

/** A resized copy for the page (Graph's "large" thumbnail, about 800 px). */
export const photoThumb = (f) => graph(`/drives/${encodeURIComponent(f.driveId)}/items/${encodeURIComponent(f.id)}/thumbnails/0/large/content`, { raw: true });
