const loginForm = document.querySelector('#login-form');
const dashboard = document.querySelector('#dashboard');
const uploadForm = document.querySelector('#upload-form');
const gallery = document.querySelector('#admin-gallery');
const message = document.querySelector('#admin-message');
const logoutButton = document.querySelector('#logout-button');

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('is-error', isError);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
  });

  if (response.status === 204) {
    return null;
  }

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || 'No se pudo completar la solicitud.');
  }

  return result;
}

function setAuthenticated(authenticated) {
  loginForm.hidden = authenticated;
  dashboard.hidden = !authenticated;
}

async function loadImages() {
  const { images } = await request('/api/gallery');
  gallery.replaceChildren();

  if (images.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'gallery-empty';
    empty.textContent = 'Todavía no hay imágenes publicadas.';
    gallery.append(empty);
    return;
  }

  for (const image of images) {
    const card = document.createElement('article');
    card.className = 'admin-image-card';

    const preview = document.createElement('img');
    preview.src = image.url;
    preview.alt = 'Imagen publicada en la web';
    preview.loading = 'lazy';

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'delete-button';
    removeButton.textContent = 'Eliminar';
    removeButton.setAttribute('aria-label', 'Eliminar esta imagen');
    removeButton.addEventListener('click', async () => {
      if (!window.confirm('¿Quieres eliminar esta imagen de la web?')) {
        return;
      }

      removeButton.disabled = true;
      try {
        await request(`/api/admin/images/${encodeURIComponent(image.id)}`, { method: 'DELETE' });
        await loadImages();
        showMessage('Imagen eliminada.');
      } catch (error) {
        removeButton.disabled = false;
        showMessage(error.message, true);
      }
    });

    card.append(preview, removeButton);
    gallery.append(card);
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = loginForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  showMessage('');

  try {
    const password = new FormData(loginForm).get('password');
    await request('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    loginForm.reset();
    setAuthenticated(true);
    await loadImages();
    showMessage('Has iniciado sesión.');
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = uploadForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  showMessage('');

  try {
    await request('/api/admin/images', {
      method: 'POST',
      body: new FormData(uploadForm),
    });
    uploadForm.reset();
    await loadImages();
    showMessage('Imagen publicada en la web.');
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    await request('/api/admin/logout', { method: 'POST' });
    gallery.replaceChildren();
    setAuthenticated(false);
    showMessage('Has cerrado sesión.');
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    logoutButton.disabled = false;
  }
});

request('/api/admin/session')
  .then(async ({ authenticated }) => {
    setAuthenticated(authenticated);
    if (authenticated) {
      await loadImages();
    }
  })
  .catch((error) => {
    setAuthenticated(false);
    showMessage(error.message, true);
  });
