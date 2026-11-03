const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const sharp = require('sharp');
const { createApp } = require('./server');

const ADMIN_PASSWORD = 'a-test-password-with-more-than-16-characters';
const PNG_FIXTURE = sharp({
  create: {
    width: 1,
    height: 1,
    channels: 4,
    background: '#d66b55',
  },
}).png().toBuffer();
const openServers = new Set();
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...openServers].map((server) => new Promise((resolve) => server.close(resolve))),
  );
  openServers.clear();

  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      fs.promises.rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

async function startServer(uploadsDir) {
  const app = createApp({
    uploadsDir,
    adminPassword: ADMIN_PASSWORD,
    secureCookies: false,
    trustProxy: false,
  });
  const server = app.listen(0, '127.0.0.1');
  openServers.add(server);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

function sameOriginHeaders(url, cookie) {
  const headers = { origin: url };
  if (cookie) {
    headers.cookie = cookie;
  }
  return headers;
}

async function signIn(url) {
  const response = await fetch(`${url}/api/admin/login`, {
    method: 'POST',
    headers: {
      ...sameOriginHeaders(url),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });

  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  return cookie;
}

test('requires a strong admin password before starting', () => {
  assert.throws(
    () => createApp({ uploadsDir: os.tmpdir(), adminPassword: 'short' }),
    /at least 16 characters/,
  );
});

test('serves the current footer stylesheet without a stale browser cache', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cubcake-images-'));
  temporaryDirectories.add(directory);
  const { url } = await startServer(directory);

  const htmlResponse = await fetch(url);
  const html = await htmlResponse.text();
  assert.match(html, /styles\.css\?v=20261103-footer/);

  const cssResponse = await fetch(`${url}/styles.css?v=20261103-footer`);
  assert.equal(cssResponse.headers.get('cache-control'), 'no-cache');
  assert.match(await cssResponse.text(), /\.site-footer\.credits-footer/);
});

test('protects publishing, persists normalized images, and allows deletion', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cubcake-images-'));
  temporaryDirectories.add(directory);

  const { url } = await startServer(directory);
  const unauthenticatedUpload = await fetch(`${url}/api/admin/images`, {
    method: 'POST',
    headers: sameOriginHeaders(url),
  });
  assert.equal(unauthenticatedUpload.status, 401);

  const cookie = await signIn(url);
  const form = new FormData();
  form.append('image', new Blob([await PNG_FIXTURE], { type: 'image/png' }), 'cake.png');
  const uploadResponse = await fetch(`${url}/api/admin/images`, {
    method: 'POST',
    headers: sameOriginHeaders(url, cookie),
    body: form,
  });

  assert.equal(uploadResponse.status, 201);
  const { image } = await uploadResponse.json();
  assert.match(image.id, /^[a-f0-9]{32}$/);

  const galleryResponse = await fetch(`${url}/api/gallery`);
  assert.equal(galleryResponse.status, 200);
  assert.equal((await galleryResponse.json()).images.length, 1);

  const storedPath = path.join(directory, `${image.id}.webp`);
  const storedMetadata = await sharp(await fs.promises.readFile(storedPath)).metadata();
  assert.equal(storedMetadata.format, 'webp');

  const restart = await startServer(directory);
  const galleryAfterRestart = await fetch(`${restart.url}/api/gallery`);
  assert.equal((await galleryAfterRestart.json()).images[0].id, image.id);

  const deleteResponse = await fetch(`${restart.url}/api/admin/images/${image.id}`, {
    method: 'DELETE',
    headers: sameOriginHeaders(restart.url, await signIn(restart.url)),
  });
  assert.equal(deleteResponse.status, 204);
  assert.equal(fs.existsSync(storedPath), false);
});

test('rejects cross-origin login and uploads that are not valid images', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cubcake-images-'));
  temporaryDirectories.add(directory);
  const { url } = await startServer(directory);

  const crossOrigin = await fetch(`${url}/api/admin/login`, {
    method: 'POST',
    headers: {
      origin: 'https://attacker.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(crossOrigin.status, 403);

  const cookie = await signIn(url);
  const form = new FormData();
  form.append('image', new Blob([crypto.randomBytes(64)], { type: 'image/png' }), 'fake.png');
  const uploadResponse = await fetch(`${url}/api/admin/images`, {
    method: 'POST',
    headers: sameOriginHeaders(url, cookie),
    body: form,
  });

  assert.equal(uploadResponse.status, 415);
  assert.deepEqual(await fs.promises.readdir(directory), []);
});
