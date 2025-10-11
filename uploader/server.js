// uploader/server.js
import express from "express";
import cors from "cors";
import busboy from "busboy";
import { Storage } from "megajs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());

// === СТАТИКА (uploader/public) ===
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { index: ["upload.html", "index.html"] }));

// Корень -> upload.html
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "upload.html"));
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/upload", async (req, res) => {
  const bb = busboy({ headers: req.headers });
  const uploads = [];

  bb.on("file", async (_fieldname, file, info) => {
    const { filename } = info;

    const storage = new Storage({
      email: process.env.MEGA_EMAIL,
      password: process.env.MEGA_PASSWORD,
    });

    // ждём авторизацию
    await new Promise((resolve, reject) => {
      storage.on("ready", resolve);
      storage.on("error", reject);
    });

    // находим/создаём папку
    let folder =
      storage.root.children.find(f => f.name === (process.env.MEGA_FOLDER || "CopyGo"));
    if (!folder) folder = await storage.root.mkdir(process.env.MEGA_FOLDER || "CopyGo");

    const up = folder.upload(filename);
    file.pipe(up);

    const done = new Promise((resolve, reject) => {
      up.on("complete", f => {
        resolve({ name: f.name, size: f.size, url: f.link() }); // публичная ссылка
      });
      up.on("error", reject);
    });

    uploads.push(done);
  });

  bb.on("close", async () => {
    try {
      const files = await Promise.all(uploads);
      res.json({ ok: true, files });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  req.pipe(bb);
});

const PORT = process.env.PORT || process.env.RENDER_PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Uploader running on port", PORT));
