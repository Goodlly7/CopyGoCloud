// uploader/server.js
import express from "express";
import cors from "cors";
import busboy from "busboy";
import { Storage } from "megajs";

const app = express();
app.use(cors());

// ---- MEGA session (одна на процесс) ----
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const MEGA_FOLDER = process.env.MEGA_FOLDER || "CopyGo";
const MEGA_FOLDER_LINK = process.env.MEGA_FOLDER_LINK || null; // (необязательно)

if (!MEGA_EMAIL || !MEGA_PASSWORD) {
  console.error("MEGA_EMAIL/MEGA_PASSWORD отсутствуют");
  process.exit(1);
}

let storage;        // Storage instance
let targetFolder;   // узел папки, куда складываем файлы

async function ensureMega() {
  if (storage && targetFolder) return;

  storage = new Storage({ email: MEGA_EMAIL, password: MEGA_PASSWORD });

  await new Promise((resolve, reject) => {
    storage.on("ready", resolve);
    storage.on("error", reject);
  });

  // дождёмся, пока дерево смонтируется
  await new Promise((resolve) => setImmediate(resolve));

  // ищем/создаём целевую папку
  targetFolder = storage.root.children.find(n => n.name === MEGA_FOLDER);
  if (!targetFolder) targetFolder = await storage.root.mkdir(MEGA_FOLDER);

  console.log("[MEGA] готово, папка:", targetFolder.name);
}

app.get("/health", async (_req, res) => {
  try {
    await ensureMega();
    res.json({ ok: true, folder: targetFolder?.name || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// ---- Upload ----
app.post("/upload", async (req, res) => {
  try {
    await ensureMega();
  } catch (e) {
    return res.status(500).json({ ok: false, error: "MEGA init: " + e.message });
  }

  const bb = busboy({ headers: req.headers, limits: { files: 50, fileSize: 200 * 1024 * 1024 }});
  const uploads = [];

  bb.on("file", (_field, file, info) => {
    const { filename } = info;

    const up = targetFolder.upload(filename); // создаём поток в MEGA
    file.pipe(up);

    const done = new Promise((resolve, reject) => {
      up.on("error", reject);
      up.on("complete", async (megaFile) => {
        try {
          // ВАЖНО: link() — асинхронный
          const url = await megaFile.link();
          resolve({ name: megaFile.name, size: megaFile.size, url });
        } catch (err) {
          reject(err);
        }
      });
    });

    uploads.push(done);
  });

  bb.on("error", (err) => {
    uploads.push(Promise.reject(err));
  });

  bb.on("close", async () => {
    try {
      const files = await Promise.all(uploads);
      res.json({ ok: true, files, folderUrl: MEGA_FOLDER_LINK || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  req.pipe(bb);
});

const PORT = process.env.PORT || process.env.RENDER_PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Uploader running on", PORT);
});
