// server.js (CommonJS)
const express = require("express");
const Busboy = require("busboy");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
// Добавляем CORS, чтобы веб-аплоадер мог отправить запрос
app.use(cors()); 

// -------- Google Drive ----------
function makeDrive() {
  // Вариант 1: отдельные переменные
  const client_email = process.env.GOOGLE_CLIENT_EMAIL;
  let private_key = process.env.GOOGLE_PRIVATE_KEY;
  if (private_key && private_key.includes("\\n")) private_key = private_key.replace(/\\n/g, "\n");

  // Вариант 2: весь JSON одной переменной
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const credentials = saJson
    ? JSON.parse(saJson)
    : { client_email, private_key };

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

function escapeForQuery(s) { return s.replace(/['\\]/g, "\\$&"); }

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

// -------- Endpoints ----------
app.get("/", (req, res) => {
    // При запросе к корню, показываем веб-аплоадер, чтобы QR-код вел сюда.
    // Если sid в query, то веб-аплоадер его подхватит.
    res.sendFile(__dirname + "/uploader.html");
});
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/upload", async (req, res) => {
  const sid = req.query.sid;
  if (!sid) { res.status(400).json({ ok:false, error: "Missing sid" }); return; }

  let drive;
  try { drive = makeDrive(); }
  catch (e) { res.status(500).json({ ok:false, error: "Drive init: " + e.message }); return; }

  try {
    const sessionsId = await findOrCreateFolder(drive, "sessions", null);
    const sessionId  = await findOrCreateFolder(drive, String(sid), sessionsId);

    const uploads = [];
    // Убедитесь, что Busboy принимает лимит размера файла, если это необходимо
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });

    busboy.on("file", (fieldname, file, info) => {
      const { filename, mimeType } = info;

      const p = drive.files.create({
        requestBody: { name: filename || "file", parents: [sessionId] },
        media: { mimeType: mimeType || "application/octet-stream", body: file },
        fields: "id,name,mimeType,size",
      }).then(r => r.data);

      uploads.push(p);

      file.on("error", err => uploads.push(Promise.reject(err)));
    });

    busboy.on("finish", async () => {
      try {
        const results = await Promise.all(uploads);
        // Этот ответ сигнализирует веб-аплоадеру, что загрузка завершена
        res.json({ ok: true, files: results }); 
      } catch (e) {
        res.status(500).json({ ok:false, error: e.message });
      }
    });

    req.pipe(busboy);
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Uploader listening on ${PORT}`));
