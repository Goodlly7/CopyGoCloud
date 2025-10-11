// uploader/server.js
import express from "express";
import cors from "cors";
import busboy from "busboy";
import { google } from "googleapis";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());

const { OAuth2 } = google.auth;

/* ================= OAuth ================= */

// 1) Старт авторизации — получаем согласие и refresh_token
app.get("/auth", (_req, res) => {
  const o = new OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT
  );
  const url = o.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive"
    ]
  });
  res.redirect(url);
});

// 2) Callback — показываем refresh_token один раз
app.get("/oauth2callback", async (req, res) => {
  try {
    const o = new OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT
    );
    const { tokens } = await o.getToken(req.query.code);
    res
      .type("text")
      .send(
        "✅ Скопируйте это значение и добавьте на Render как GOOGLE_OAUTH_REFRESH_TOKEN:\n\n" +
          (tokens.refresh_token || "refresh_token не выдан — повторите, оставив prompt=consent")
      );
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

// 3) Клиент для Drive через OAuth refresh_token
function makeDrive() {
  const need = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REDIRECT",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
  ];
  for (const k of need) {
    if (!process.env[k]) throw new Error(`Missing env: ${k}`);
  }
  const o = new OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT
  );
  o.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth: o });
}

/* =============== static =============== */

const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { index: ["upload.html", "index.html"] }));

app.get("/", (_req, res) => {
  const p = path.join(PUBLIC_DIR, "upload.html");
  if (fs.existsSync(p)) res.sendFile(p);
  else res.type("html").send("<!doctype html><h1>Uploader online</h1>");
});

app.get("/health", (_req, res) => res.json({ ok: true }));

/* =============== upload =============== */

app.post("/upload", async (req, res) => {
  let drive;
  try {
    drive = makeDrive();
  } catch (e) {
    return res.status(500).json({ ok: false, error: "OAuth init: " + e.message });
  }

  try {
    // Папка назначения:
    // 1) если задана переменная DRIVE_FOLDER_ID — кладём прямо туда
    // 2) иначе найдём/создадим папку "Прием фотки"
    let folderId = process.env.DRIVE_FOLDER_ID;
    if (!folderId) {
      const name = "Прием фотки";
      const list = await drive.files.list({
        q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id,name)",
        pageSize: 1,
      });
      if (list.data.files?.length) {
        folderId = list.data.files[0].id;
      } else {
        const created = await drive.files.create({
          requestBody: { name, mimeType: "application/vnd.google-apps.folder" },
          fields: "id",
        });
        folderId = created.data.id;
      }
    }

    const bb = busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });
    const uploads = [];

    bb.on("file", (_field, file, info) => {
      const { filename, mimeType } = info || {};
      const p = drive.files
        .create({
          requestBody: { name: filename || "file", parents: [folderId] },
          media: { mimeType: mimeType || "application/octet-stream", body: file },
          fields: "id,name,webViewLink,parents",
        })
        .then((r) => r.data);
      uploads.push(p);
    });

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

/* =============== start =============== */

const PORT = process.env.PORT || process.env.RENDER_PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Uploader listening on", PORT));
