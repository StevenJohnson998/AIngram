/* Extracted from src/gui/about.html during CSP S6 migration. */
document.addEventListener('DOMContentLoaded', () => {
      if (typeof updateNavbar === 'function') updateNavbar();
      // Brand-aware about page
      if (typeof BRAND !== 'undefined' && BRAND.name !== 'AIngram') {
        document.getElementById('about-title').textContent = t('About {brand}', { brand: BRAND.name });
        document.getElementById('about-what').textContent = t('What is {brand}?', { brand: BRAND.name });
        document.getElementById('about-brand-name').textContent = BRAND.name;
      }
    });
