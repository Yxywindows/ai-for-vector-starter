import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.D01_PORT || 18404);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
const server = http.createServer(async (req, res) => {
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405);
      return res.end("Read-only design package");
    }
    const raw = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const file = path.resolve(root, "." + (raw === "/" ? "/index.html" : raw));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    const b = await fs.readFile(file);
    // HTML media needs byte ranges for reliable seeking and decoded-frame QA.
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : b.length - 1, b.length - 1);
      if (start >= b.length || end < start) {
        res.writeHead(416, { "Content-Range": `bytes */${b.length}` });
        return res.end();
      }
      res.writeHead(206, {
        "Content-Type": mime[path.extname(file)] || "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${b.length}`,
        "Content-Length": end - start + 1,
        "Cache-Control": "no-cache",
      });
      return res.end(req.method === "HEAD" ? undefined : b.subarray(start, end + 1));
    }
    res.writeHead(200, {
      "Content-Type": mime[path.extname(file)] || "application/octet-stream",
      "Content-Length": b.length,
      "Cache-Control": "no-cache",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : b);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () =>
  console.log("D01_READY http://127.0.0.1:" + port + "/"),
);
