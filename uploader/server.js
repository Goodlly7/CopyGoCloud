import express from 'express';
import Busboy from 'busboy';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

/* ---------- healthcheck для Render ---------- */
app.get('/health', (req, res) => res.json({ ok: true }));

/* ---------- статика (uploader/public) ---------- */
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- корневой маршрут: открываем страничку загрузки ---------- */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upload.html')); // или index.html, если переименуешь
});

/* ---------- Google Drive helper'ы ---------- */
async function makeDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');

  const creds = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const client = await auth.getClient();
  return google.drive({ version: 'v3', auth: client });
}

function escapeForQuery(s) {
  return String(s).replace(/['\\]/g, '\\$&');
}

async function ensureFolder(drive, name, parentId) {
  const safe = escapeForQuery(name);
  const q = parentId
    ? `name='${safe}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const list = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 });
  if (list.data.files?.length) return list.data.files[0].id;

  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const created = await drive.files.create({ requestBody: meta, fields: 'id' });
  return created.data.id;
}

/* ---------- загрузка файлов ---------- */
app.post('/upload', async (req, res) => {
  const sid = String(req.query.sid || '').trim();
  if (!sid) return res.status(400).send('Missing sid');

  let drive;
  try {
    drive = await makeDrive();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Drive init: ' + e.message });
  }

  const sessionsId = await ensureFolder(drive, 'sessions', null);
  const sessionId = await ensureFolder(drive, sid, sessionsId);

  // лимит на размер файла: 100 МБ (можешь поменять)
  const bb = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });

  const uploads = [];
  let tooBig = false;

  bb.on('file', (fieldname, file, info) => {
    const { filename, mimeType } = info;
    const chunks = [];
    file.on('data', (d) => chunks.push(d));
    file.on('end', () => {
      const media = {
        mimeType: mimeType || 'application/octet-stream',
        body: Buffer.concat(chunks),
      };
      const meta = { name: filename || 'file', parents: [sessionId] };
      uploads.push(
        drive.files.create({
          requestBody: meta,
          media,
          fields: 'id,name,size,mimeType,webViewLink',
        })
      );
    });
  });

  bb.on('limits', () => {
    tooBig = true;
  });

  bb.on('finish', async () => {
    if (tooBig) return res.status(413).json({ ok: false, error: 'File too large' });

    try {
      const results = await Promise.all(uploads);
      res.json({ ok: true, files: results.map((r) => r.data) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  req.pipe(bb);
});

/* ---------- старт ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('CopyGo Uploader listening on', PORT));
