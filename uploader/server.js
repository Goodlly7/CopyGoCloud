import express from 'express';
import Busboy from 'busboy';
import { GoogleAuth } from 'google-auth-library';
import { drive_v3 } from '@googleapis/drive';

const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static('public'));

function escapeForQuery(s) {
  return String(s).replace(/['\\]/g, '\\$&');
}

async function makeDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const creds = JSON.parse(raw);

  const auth = new GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  const client = await auth.getClient();
  return new drive_v3.Drive({ auth: client });
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

app.post('/upload', async (req, res) => {
  const sid = String(req.query.sid || '').trim();
  if (!sid) return res.status(400).send('Missing sid');

  let drv;
  try {
    drv = await makeDrive();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Drive init: ' + e.message });
  }

  const sessionsId = await ensureFolder(drv, 'sessions', null);
  const sessionId = await ensureFolder(drv, sid, sessionsId);

  const bb = Busboy({ headers: req.headers });
  const uploads = [];

  bb.on('file', (fieldname, file, info) => {
    const { filename, mimeType } = info;
    const chunks = [];
    file.on('data', d => chunks.push(d));
    file.on('end', () => {
      const media = { mimeType: mimeType || 'application/octet-stream', body: Buffer.concat(chunks) };
      const meta = { name: filename || 'file', parents: [sessionId] };
      uploads.push(
        drv.files.create({ requestBody: meta, media, fields: 'id,name,size,mimeType' })
      );
    });
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
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('CopyGo Uploader listening on', PORT));
