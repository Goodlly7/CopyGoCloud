// uploader/server.js
import express from "express";
import cors from "cors";
import busboy from "busboy";
import { Storage } from "megajs";
import path from "path";
import { fileURLToPath } from "url";

/* ---------- пути и статика ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

/* ---------- переменные окружения ---------- */
const MEGA_EMAIL    = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const MEGA_FOLDER   = process.env.MEGA_FOLDER || "CopyGo";

if (!MEGA_EMAIL || !MEGA_PASSWORD) {
  console.warn("[WARN] MEGA_EMAIL/MEGA_PASSWORD не заданы — загрузки не будут работать.");
}

/* ---------- MEGA: одно соединение на процесс ---------- */
let storage = null;
let rootFolder = null;

async function ensureMegaReady() {
  if (storage && rootFolder) return { storage, rootFolder };

  storage = new Storage({
    email: MEGA_EMAIL,
    password: MEGA_PASSWORD,
    userAgent: "copygo-uploader/1.0",
  });

  await new Promise((resolve, reject) => {
    storage.on("ready", resolve);
    storage.on("error", reject);
  });

  // найти/создать корневую папку для сессий/загрузок
  rootFolder = storage.root.children.find(c => c.name === MEGA_FOLDER);
  if (!rootFolder) rootFolder = await storage.root.mkdir(MEGA_FOLDER);

  console.log("[MEGA] готово, папка:", rootFolder.name);
  return { storage, rootFolder };
}

/* ---------- express ---------- */
const app = express();
app.use(cors());

// раздача статики (страница загрузки)
app.use(express.static(PUBLIC_DIR, { index: ["upload.html", "index.html"] }));

// фолбэк на корень
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "upload.html"));
});

// простая проверка живости + состояние MEGA
app.get("/health", async (_req, res) => {
  try {
    if (MEGA_EMAIL && MEGA_PASSWORD) {
      await ensureMegaReady();
      res.json({ ok: true, backend: "mega", folder: rootFolder?.name || MEGA_FOLDER });
    } else {
      res.json({ ok: true, backend: "none" });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ---------- загрузка ---------- */
app.post("/upload", async (req, res) => {
  if (!MEGA_EMAIL || !MEGA_PASSWORD) {
    res.status(500).json({ ok: false, error: "MEGA не настроена (MEGA_EMAIL/MEGA_PASSWORD)." });
    return;
  }

  try {
    const { rootFolder } = await ensureMegaReady();

    const bb = busboy({ headers: req.headers, limits: { files: 100 } });
    const uploads = [];

    bb.on("file", (_field, file, info) => {
      const { filename } = info || {};
      if (!filename) {
        file.resume();
        return;
      }

      // кладём прямо в MEGA_FOLDER (можно делать подпапки по дате/пользователю)
      const up = rootFolder.upload(filename);
      file.pipe(up);

      const done = new Promise((resolve, reject) => {
        up.on("complete", f => {
          // link() синхронный, отдаёт публичную ссылку
          let url = null;
          try { url = f.link(); } catch (_) {}
          resolve({
            name: f.name,
            size: f.size,
            url,          // клиент подхватит это поле и покажет ссылку
            nodeId: f.nodeId
          });
        });
        up.on("error", reject);
      });

      uploads.push(done);
    });

    bb.on("close", async () => {
      try {
        const files = await Promise.all(uploads);
        res.json({ ok: true, backend: "mega", folder: rootFolder.name, files });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    });

    req.pipe(bb);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ---------- старт ---------- */
const PORT = process.env.PORT || process.env.RENDER_PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Uploader running on", PORT);
});
