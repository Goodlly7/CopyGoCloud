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

// -------- Google Drive auth helpers --------
function makeDrive() {
  // Вариант 1 (рекомендуется): GOOGLE_SERVICE_ACCOUNT_JSON = весь JSON одной строкой
  // Вариант 2: GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY (с \n)
  const client_email = process.env.GOOGLE_CLIENT_EMAIL;
  let private_key = process.env.GOOGLE_PRIVATE_KEY;
  if (private_key && private_key.includes("\\n")) private_key = private_key.replace(/\\n/g, "\n");

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const credentials = saJson ? JSON.parse(saJson) : { client_email, private_key };

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Missing GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY (или GOOGLE_SERVICE_ACCOUNT_JSON).");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });

  return google.drive({ version: "v3", auth });
}

// -------- static --------
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { index: ["upload.html", "index.html"] }));

app.get("/", (_req, res) => {
  const p = path.join(PUBLIC_DIR, "upload.html");
  if (fs.existsSync(p)) res.sendFile(p);
  else res.type("html").send("<!doctype html><h1>Uploader online</h1>");
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Удобный самотест: проверяет доступ и создаёт маленький файл в целевой папке
app.get("/selftest", async (_req, res) => {
  try {
    const drive = makeDrive();
    const parentId = process.env.SESSIONS_ROOT_PARENT_ID;
    if (!parentId) return res.status(500).json({ ok:false, error:"SESSIONS_ROOT_PARENT_ID not set" });

    // проверим, что папка существует
    await drive.files.get({ fileId: parentId, fields: "id,name" });

    const r = await drive.files.create({
      requestBody: { name: "copygo_selftest.txt", parents: [parentId] },
      media: { mimeType: "text/plain", body: Buffer.from("ok " + new Date().toISOString(), "utf8") },
      fields: "id,name,webViewLink,parents"
    });

    res.json({ ok: true, created: r.data });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message||e) });
  }
});

// -------- upload --------
app.post("/upload", async (req, res) => {
  // Загружаем БЕЗ подпапок — прямо в SESSIONS_ROOT_PARENT_ID
  const parentId = process.env.SESSIONS_ROOT_PARENT_ID;
  if (!parentId) return res.status(500).json({ ok:false, error:"SESSIONS_ROOT_PARENT_ID not set" });

  let drive;
  try {
    drive = makeDrive();
  } catch (e) {
    return res.status(500).json({ ok:false, error:"Drive init: " + e.message });
  }

  const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 МБ

  try {
    const uploads = [];
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES, files: 100 } });
    let tooLarge = false;

    bb.on("file", (_fieldname, file, info) => {
      const { filename, mimeType } = info || {};
      if (tooLarge) { file.resume(); return; }

      const p = drive.files.create({
        requestBody: { name: filename || "file", parents: [parentId] },
        media: { mimeType: mimeType || "application/octet-stream", body: file },
        fields: "id,name,mimeType,size,parents,webViewLink"
      }).then(r => r.data);

      uploads.push(p);

      file.on("limit", () => { tooLarge = true; });
      file.on("error", err => uploads.push(Promise.reject(err)));
    });

    bb.on("close", async () => {
      try {
        if (tooLarge) return res.status(413).json({ ok:false, error:"File too large" });
        const results = await Promise.all(uploads);
        res.json({ ok:true, files: results });
      } catch (e) {
        res.status(500).json({ ok:false, error: e.message });
      }
    });

    req.pipe(bb);
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// -------- start --------
const PORT = process.env.PORT || process.env.RENDER_PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Uploader listening on ${PORT}`);
});
