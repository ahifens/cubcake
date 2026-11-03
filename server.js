const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');

const ROOT = __dirname;
const SESSION_COOKIE = 'cubcake_admin';
const SESSION_DURATION = 8 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_IMAGES = 50;
const IMAGE_ID_PATTERN = /^[a-f0-9]{32}$/;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/script.js', ['script.js', 'text/javascript; charset=utf-8']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.html', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/assets/logo.png', ['assets/logo.png', 'image/png']],
  ['/assets/cheesecake.png', ['assets/cheesecake.png', 'image/png']],
]);

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

function createApp({
  uploadsDir = process.env.UPLOADS_DIR || path.join(ROOT, 'data', 'images'),
  adminPassword = process.env.ADMIN_PASSWORD,
  secureCookies = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true',
  trustProxy = process.env.RENDER === 'true' ? 1 : false,
} = {}) {
  if (typeof adminPassword !== 'string' || Buffer.byteLength(adminPassword) < 16) {
    throw new Error('Set ADMIN_PASSWORD to a password with at least 16 characters.');
  }

  if (process.env.RENDER === 'true' && !process.env.UPLOADS_DIR) {
    throw new Error('Set UPLOADS_DIR to the mount path of the Render persistent disk.');
  }

  fs.mkdirSync(uploadsDir, { recursive: true });

  const app = express();
  const sessions = new Map();
  const passwordDigest = crypto.createHash('sha256').update(adminPassword).digest();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1 },
  });

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });

    if (secureCookies) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  });

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', express.json({ limit: '4kb', strict: true }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Demasiados intentos. Espera 15 minutos y vuelve a intentarlo.' },
  });

  const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Has alcanzado el límite temporal de publicaciones.' },
  });

  function requireSameOrigin(req, res, next) {
    const origin = req.get('origin');
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;

    if (!origin || origin !== expectedOrigin) {
      return sendError(res, 403, 'Origen no permitido.');
    }

    next();
  }

  function getSessionToken(req) {
    const cookies = (req.headers.cookie || '').split(';');

    for (const cookie of cookies) {
      const separator = cookie.indexOf('=');
      if (separator === -1 || cookie.slice(0, separator).trim() !== SESSION_COOKIE) {
        continue;
      }

      return cookie.slice(separator + 1).trim();
    }

    return null;
  }

  function requireAdmin(req, res, next) {
    const token = getSessionToken(req);
    const expiresAt = token ? sessions.get(token) : undefined;

    if (!expiresAt || expiresAt <= Date.now()) {
      if (token) {
        sessions.delete(token);
      }
      return sendError(res, 401, 'Inicia sesión para continuar.');
    }

    next();
  }

  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/api/gallery', async (req, res, next) => {
    try {
      const entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true });
      const images = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && IMAGE_ID_PATTERN.test(entry.name.replace(/\.webp$/, '')) && entry.name.endsWith('.webp'))
          .map(async (entry) => {
            const id = entry.name.slice(0, -5);
            const stats = await fs.promises.stat(path.join(uploadsDir, entry.name));
            return { id, url: `/api/gallery/images/${id}`, uploadedAt: stats.mtime.toISOString() };
          }),
      );

      images.sort((first, second) => second.uploadedAt.localeCompare(first.uploadedAt));
      res.json({ images });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/gallery/images/:id', async (req, res, next) => {
    if (!IMAGE_ID_PATTERN.test(req.params.id)) {
      return sendError(res, 404, 'Imagen no encontrada.');
    }

    const filePath = path.join(uploadsDir, `${req.params.id}.webp`);

    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      res.set({
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': 'image/webp',
      });
      res.sendFile(filePath, (error) => {
        if (error && !res.headersSent) {
          next(error);
        }
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return sendError(res, 404, 'Imagen no encontrada.');
      }
      next(error);
    }
  });

  app.get('/api/admin/session', (req, res) => {
    const token = getSessionToken(req);
    const expiresAt = token ? sessions.get(token) : undefined;
    res.json({ authenticated: Boolean(expiresAt && expiresAt > Date.now()) });
  });

  app.post('/api/admin/login', requireSameOrigin, loginLimiter, (req, res) => {
    const submittedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
    const submittedDigest = crypto.createHash('sha256').update(submittedPassword).digest();

    if (!crypto.timingSafeEqual(passwordDigest, submittedDigest)) {
      return sendError(res, 401, 'La contraseña no es correcta.');
    }

    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_DURATION);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      maxAge: SESSION_DURATION,
      path: '/',
      sameSite: 'strict',
      secure: secureCookies,
    });
    res.json({ authenticated: true });
  });

  app.post('/api/admin/logout', requireSameOrigin, requireAdmin, (req, res) => {
    sessions.delete(getSessionToken(req));
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      path: '/',
      sameSite: 'strict',
      secure: secureCookies,
    });
    res.json({ authenticated: false });
  });

  app.post(
    '/api/admin/images',
    requireSameOrigin,
    requireAdmin,
    uploadLimiter,
    upload.single('image'),
    async (req, res, next) => {
      if (!req.file) {
        return sendError(res, 400, 'Selecciona una imagen JPG, PNG o WebP.');
      }

      let image;
      try {
        image = sharp(req.file.buffer, {
          limitInputPixels: MAX_IMAGE_PIXELS,
          animated: false,
          failOn: 'error',
        });

        let metadata;
        try {
          metadata = await image.metadata();
        } catch {
          return sendError(res, 415, 'El archivo no contiene una imagen válida.');
        }

        if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
          return sendError(res, 415, 'Solo se admiten imágenes JPG, PNG o WebP.');
        }

        const existingImages = await fs.promises.readdir(uploadsDir);
        const imageCount = existingImages.filter(
          (filename) => filename.endsWith('.webp') && IMAGE_ID_PATTERN.test(filename.slice(0, -5)),
        ).length;

        if (imageCount >= MAX_IMAGES) {
          return sendError(res, 409, `La galería admite un máximo de ${MAX_IMAGES} imágenes.`);
        }

        const id = crypto.randomBytes(16).toString('hex');
        const outputPath = path.join(uploadsDir, `${id}.webp`);
        let output;
        try {
          output = await image
            .rotate()
            .resize({
              width: 1600,
              height: 1600,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .webp({ quality: 82 })
            .toBuffer();
        } catch {
          return sendError(res, 415, 'No se pudo procesar la imagen. Prueba con otro archivo.');
        }

        await fs.promises.writeFile(outputPath, output, { flag: 'wx', mode: 0o644 });
        res.status(201).json({ image: { id, url: `/api/gallery/images/${id}` } });
      } catch (error) {
        if (error.code === 'ENOSPC') {
          return sendError(res, 507, 'No queda espacio disponible para guardar la imagen.');
        }
        next(error);
      } finally {
        image?.destroy();
      }
    },
  );

  app.delete('/api/admin/images/:id', requireSameOrigin, requireAdmin, async (req, res, next) => {
    if (!IMAGE_ID_PATTERN.test(req.params.id)) {
      return sendError(res, 404, 'Imagen no encontrada.');
    }

    try {
      await fs.promises.unlink(path.join(uploadsDir, `${req.params.id}.webp`));
      res.status(204).end();
    } catch (error) {
      if (error.code === 'ENOENT') {
        return sendError(res, 404, 'Imagen no encontrada.');
      }
      next(error);
    }
  });

  app.get('/api/*path', (req, res) => {
    sendError(res, 404, 'Recurso no encontrado.');
  });

  app.get('/api', (req, res) => {
    sendError(res, 404, 'Recurso no encontrado.');
  });

  app.get('*path', (req, res, next) => {
    const file = STATIC_FILES.get(req.path);

    if (!file) {
      return sendError(res, 404, 'Página no encontrada.');
    }

    const [relativePath, contentType] = file;
    res.set({
      'Cache-Control': /\.(html|css|js)$/.test(relativePath) ? 'no-cache' : 'public, max-age=3600',
      'Content-Type': contentType,
    });
    res.sendFile(path.join(ROOT, relativePath), (error) => {
      if (error && !res.headersSent) {
        next(error);
      }
    });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'La imagen supera el límite de 8 MB.'
        : 'La subida debe contener una sola imagen.';
      return sendError(res, 400, message);
    }

    console.error('Error al procesar la solicitud:', error);
    sendError(res, 500, 'No se pudo completar la solicitud. Inténtalo de nuevo.');
  });

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [token, expiresAt] of sessions) {
      if (expiresAt <= now) {
        sessions.delete(token);
      }
    }
  }, 60 * 60 * 1000);
  cleanup.unref();

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Cubcake's web service listening on port ${port}`);
  });
}

module.exports = { createApp };
