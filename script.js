const menuToggle = document.querySelector('.menu-toggle');
const mainNav = document.querySelector('#main-nav');

if (menuToggle && mainNav) {
  menuToggle.addEventListener('click', () => {
    const isExpanded = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isExpanded));
    mainNav.classList.toggle('is-open', !isExpanded);
  });

  mainNav.addEventListener('click', (event) => {
    if (event.target instanceof HTMLAnchorElement) {
      menuToggle.setAttribute('aria-expanded', 'false');
      mainNav.classList.remove('is-open');
    }
  });
}

const publicGallery = document.querySelector('#public-gallery');
const galleryStatus = document.querySelector('#gallery-status');

async function loadGallery() {
  try {
    const response = await fetch('/api/gallery', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('No se pudieron cargar las imágenes.');
    }

    const { images } = await response.json();
    publicGallery.replaceChildren();

    if (images.length === 0) {
      galleryStatus.textContent = 'Pronto compartiremos por aquí nuestras tartas.';
      return;
    }

    for (const image of images) {
      const card = document.createElement('figure');
      card.className = 'public-gallery-item';

      const photo = document.createElement('img');
      photo.src = image.url;
      photo.alt = "Tarta casera de queso de Cubcake's";
      photo.loading = 'lazy';
      photo.decoding = 'async';

      card.append(photo);
      publicGallery.append(card);
    }

    galleryStatus.textContent = '';
  } catch {
    galleryStatus.textContent = 'No se pudieron cargar las imágenes. Inténtalo más tarde.';
  }
}

if (publicGallery && galleryStatus) {
  loadGallery();
}
