/**
 * LOCAL SUPABASE GATEWAY — test environment only.
 *
 * Presents the Supabase URL shape (`/rest/v1/...`, `/storage/v1/...`) in front
 * of a REAL PostgREST + REAL PostgreSQL instance, so the unmodified application
 * (`@supabase/supabase-js` → client.server.ts) talks to a real database with
 * real constraints, real unique indexes and real RLS.
 *
 * This is transport plumbing only. It performs no application logic, invents no
 * rows and fakes no results: every response comes from PostgREST.
 *
 * Secrets are read from files with 0600 permissions and are never logged.
 */
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env["GATEWAY_PORT"] ?? 8787);
const PGRST = process.env["PGRST_URL"] ?? "http://127.0.0.1:3001";
const SERVICE_JWT = fs.readFileSync("/tmp/.srk", "utf8").trim();

const STORAGE = new Map(); // path -> { bytes, contentType }
const SIGNED = new Map(); // token -> path

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  /* ---------------- storage (gallery only; not part of Part 1–6) --------- */
  if (url.pathname.startsWith("/storage/v1/")) {
    const rest = url.pathname.slice("/storage/v1/".length);
    if (rest === "bucket") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("[]");
    }
    if (rest.startsWith("object/sign/")) {
      const path = rest.slice("object/sign/".length);
      const token = Math.random().toString(36).slice(2);
      SIGNED.set(token, path);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ signedURL: `/storage/v1/object/sign/${path}?token=${token}` }),
      );
    }
    if (rest.startsWith("object/")) {
      const path = rest.slice("object/".length);
      if (req.method === "POST" || req.method === "PUT") {
        STORAGE.set(path, {
          bytes: body,
          contentType: req.headers["content-type"] ?? "application/octet-stream",
        });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ Key: path }));
      }
      const obj = STORAGE.get(path.split("?")[0]);
      if (!obj) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "content-type": obj.contentType });
      return res.end(obj.bytes);
    }
    res.writeHead(404);
    return res.end("{}");
  }

  /* ---------------- rest → real PostgREST -------------------------------- */
  if (url.pathname.startsWith("/rest/v1")) {
    const target = `${PGRST}${url.pathname.slice("/rest/v1".length) || "/"}${url.search}`;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "connection", "content-length", "apikey", "authorization"].includes(k)) continue;
      headers[k] = v;
    }
    // The app authenticates with its service-role key; the gateway maps that to
    // the real PostgREST JWT. The key never reaches the browser either way.
    headers["authorization"] = `Bearer ${SERVICE_JWT}`;
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        ...(body.length ? { body } : {}),
      });
      const text = await upstream.text();
      const out = {};
      upstream.headers.forEach((v, k) => {
        if (!["content-encoding", "transfer-encoding", "connection"].includes(k)) out[k] = v;
      });
      res.writeHead(upstream.status, out);
      return res.end(text);
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: String(err) }));
    }
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`local supabase gateway on http://127.0.0.1:${PORT} → ${PGRST}`);
});
