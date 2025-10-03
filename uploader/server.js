import express from 'express';
import Busboy from 'busboy';
import { GoogleAuth } from 'google-auth-library';
import { drive_v3, drive as driveApi } from '@googleapis/drive';

const app = express();

// ---- CORS (проще всего) ----
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- Health ----
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- Отдаём UI ----
app.use(express.static('public'));
app.get('/', (_req, res) => res.redirect('/upload.html'));

// ---- Google Drive helpers ----
async function makeDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');

  const creds = JSON.parse(raw);
  // На случай, если private_key пришёл как \\n — превращаем в реальные переводы строки
  if (creds.private_key?.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  const auth = new GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  const client = await auth.getClient();
  return driveApi({ version: 'v3', auth: client });
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

// ---- /upload (стримом в Drive) ----
app.post('/upload', async (req, res) => {
  const sid = String(req.query.sid || '').trim();
  if (!sid) return res.status(400).send('Missing sid');

  let drive;
  try {
    drive = await makeDrive();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Drive init: ' + e.message });
  }

  try {
    const rootId = await ensureFolder(drive, 'sessions', null);
    const sessionId = await ensureFolder(drive, sid, rootId);

    const bb = Busboy({ headers: req.headers });
    const uploads = [];

    bb.on('file', (fieldname, file, info) => {
      const { filename, mimeType } = info || {};
      // Пушим промис, который завершится, когда загрузка в Drive закончится
      const p = drive.files.create({
        requestBody: { name: filename || 'file', parents: [sessionId] },
        media: { mimeType: mimeType || 'application/octet-stream', body: file },
        fields: 'id,name,mimeType,size'
      });
      uploads.push(p);
      // Если поток файла упал — промис тоже зафейлится
      file.on('error', (err) => {
        console.error('file stream error:', err);
      });
    });

    bb.on('error', (e) => {
      console.error('busboy error:', e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'busboy: ' + e.message });
    });

    bb.on('finish', async () => {
      try {
        const results = await Promise.all(uploads);
        res.json({ ok: true, files: results.map(r => r.data) });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    req.pipe(bb);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('CopyGo Uploader listening on', PORT));
