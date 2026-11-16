(function () {
  function isReloadNavigation() {
    var entries = window.performance && window.performance.getEntriesByType
      ? window.performance.getEntriesByType('navigation')
      : [];

    if (entries && entries.length) {
      return entries[0].type === 'reload';
    }

    return window.performance
      && window.performance.navigation
      && window.performance.navigation.type === 1;
  }

  if (isReloadNavigation() && !window.location.hash) {
    try {
      if ('scrollRestoration' in window.history) {
        window.history.scrollRestoration = 'manual';
      }
    } catch (error) {
      // Some embedded browsers restrict history access.
    }

    window.scrollTo(0, 0);

    window.addEventListener('load', function () {
      window.requestAnimationFrame(function () {
        window.scrollTo(0, 0);
        window.setTimeout(function () {
          try {
            if ('scrollRestoration' in window.history) {
              window.history.scrollRestoration = 'auto';
            }
          } catch (error) {
            // Some embedded browsers restrict history access.
          }
        }, 150);
      });
    });
  }

  var roots = document.querySelectorAll('[data-customhouse-collection]');

  roots.forEach(function (root) {
    var form = root.querySelector('[data-ch-filter-form]');
    var layoutTarget = root.querySelector('[data-ch-layout-target]');
    var layoutButtons = root.querySelectorAll('[data-ch-layout]');
    var storageKey = 'customhouse-layout-' + root.dataset.sectionId;
    var colorMap = {
      black: '#050505',
      white: '#ffffff',
      grey: '#888888',
      gray: '#888888',
      purple: '#7b3ff2',
      green: '#c8ff16',
      blue: '#2563eb',
      red: '#dc2626',
      yellow: '#facc15',
      orange: '#f97316',
      pink: '#ec4899',
      brown: '#8b5e3c'
    };

    root.querySelectorAll('.ch-color__swatch').forEach(function (swatch) {
      var label = (swatch.dataset.color || '').trim().toLowerCase();
      var swatchColor = colorMap[label] || '';

      if (!swatchColor) {
        Object.keys(colorMap).some(function (colorName) {
          if (label.indexOf(colorName) === -1) return false;
          swatchColor = colorMap[colorName];
          return true;
        });
      }

      swatch.style.background = swatchColor || label || '#ffffff';
    });

    if (form) {
      form.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
        input.addEventListener('change', function () {
          form.submit();
        });
      });

      form.querySelectorAll('[data-ch-auto-submit]').forEach(function (input) {
        input.addEventListener('change', function () {
          form.submit();
        });
      });

      document.addEventListener('click', function (event) {
        if (form.contains(event.target)) return;

        form.querySelectorAll('details[open]').forEach(function (details) {
          details.removeAttribute('open');
        });
      });
    }

    function setLayout(layout) {
      if (!layoutTarget) return;

      layoutTarget.classList.toggle('is-list', layout === 'list');
      layoutButtons.forEach(function (button) {
        var isActive = button.dataset.chLayout === layout;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
      });

      try {
        window.localStorage.setItem(storageKey, layout);
      } catch (error) {
        return;
      }
    }

    layoutButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        setLayout(button.dataset.chLayout);
      });
    });

    try {
      var savedLayout = window.localStorage.getItem(storageKey);
      if (savedLayout === 'list') setLayout(savedLayout);
    } catch (error) {
      return;
    }

    root.querySelectorAll('[data-ch-wishlist]').forEach(function (button) {
      var card = button.closest('[data-product-id]');
      var productId = card ? card.dataset.productId : '';
      var wishlistKey = 'customhouse-wishlist';
      var saved = [];

      try {
        saved = JSON.parse(window.localStorage.getItem(wishlistKey) || '[]');
      } catch (error) {
        saved = [];
      }

      if (saved.indexOf(productId) !== -1) {
        button.classList.add('is-active');
        button.setAttribute('aria-pressed', 'true');
      }

      button.addEventListener('click', function () {
        var index = saved.indexOf(productId);
        if (index === -1) {
          saved.push(productId);
          button.classList.add('is-active');
          button.setAttribute('aria-pressed', 'true');
        } else {
          saved.splice(index, 1);
          button.classList.remove('is-active');
          button.setAttribute('aria-pressed', 'false');
        }

        try {
          window.localStorage.setItem(wishlistKey, JSON.stringify(saved));
        } catch (error) {
          return;
        }
      });
    });
  });
})();
