// uploader/server.js
import express from "express";
import cors from "cors";
import busboy from "busboy";
import { Storage } from "megajs";

const app = express();
app.use(cors());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/upload", async (req, res) => {
  const bb = busboy({ headers: req.headers });
  const uploads = [];

  bb.on("file", async (_fieldname, file, info) => {
    const { filename } = info;

    const storage = new Storage({
      email: process.env.MEGA_EMAIL,
      password: process.env.MEGA_PASSWORD,
    });

    // Ждём авторизацию
    await new Promise((resolve, reject) => {
      storage.on("ready", resolve);
      storage.on("error", reject);
    });

    // Находим или создаём папку
    let folder = storage.root.children.find(f => f.name === (process.env.MEGA_FOLDER || "CopyGo"));
    if (!folder) {
      folder = await storage.root.mkdir(process.env.MEGA_FOLDER || "CopyGo");
    }

    // Загрузка файла в MEGA
    const upload = folder.upload(filename);
    file.pipe(upload);

    const done = new Promise((resolve, reject) => {
      upload.on("complete", file => {
        resolve({
          name: file.name,
          size: file.size,
          url: file.link(), // публичная ссылка
        });
      });
      upload.on("error", reject);
    });

    uploads.push(done);
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
});

const PORT = process.env.PORT || process.env.RENDER_PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Uploader running on port", PORT));
