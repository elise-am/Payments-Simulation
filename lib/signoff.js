/**
 * Reads a sign-off sheet PDF (the "Signoff Sheet" attached to a ClickUp task):
 * the site manager's name from the page text, and the signature, which the sheet
 * embeds as its own image with a transparency mask.
 *
 * A small reader for these generated sheets (uncompressed object table, Flate
 * streams, no object streams), not a general PDF parser. Anything it cannot read
 * returns null fields rather than throwing.
 */
import zlib from "node:zlib";

const latin = (b) => b.toString("latin1");

function objects(buf) {
  const s = latin(buf);
  const out = new Map();
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const end = s.indexOf("endobj", re.lastIndex);
    if (end < 0) break;
    out.set(m[1], { start: re.lastIndex, end, dict: s.slice(re.lastIndex, Math.min(end, re.lastIndex + 2000)).split("stream")[0] });
    re.lastIndex = end;
  }
  return { s, out };
}

function stream(buf, { s, out }, id) {
  const o = out.get(String(id));
  if (!o) return null;
  let i = s.indexOf("stream", o.start);
  if (i < 0 || i > o.end) return null;
  i += 6;
  if (s[i] === "\r" && s[i + 1] === "\n") i += 2;
  else if (s[i] === "\n" || s[i] === "\r") i += 1;
  const len = Number(/\/Length (\d+)/.exec(o.dict)?.[1]);
  const end = Number.isFinite(len) ? i + len : s.indexOf("endstream", i);
  const raw = buf.subarray(i, end);
  if (/\/DecodeParms/.test(o.dict)) return null; // predictors are not used by these sheets
  if (!/\/FlateDecode/.test(o.dict)) return raw;
  try {
    return zlib.inflateSync(raw);
  } catch {
    return null;
  }
}

/** Glyph id → text for each font, from its ToUnicode map. */
function unicodeMap(cmap) {
  const m = new Map();
  const hex = (h) => Buffer.from(h.length % 4 ? h.padStart(4, "0") : h, "hex").swap16().toString("utf16le");
  for (const [, blk] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const [, a, b] of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) m.set(a.toUpperCase().padStart(4, "0"), hex(b));
  for (const [, blk] of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const [, a, b, c] of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g))
      for (let k = parseInt(a, 16); k <= parseInt(b, 16); k++) m.set(k.toString(16).toUpperCase().padStart(4, "0"), String.fromCodePoint(parseInt(c, 16) + k - parseInt(a, 16)));
  return m;
}

/** The page's text, one line per text block. */
function pageLines(buf, objs) {
  const fonts = new Map();
  for (const [id, o] of objs.out) {
    if (!/\/Type\s*\/Page\b/.test(o.dict)) continue;
    for (const [, name, ref] of o.dict.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
      const tu = /\/ToUnicode\s+(\d+)/.exec(objs.out.get(ref)?.dict ?? "")?.[1];
      const cm = tu && stream(buf, objs, tu);
      if (cm) fonts.set(name, unicodeMap(latin(cm)));
    }
  }
  const lines = [];
  for (const [, o] of objs.out) {
    if (!/\/Type\s*\/Page\b/.test(o.dict)) continue;
    for (const [, ref] of o.dict.matchAll(/\/Contents\s+(\d+)\s+0\s+R/g)) {
      const c = stream(buf, objs, ref);
      if (!c) continue;
      let font = null, line = "";
      for (const t of latin(c).matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj|\((.*?)\)\s*Tj|\bET\b/g)) {
        if (t[1]) font = t[1];
        else if (t[2]) for (let i = 0; i < t[2].length; i += 4) line += fonts.get(font)?.get(t[2].slice(i, i + 4).toUpperCase()) ?? "";
        else if (t[3] !== undefined) line += t[3];
        else { if (line.trim()) lines.push(line.trim()); line = ""; }
      }
    }
  }
  return lines;
}

function png(w, h, gray, alpha) {
  const rows = Buffer.alloc((w * 2 + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w * 2 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      rows[y * (w * 2 + 1) + 1 + x * 2] = gray;
      rows[y * (w * 2 + 1) + 2 + x * 2] = alpha[y * w + x];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 4; // 8-bit gray + alpha
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** The signature: the image drawn with a soft mask. Returned as a black-ink PNG whose alpha is the ink, cropped to the strokes. */
function signature(buf, objs) {
  for (const [, o] of objs.out) {
    if (!/\/Subtype\s*\/Image/.test(o.dict)) continue;
    const sm = /\/SMask\s+(\d+)/.exec(o.dict)?.[1];
    if (!sm) continue;
    const sd = objs.out.get(sm)?.dict ?? "";
    const w = Number(/\/Width (\d+)/.exec(sd)?.[1]), h = Number(/\/Height (\d+)/.exec(sd)?.[1]);
    if (!/\/BitsPerComponent 8/.test(sd) || !w || !h) continue;
    const a = stream(buf, objs, sm);
    if (!a || a.length < w * h) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (a[y * w + x] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) continue; // blank signature
    const pad = 8;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, crop = Buffer.alloc(cw * ch);
    for (let y = 0; y < ch; y++) a.copy(crop, y * cw, (y + y0) * w + x0, (y + y0) * w + x0 + cw);
    return png(cw, ch, 0, crop);
  }
  return null;
}

/** { manager, location, png } from a sign-off sheet; fields are null when not found. */
export function readSignoff(buf) {
  const objs = objects(buf);
  let lines = [];
  try { lines = pageLines(buf, objs); } catch { lines = []; }
  const after = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) return null;
    const same = lines[i].replace(re, "").replace(/^[\s:]+/, "").trim();
    return same || lines[i + 1] || null;
  };
  let sig = null;
  try { sig = signature(buf, objs); } catch { sig = null; }
  return {
    isSignoff: lines.some((l) => /sign\s*-?\s*off/i.test(l)),
    manager: after(/^name of manager[^:]*:?/i),
    location: after(/^location\s*:?/i),
    png: sig,
  };
}
