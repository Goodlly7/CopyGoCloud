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

// CORS
app.use(cors());

// ===== Google Drive =====
function makeDrive() {
  const client_email = process.env.GOOGLE_CLIENT_EMAIL;
  let private_key = process.env.GOOGLE_PRIVATE_KEY;

  if (private_key && private_key.includes("\\n")) {
    private_key = private_key.replace(/\\n/g, "\n");
  }

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const credentials = saJson ? JSON.parse(saJson) : { client_email, private_key };

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY (или GOOGLE_SERVICE_ACCOUNT_JSON).");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"]
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

// ===== Статика =====
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  // Подстрахуемся: если файла нет — вернём простую заглушку, чтобы не падать ENOENT
  if (!fs.existsSync(indexPath)) {
    res.type("html").send("<!doctype html><meta charset='utf-8'><title>COPYGO</title><h1>Uploader online</h1>");
    return;
  }
  res.sendFile(indexPath);
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ===== Загрузка =====
app.post("/upload", async (req, res) => {
  // sid НЕобязательный. Если нет — используем YYYY-MM-DD
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

  try {
    const SESSIONS_ROOT_FOLDER = "CopyGoCloud_Sessions";
    const sessionsId = await findOrCreateFolder(drive, SESSIONS_ROOT_FOLDER, null);
    const sessionId  = await findOrCreateFolder(drive, String(sid), sessionsId);

    const uploads = [];
    const bb = busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });

    bb.on("file", (fieldname, file, info) => {
      const { filename, mimeType } = info;

      const p = drive.files.create({
        requestBody: { name: filename || "file", parents: [sessionId] },
        media: { mimeType: mimeType || "application/octet-stream", body: file },
        fields: "id,name,mimeType,size"
      }).then(r => r.data);

      uploads.push(p);

      file.on("error", err => {
        uploads.push(Promise.reject(err));
      });
    });

    bb.on("field", () => { /* можно читать доп. поля, если понадобятся */ });

    bb.on("close", async () => {
      try {
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

// ===== Старт =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Uploader listening on ${PORT}`);
});
