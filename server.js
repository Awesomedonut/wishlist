import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || undefined; // undefined = dual-stack (IPv4 + IPv6)
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "wishlist.db");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const MAX_NAME = 40;
const MAX_TEXT = 2000;
const MAX_MEDIA_PER_WISH = 8;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const PAGE_SIZE = 40;

// mime -> [kind, ext]. svg is deliberately excluded (scriptable).
const ALLOWED_MIME = {
  "image/jpeg": ["image", "jpg"],
  "image/png": ["image", "png"],
  "image/gif": ["image", "gif"],
  "image/webp": ["image", "webp"],
  "image/avif": ["image", "avif"],
  "video/mp4": ["video", "mp4"],
  "video/webm": ["video", "webm"],
  "video/quicktime": ["video", "mov"],
  "audio/mpeg": ["audio", "mp3"],
  "audio/mp3": ["audio", "mp3"],
  "audio/mp4": ["audio", "m4a"],
  "audio/x-m4a": ["audio", "m4a"],
  "audio/m4a": ["audio", "m4a"],
  "audio/aac": ["audio", "aac"],
  "audio/wav": ["audio", "wav"],
  "audio/x-wav": ["audio", "wav"],
  "audio/wave": ["audio", "wav"],
  "audio/ogg": ["audio", "ogg"],
  "audio/flac": ["audio", "flac"],
  "audio/x-flac": ["audio", "flac"],
  "audio/webm": ["audio", "weba"],
};
const EXT_MIME = Object.fromEntries(
  Object.entries(ALLOWED_MIME).map(([mime, [, ext]]) => [ext, mime])
);
EXT_MIME.mp3 = "audio/mpeg";
EXT_MIME.m4a = "audio/mp4";
EXT_MIME.wav = "audio/wav";
EXT_MIME.flac = "audio/flac";

const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

// ---------- db ----------
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS wishes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL DEFAULT 'anon',
    text       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS media (
    id            TEXT PRIMARY KEY,
    wish_id       INTEGER REFERENCES wishes(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    mime          TEXT NOT NULL,
    ext           TEXT NOT NULL,
    size          INTEGER NOT NULL,
    original_name TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS media_wish_idx ON media(wish_id);
`);

const q = {
  listWishes: db.prepare(
    `SELECT id, name, text, created_at FROM wishes
     WHERE (:before IS NULL OR id < :before)
     ORDER BY id DESC LIMIT :limit`
  ),
  getWish: db.prepare(`SELECT id, name, text, created_at FROM wishes WHERE id = ?`),
  insertWish: db.prepare(`INSERT INTO wishes (name, text) VALUES (?, ?)`),
  deleteWish: db.prepare(`DELETE FROM wishes WHERE id = ?`),
  countWishes: db.prepare(`SELECT COUNT(*) AS n FROM wishes`),
  mediaForWishes: (n) =>
    db.prepare(
      `SELECT id, wish_id, kind, mime, ext, size, original_name FROM media
       WHERE wish_id IN (${Array(n).fill("?").join(",")}) ORDER BY rowid`
    ),
  mediaForWish: db.prepare(
    `SELECT id, wish_id, kind, mime, ext, size, original_name FROM media WHERE wish_id = ? ORDER BY rowid`
  ),
  insertMedia: db.prepare(
    `INSERT INTO media (id, kind, mime, ext, size, original_name) VALUES (?, ?, ?, ?, ?, ?)`
  ),
  getOrphan: db.prepare(`SELECT id, ext FROM media WHERE id = ? AND wish_id IS NULL`),
  attachMedia: db.prepare(`UPDATE media SET wish_id = ? WHERE id = ? AND wish_id IS NULL`),
  staleOrphans: db.prepare(
    `SELECT id, ext FROM media WHERE wish_id IS NULL AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours')`
  ),
  deleteMedia: db.prepare(`DELETE FROM media WHERE id = ?`),
};

function mediaPath(m) {
  return path.join(UPLOAD_DIR, `${m.id}.${m.ext}`);
}
function mediaJson(m) {
  return {
    id: m.id,
    kind: m.kind,
    mime: m.mime,
    size: m.size,
    name: m.original_name || null,
    url: `uploads/${m.id}.${m.ext}`,
  };
}
function wishesWithMedia(rows) {
  if (rows.length === 0) return [];
  const byWish = new Map(rows.map((w) => [w.id, []]));
  const media = q.mediaForWishes(rows.length).all(...rows.map((w) => w.id));
  for (const m of media) byWish.get(m.wish_id).push(mediaJson(m));
  return rows.map((w) => ({ ...w, media: byWish.get(w.id) }));
}


async function cleanupOrphans() {
  for (const m of q.staleOrphans.all()) {
    await fsp.unlink(mediaPath(m)).catch(() => {});
    q.deleteMedia.run(m.id);
  }
}
cleanupOrphans();
setInterval(cleanupOrphans, 30 * 60 * 1000).unref();

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let hits = buckets.get(key) || [];
  hits = hits.filter((t) => now - t < windowMs);
  if (hits.length >= limit) throw new HttpError(429, "slow down a little");
  hits.push(now);
  buckets.set(key, hits);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of buckets) {
    if (hits.every((t) => now - t > 10 * 60 * 1000)) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid json");
  }
}

