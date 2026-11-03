# Cubcake's

## Render Web Service

- **Build Command:** `npm install`
- **Start Command:** `npm start`
- Use Node.js 20 or newer.
- Attach a persistent disk to the web service at `/var/data`.
- Add these environment variables in Render:
  - `UPLOADS_DIR=/var/data/images`
  - `ADMIN_PASSWORD`: a private, randomly generated password of at least 16 characters.
- Set `NODE_ENV=production`. The app refuses to start on Render if `UPLOADS_DIR` is missing, to avoid saving uploads to the temporary filesystem.

Open `/admin` on the deployed site, sign in with `ADMIN_PASSWORD`, and upload JPG, PNG, or WebP images. Images are validated, resized, converted to WebP, and stored on the persistent disk. They then appear in the public gallery under `#tarta`.

The admin session is held in memory and expires after eight hours. Sign in again after a deploy or restart. Keep the service to one instance when using a local persistent disk, because Render disks are not shared between instances.

The upload limit is 8 MB per image, with a maximum of 50 gallery images. Only the authenticated administrator can publish or delete images.

Run the test suite with `npm test`.
