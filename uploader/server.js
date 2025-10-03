import express from 'express';
import Busboy from 'busboy';
import { GoogleAuth } from 'google-auth-library';
import { drive_v3 } from '@googleapis/drive';
import { Readable } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// CORS для фронтенда
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Логирование всех запросов
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Статика - пробуем разные варианты
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Health check
app.get('/health', (req, res) => {
  const hasEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  res.json({ 
    ok: true, 
    service: 'CopyGo Uploader',
    timestamp: new Date().toISOString(),
    env: {
      GOOGLE_SERVICE_ACCOUNT_JSON: hasEnv ? 'SET ✓' : 'NOT SET ✗',
      PORT: process.env.PORT || 8080,
      NODE_ENV: process.env.NODE_ENV || 'development'
    }
  });
});

// Главная страница (если статика не работает)
app.get('/', (req, res) => {
  res.send(`
    <!doctype html>
    <html lang="ru">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>CopyGo → Google Drive</title>
      <style>
        body{margin:0;background:#0b1020;color:#e6f0ff;font-family:system-ui,sans-serif;padding:40px 20px}
        .container{max-width:600px;margin:0 auto;text-align:center}
        h1{color:#60a5fa;margin-bottom:30px}
        .status{background:rgba(16,25,52,.8);border:1px solid rgba(124,58,237,.3);border-radius:12px;padding:20px;margin:20px 0}
        .ok{color:#10b981} .err{color:#ef4444}
        a{color:#60a5fa;text-decoration:none}
        a:hover{text-decoration:underline}
        code{background:rgba(0,0,0,.3);padding:2px 6px;border-radius:4px;font-size:13px}
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 CopyGo Cloud Server</h1>
        <div class="status">
          <p>✅ Сервер работает!</p>
          <p><a href="/health">Проверить здоровье сервера</a></p>
        </div>
        <div class="status">
          <h3>API Endpoints:</h3>
          <p><code>GET /health</code> - статус сервера</p>
          <p><code>POST /upload?sid=YOUR_SID</code> - загрузка файлов</p>
        </div>
        <div class="status">
          <p>⚠️ Если вы видите эту страницу вместо интерфейса загрузки,</p>
          <p>проверьте наличие файла <code>public/index.html</code> в репозитории</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

function escapeForQuery(s) {
  return String(s).replace(/['\\]/g, '\\$&');
}

// Инициализация Google Drive
async function makeDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set');
  }
  
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    throw new Error('Invalid JSON in GOOGLE_SERVICE_ACCOUNT_JSON: ' + e.message);
  }
  
  if (!creds.private_key || !creds.client_email) {
    throw new Error('Service account JSON is missing required fields (private_key or client_email)');
  }
  
  const auth = new GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
  
  const client = await auth.getClient();
  return new drive_v3.Drive({ auth: client });
}

// Создание папки если не существует
async function ensureFolder(drive, name, parentId) {
  try {
    const safe = escapeForQuery(name);
    const q = parentId
      ? `name='${safe}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
      : `name='${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    
    const list = await drive.files.list({ 
      q, 
      fields: 'files(id,name)', 
      pageSize: 1,
      supportsAllDrives: true
    });
    
    if (list.data.files?.length) {
      console.log(`Folder "${name}" exists: ${list.data.files[0].id}`);
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
      fields: 'id',
      supportsAllDrives: true
    });
    
    console.log(`Folder "${name}" created: ${created.data.id}`);
    return created.data.id;
  } catch (e) {
    console.error(`Error ensuring folder "${name}":`, e.message);
    throw new Error(`Failed to create/find folder "${name}": ${e.message}`);
  }
}

// Эндпоинт загрузки
app.post('/upload', async (req, res) => {
  console.log('Upload request received');
  
  const sid = String(req.query.sid || '').trim();
  if (!sid) {
    console.log('Missing SID parameter');
    return res.status(400).json({ 
      ok: false, 
      error: 'Missing sid parameter. Use: /upload?sid=YOUR_SESSION_ID' 
    });
  }

  console.log(`Processing upload for SID: ${sid}`);

  let drv;
  try {
    drv = await makeDrive();
    console.log('Google Drive client initialized successfully');
  } catch (e) {
    console.error('Drive initialization error:', e);
    return res.status(500).json({ 
      ok: false, 
      error: 'Failed to initialize Google Drive API',
      details: e.message
    });
  }

  let sessionsId, sessionId;
  try {
    sessionsId = await ensureFolder(drv, 'sessions', null);
    sessionId = await ensureFolder(drv, sid, sessionsId);
    console.log(`Session folder ready: sessions/${sid} (${sessionId})`);
  } catch (e) {
    console.error('Folder creation error:', e);
    return res.status(500).json({ 
      ok: false, 
      error: 'Failed to create session folders',
      details: e.message
    });
  }

  const bb = Busboy({ headers: req.headers });
  const uploads = [];
  let fileCount = 0;

  bb.on('file', (fieldname, file, info) => {
    fileCount++;
    const { filename, mimeType } = info;
    console.log(`Receiving file #${fileCount}: ${filename} (${mimeType})`);
    
    const chunks = [];
    let totalSize = 0;
    
    file.on('data', d => {
      chunks.push(d);
      totalSize += d.length;
    });
    
    file.on('end', () => {
      console.log(`File "${filename}" received: ${totalSize} bytes`);
      
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
          fields: 'id,name,size,mimeType,webViewLink',
          supportsAllDrives: true
        }).then(result => {
          console.log(`File "${filename}" uploaded successfully: ${result.data.id}`);
          return result;
        }).catch(err => {
          console.error(`Upload failed for "${filename}":`, err.message);
          throw err;
        })
      );
    });
  });

  bb.on('finish', async () => {
    console.log(`Busboy finished. Processing ${uploads.length} uploads...`);
    
    if (uploads.length === 0) {
      return res.status(400).json({ 
        ok: false, 
        error: 'No files received' 
      });
    }
    
    try {
      const results = await Promise.all(uploads);
      console.log(`All ${results.length} files uploaded successfully`);
      
      res.json({ 
        ok: true, 
        files: results.map(r => r.data),
        sessionId: sessionId,
        folderPath: `sessions/${sid}`
      });
    } catch (e) {
      console.error('Upload processing error:', e);
      res.status(500).json({ 
        ok: false, 
        error: 'Upload failed',
        details: e.message
      });
    }
  });

  bb.on('error', (e) => {
    console.error('Busboy error:', e);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to parse upload data',
      details: e.message
    });
  });

  req.pipe(bb);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    ok: false, 
    error: 'Not found',
    path: req.url,
    availableEndpoints: ['/health', '/upload?sid=YOUR_SID']
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    ok: false, 
    error: 'Internal server error',
    details: err.message
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 CopyGo Uploader Server Started`);
  console.log(`📅 Time: ${new Date().toISOString()}`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`📁 Working directory: ${__dirname}`);
  console.log('='.repeat(60));
  console.log('Environment check:');
  console.log(`  GOOGLE_SERVICE_ACCOUNT_JSON: ${process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? '✓ SET' : '✗ NOT SET'}`);
  console.log(`  NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log('='.repeat(60));
  console.log('Available endpoints:');
  console.log('  GET  /health - Check server status');
  console.log('  POST /upload?sid=<SESSION_ID> - Upload files');
  console.log('='.repeat(60));
});