function cleanName(v) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return s || "anon";
}
function cleanText(v) {
  return String(v ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+\n/g, "\n").trim().slice(0, MAX_TEXT);
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const ip = clientIp(req);

  if (req.method === "GET" && url.pathname === "/api/wishes") {
    const before = url.searchParams.get("before");
    const beforeId = before && /^\d+$/.test(before) ? Number(before) : null;
    const rows = q.listWishes.all({ before: beforeId, limit: PAGE_SIZE + 1 });
    const hasMore = rows.length > PAGE_SIZE;
    const page = wishesWithMedia(rows.slice(0, PAGE_SIZE));
    return send(res, 200, { wishes: page, has_more: hasMore, total: q.countWishes.get().n });
  }

  if (req.method === "POST" && url.pathname === "/api/wishes") {
    rateLimit(`post:${ip}`, 10, 60 * 1000);
    const body = await readJson(req);
    const name = cleanName(body.name);
    const text = cleanText(body.text);
    const mediaIds = Array.isArray(body.media) ? body.media.slice(0, MAX_MEDIA_PER_WISH) : [];
    const orphans = [];
    for (const id of mediaIds) {
      if (typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id)) throw new HttpError(400, "bad media id");
      const m = q.getOrphan.get(id);
      if (!m) throw new HttpError(400, "unknown or already used upload");
      orphans.push(m);
    }
    if (!text && orphans.length === 0) throw new HttpError(400, "write a wish or attach something");

    let wishId;
    db.exec("BEGIN");
    try {
      wishId = Number(q.insertWish.run(name, text).lastInsertRowid);
      for (const m of orphans) q.attachMedia.run(wishId, m.id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    const [wish] = wishesWithMedia([q.getWish.get(wishId)]);
    return send(res, 201, wish);
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    rateLimit(`upload:${ip}`, 30, 60 * 1000);
    const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const allowed = ALLOWED_MIME[mime];
    if (!allowed) throw new HttpError(415, `unsupported file type: ${mime || "unknown"}`);
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, `file too big (max ${MAX_UPLOAD_BYTES / 1048576} MB)`);
    const [kind, ext] = allowed;
    const id = crypto.randomBytes(12).toString("hex");
    const original = decodeURIComponent(String(req.headers["x-file-name"] || "")).slice(0, 120) || null;
    const dest = path.join(UPLOAD_DIR, `${id}.${ext}`);

    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) return cb(new HttpError(413, `file too big (max ${MAX_UPLOAD_BYTES / 1048576} MB)`));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(dest));
    } catch (e) {
      await fsp.unlink(dest).catch(() => {});
      throw e instanceof HttpError ? e : new HttpError(400, "upload failed");
    }
    if (size === 0) {
      await fsp.unlink(dest).catch(() => {});
      throw new HttpError(400, "empty file");
    }
    q.insertMedia.run(id, kind, mime, ext, size, original);
    return send(res, 201, mediaJson({ id, kind, mime, ext, size, original_name: original }));
  }

  const del = url.pathname.match(/^\/api\/wishes\/(\d+)$/);
  if (req.method === "DELETE" && del) {
    if (!ADMIN_TOKEN) throw new HttpError(404, "not found");
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const ok =
      token.length === ADMIN_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    if (!ok) throw new HttpError(403, "forbidden");
    const id = Number(del[1]);
    const media = q.mediaForWish.all(id);
    const r = q.deleteWish.run(id);
    for (const m of media) await fsp.unlink(mediaPath(m)).catch(() => {});
    return send(res, r.changes ? 200 : 404, { deleted: r.changes > 0 });
  }

  throw new HttpError(404, "not found");
}

async function serveFile(req, res, filePath, contentType, cacheControl) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new HttpError(404, "not found");
  }
  if (!stat.isFile()) throw new HttpError(404, "not found");

  const headers = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Last-Modified": stat.mtime.toUTCString(),
  };

  // Range support so <video>/<audio> can seek.
  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
      if (!m[1] && m[2]) {
        start = Math.max(0, stat.size - Number(m[2]));
        end = stat.size - 1;
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      end = Math.min(end, stat.size - 1);
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers["Content-Length"] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();
  await pipeline(fs.createReadStream(filePath, { start, end }), res);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);

  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");

  const up = url.pathname.match(/^\/uploads\/([a-f0-9]{24})\.([a-z0-9]{2,5})$/);
  if (up) {
    const mime = EXT_MIME[up[2]];
    if (!mime) throw new HttpError(404, "not found");
    return serveFile(
      req,
      res,
      path.join(UPLOAD_DIR, `${up[1]}.${up[2]}`),
      mime,
      "public, max-age=31536000, immutable"
    );
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const filePath = path.resolve(PUBLIC_DIR, "." + rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, "not found");
  const ext = path.extname(filePath).toLowerCase();
  const type = STATIC_MIME[ext] || "application/octet-stream";
  const cache = ext === ".jpg" || ext === ".png" ? "public, max-age=86400" : "no-cache";
  return serveFile(req, res, filePath, type, cache);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.destroy();
    send(res, status, { error: err.message || "server error" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`wishlist board listening on http://${HOST || "localhost"}:${PORT}`);
  console.log(`database: ${DB_PATH}`);
  console.log(`uploads:  ${UPLOAD_DIR}`);
  if (!ADMIN_TOKEN) console.log("ADMIN_TOKEN not set: moderation delete endpoint disabled");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
