import express from 'express';
import Busboy from 'busboy';
import { GoogleAuth } from 'google-auth-library';
import { drive_v3 } from '@googleapis/drive';
import { Readable } from 'stream';

const app = express();

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Статика - обслуживаем файлы из корня
app.use(express.static('.'));

function escapeForQuery(s) {
  return String(s).replace(/['\\]/g, '\\$&');
}

// Инициализация Google Drive
async function makeDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  }
  
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    throw new Error('Invalid JSON in GOOGLE_SERVICE_ACCOUNT_JSON');
  }
  
  const auth = new GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  
  const client = await auth.getClient();
  return new drive_v3.Drive({ auth: client });
}

// Создание папки если не существует
async function ensureFolder(drive, name, parentId) {
  const safe = escapeForQuery(name);
  const q = parentId
    ? `name='${safe}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  
  const list = await drive.files.list({ 
    q, 
    fields: 'files(id,name)', 
    pageSize: 1 
  });
  
  if (list.data.files?.length) {
    return list.data.files[0].id;
  }
  
  const meta = { 
    name, 
    mimeType: 'application/vnd.google-apps.folder' 
  };
  if (parentId) {
    meta.parents = [parentId];
  }
  
  const created = await drive.files.create({ 
    requestBody: meta, 
    fields: 'id' 
  });
  
  return created.data.id;
}

// Эндпоинт загрузки
app.post('/upload', async (req, res) => {
  const sid = String(req.query.sid || '').trim();
  if (!sid) {
    return res.status(400).json({ ok: false, error: 'Missing sid parameter' });
  }

  let drv;
  try {
    drv = await makeDrive();
  } catch (e) {
    console.error('Drive init error:', e);
    return res.status(500).json({ 
      ok: false, 
      error: 'Drive initialization failed: ' + e.message 
    });
  }

  let sessionsId, sessionId;
  try {
    sessionsId = await ensureFolder(drv, 'sessions', null);
    sessionId = await ensureFolder(drv, sid, sessionsId);
  } catch (e) {
    console.error('Folder creation error:', e);
    return res.status(500).json({ 
      ok: false, 
      error: 'Folder creation failed: ' + e.message 
    });
  }

  const bb = Busboy({ headers: req.headers });
  const uploads = [];

  bb.on('file', (fieldname, file, info) => {
    const { filename, mimeType } = info;
    const chunks = [];
    
    file.on('data', d => chunks.push(d));
    
    file.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const stream = Readable.from(buffer);
      
      const media = { 
        mimeType: mimeType || 'application/octet-stream', 
        body: stream 
      };
      
      const meta = { 
        name: filename || 'file', 
        parents: [sessionId] 
      };
      
      uploads.push(
        drv.files.create({ 
          requestBody: meta, 
          media, 
          fields: 'id,name,size,mimeType,webViewLink' 
        })
      );
    });
  });

  bb.on('finish', async () => {
    try {
      const results = await Promise.all(uploads);
      res.json({ 
        ok: true, 
        files: results.map(r => r.data),
        sessionId: sessionId 
      });
    } catch (e) {
      console.error('Upload error:', e);
      res.status(500).json({ 
        ok: false, 
        error: 'Upload failed: ' + e.message 
      });
    }
  });

  bb.on('error', (e) => {
    console.error('Busboy error:', e);
    res.status(500).json({ 
      ok: false, 
      error: 'Parse error: ' + e.message 
    });
  });

  req.pipe(bb);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`CopyGo Uploader listening on port ${PORT}`);
  console.log('Environment check:');
  console.log('- GOOGLE_SERVICE_ACCOUNT_JSON:', process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? 'SET ✓' : 'NOT SET ✗');
});
