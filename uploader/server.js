// uploader/server.js
import express from "express";
import cors from "cors";
import busboy from "busboy";
import path from "path";
import { fileURLToPath } from "url";
import { Storage } from "megajs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// --------- конфиг через ENV ---------
const MEGA_EMAIL = process.env.MEGA_EMAIL || "";
const MEGA_PASSWORD = process.env.MEGA_PASSWORD || "";
const MEGA_FOLDER = process.env.MEGA_FOLDER || "CopyGo";

// лимит в байтах (буферизация держит файл в RAM!)
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || "", 10) || 200 * 1024 * 1024; // 200MB

// --------- MEGA init (ленивый, с кэшированием) ---------
let megaPromise = null;
async function ensureMegaReady() {
  if (!MEGA_EMAIL || !MEGA_PASSWORD) {
    throw new Error("MEGA не настроена: задайте MEGA_EMAIL и MEGA_PASSWORD в окружении.");
  }
  if (!megaPromise) {
    megaPromise = new Promise((resolve, reject) => {
      try {
        const storage = new Storage({ email: MEGA_EMAIL, password: MEGA_PASSWORD });
        storage.on("ready", async () => {
          // найти/создать корневую папку
          let rootFolder = storage.root.children.find(f => f.name === MEGA_FOLDER);
          if (!rootFolder) {
            rootFolder = await storage.root.mkdir(MEGA_FOLDER);
          }
          console.log("[MEGA] готово, папка:", rootFolder.name);
          resolve({ storage, rootFolder });
        });
        storage.on("error", reject);
      } catch (e) {
        reject(e);
      }
    });
  }
  return megaPromise;
}

// --------- health ---------
app.get("/health", (_req, res) => res.json({ ok: true }));

// --------- страница загрузки (ваш upload.html) ---------
app.use(express.static(path.join(__dirname, "public"), { index: ["upload.html", "index.html"] }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "upload.html"));
});

// --------- загрузка в MEGA ---------
app.post("/upload", async (req, res) => {
  try {
    const { rootFolder } = await ensureMegaReady();

    const bb = busboy({
      headers: req.headers,
      limits: { files: 50, fileSize: MAX_FILE_BYTES }, // ограничиваем размер
    });

    const uploads = [];
    let tooLarge = false;

    bb.on("file", (_field, file, info) => {
      const { filename } = info || {};
      if (!filename) {
        file.resume();
        return;
      }
      if (tooLarge) {
        // уже превысили лимит — скипаем дальнейшие части
        file.resume();
        return;
      }

      // ВАЖНО: включаем буферизацию, иначе megajs требует размер файла заранее.
      // ПРЕДУПРЕЖДЕНИЕ: файл будет собран в памяти процесса.
      const up = rootFolder.upload(filename, { allowUploadBuffering: true });
      file.pipe(up);

      const done = new Promise((resolve, reject) => {
        up.on("complete", f => {
          let url = null;
          try { url = f.link(); } catch (_) {}
          resolve({
            name: f.name,
            size: f.size,
            url,           // публичная ссылка на файл (если доступна)
            nodeId: f.nodeId,
          });
        });
        up.on("error", reject);
      });

      file.on("limit", () => { tooLarge = true; });
      uploads.push(done);
    });

    bb.on("close", async () => {
      try {
        if (tooLarge) {
          res
            .status(413)
            .json({ ok: false, error: `File too large (> ${Math.round(MAX_FILE_BYTES/1024/1024)} MB)` });
          return;
        }
        const files = await Promise.all(uploads);
        res.json({
          ok: true,
          backend: "mega",
          folder: MEGA_FOLDER,
          files,                 // [{ name, size, url, nodeId }]
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    });

    req.pipe(bb);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------- запуск ---------
const PORT = process.env.PORT || process.env.RENDER_PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Uploader running on port", PORT));
