// server.js
import express from "express";
import busboy from "busboy";
import cors from "cors";
import { google } from "googleapis";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// --- CORS ---
app.use(cors());

// --- Google Drive ---
function makeDrive() {
  // Вариант 1: GOOGLE_SERVICE_ACCOUNT_JSON = весь JSON
  // Вариант 2: GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY (с \n)
  const client_email = process.env.GOOGLE_CLIENT_EMAIL;
  let private_key = process.env.GOOGLE_PRIVATE_KEY;

  if (private_key && private_key.includes("\\n")) {
    private_key = private_key.replace(/\\n/g, "\n");
  }

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const credentials = saJson ? JSON.parse(saJson) : { client_email, private_key };

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error(
      "Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY (или GOOGLE_SERVICE_ACCOUNT_JSON)."
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

function escapeForQuery(s) {
  return String(s).replace(/['\\]/g, "\\$&");
}

async function findOrCreateFolder(drive, name, parentId) {
  const safe = escapeForQuery(name);
  const q = parentId
    ? `name='${safe}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const list = await drive.files.list({ q, fields: "files(id,name)", pageSize: 1 });
  if (list.data.files?.length) return list.data.files[0].id;

  const meta = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) meta.parents = [parentId];
  const created = await drive.files.create({ requestBody: meta, fields: "id" });
  return created.data.id;
}

// --- Статика: так как server.js внутри /uploader, то public = /uploader/public ---
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { index: ["upload.html", "index.html"] }));

// Фолбэк на корень
app.get("/", (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "upload.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res
      .type("html")
      .send("<!doctype html><meta charset='utf-8'><title>COPYGO</title><h1>Uploader online</h1>");
  }
});

// health/ping
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/ping", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Самотест: проверяет доступ к целевой папке и создаёт тестовый файл
app.get("/selftest", async (_req, res) => {
  try {
    const drive = makeDrive();
    const parentId = process.env.SESSIONS_ROOT_PARENT_ID || null;

    let targetFolderId = null;
    if (parentId) {
      // пишем прямо в указанную папку
      await drive.files.get({ fileId: parentId, fields: "id,name" });
      targetFolderId = parentId;
    } else {
      // фолбэк: CopyGoCloud_Sessions/<сегодня>
      const rootId = await findOrCreateFolder(drive, "CopyGoCloud_Sessions", null);
      const d = new Date();
      const sid = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
        d.getUTCDate()
      ).padStart(2, "0")}`;
      targetFolderId = await findOrCreateFolder(drive, sid, rootId);
    }

    const content = Buffer.from("COPYGO SELFTEST " + new Date().toISOString(), "utf8");
    const r = await drive.files.create({
      requestBody: { name: "copygo_selftest.txt", parents: [targetFolderId] },
      media: { mimeType: "text/plain", body: content },
      fields: "id,name,parents,webViewLink",
    });

    res.json({ ok: true, created: r.data, targetFolderId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// --- Загрузка на Google Drive ---
app.post("/upload", async (req, res) => {
  // sid НЕобязателен — без него создаём папку по дате (UTC)
  let sid = req.query.sid;
  if (!sid || !String(sid).trim()) {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    sid = `${y}-${m}-${day}`;
  }

  let drive;
  try {
    drive = makeDrive();
  } catch (e) {
    res.status(500).json({ ok: false, error: "Drive init: " + e.message });
    return;
  }

  const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 МБ на файл

  try {
    // Если задана целевая папка — используем её; иначе старое поведение (CopyGoCloud_Sessions/<дата>)
    const parentId = process.env.SESSIONS_ROOT_PARENT_ID || null;

    let sessionId;
    if (parentId) {
      // по умолчанию раскладываем по подпапкам дат
      sessionId = await findOrCreateFolder(drive, String(sid), parentId);
      // если нужно класть прямо в корень parentId — замени строку выше на: sessionId = parentId;
    } else {
      const SESSIONS_ROOT_FOLDER = "CopyGoCloud_Sessions";
      const sessionsId = await findOrCreateFolder(drive, SESSIONS_ROOT_FOLDER, null);
      sessionId = await findOrCreateFolder(drive, String(sid), sessionsId);
    }

    const uploads = [];
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE_BYTES, files: 100 },
    });

    let tooLarge = false;

    bb.on("file", (fieldname, file, info) => {
      const { filename, mimeType } = info || {};

      if (tooLarge) {
        file.resume();
        return;
      }

      const p = drive.files
        .create({
          requestBody: { name: filename || "file", parents: [sessionId] },
          media: { mimeType: mimeType || "application/octet-stream", body: file },
          fields: "id,name,mimeType,size,parents,webViewLink",
        })
        .then((r) => r.data);

      uploads.push(p);

      file.on("limit", () => {
        tooLarge = true;
      });

      file.on("error", (err) => {
        uploads.push(Promise.reject(err));
      });
    });

    bb.on("partsLimit", () => {
      uploads.push(Promise.reject(new Error("Too many parts")));
    });

    bb.on("filesLimit", () => {
      uploads.push(Promise.reject(new Error("Too many files")));
    });

    bb.on("close", async () => {
      try {
        if (tooLarge) {
          res.status(413).json({ ok: false, error: "File too large" });
          return;
        }
        const results = await Promise.all(uploads);
        res.json({ ok: true, files: results });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    req.pipe(bb);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Запуск ---
const PORT = process.env.PORT || process.env.RENDER_PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Uploader listening on ${PORT}`);
});
