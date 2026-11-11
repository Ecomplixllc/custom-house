(() => {
  const roots = document.querySelectorAll('[data-chd-root]');

  const clean = (value) => String(value ?? '').trim();
  const normalize = (value) => clean(value).toLocaleLowerCase();
  const unique = (values) => [...new Set(values.map(clean).filter(Boolean))];
  const split = (value) => unique(clean(value).split('||'));
  const titleCase = (value) => clean(value)
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  function parseJson(value, fallback) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function asList(value) {
    if (Array.isArray(value)) return unique(value);
    if (value && typeof value === 'object') return unique(Object.values(value));
    return clean(value) ? [clean(value)] : [];
  }

  function productionMethods(value) {
    const parsed = parseJson(value, null);
    const source = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.productionMethods)
        ? parsed.productionMethods
        : [];
    return unique(source.map((method) => {
      if (typeof method === 'string') return method;
      return method?.label || method?.id || method?.code || method?.method || '';
    }));
  }

  function safeImageUrl(value) {
    const url = clean(value);
    return /^(https?:\/\/|\/)/i.test(url) ? url : '';
  }

  function createImage(src, alt) {
    const safe = safeImageUrl(src);
    if (!safe) return null;
    const image = document.createElement('img');
    image.src = safe;
    image.alt = clean(alt);
    image.loading = 'lazy';
    return image;
  }

  roots.forEach((root) => {
    const cards = [...root.querySelectorAll('[data-chd-product]')];
    const grid = root.querySelector('[data-chd-product-grid]');
    const empty = root.querySelector('[data-chd-product-empty]');
    const activeFilters = root.querySelector('[data-chd-active-filters]');
    const resultCount = root.querySelector('[data-chd-result-count]');
    const sort = root.querySelector('[data-chd-sort]');
    const priceMin = root.querySelector('[data-chd-price-min]');
    const priceMax = root.querySelector('[data-chd-price-max]');
    const selected = new Map(['category', 'fit', 'brand', 'color', 'method'].map((key) => [key, new Set()]));
    const urlState = new URLSearchParams(window.location.search);

    const records = cards.map((card, index) => ({
      card,
      index,
      title: clean(card.dataset.title),
      category: split(card.dataset.category),
      fit: asList(parseJson(card.dataset.fit, card.dataset.fit)),
      brand: clean(card.dataset.brand) ? [clean(card.dataset.brand)] : [],
      color: split(card.dataset.color),
      method: productionMethods(card.dataset.productionPricing),
      price: Number(card.dataset.price || 0),
      published: Number(card.dataset.published || 0),
    }));

    function valuesFor(key) {
      return unique(records.flatMap((record) => record[key] || []))
        .sort((left, right) => left.localeCompare(right));
    }

    function buildFacets() {
      selected.forEach((values, key) => {
        const container = root.querySelector(`[data-chd-filter-options="${key}"]`);
        if (!container) return;
        const available = valuesFor(key);
        const details = container.closest('[data-chd-filter]');
        if (!available.length) {
          if (details) details.hidden = true;
          return;
        }
        available.forEach((value) => {
          const label = document.createElement('label');
          const input = document.createElement('input');
          const text = document.createElement('span');
          input.type = 'checkbox';
          input.value = value;
          input.dataset.chdFacetInput = key;
          input.checked = urlState.getAll(key).some((item) => normalize(item) === normalize(value));
          if (input.checked) values.add(value);
          text.textContent = key === 'category' ? titleCase(value) : value;
          label.append(input, text);
          container.append(label);
        });
      });

      if (records.length && priceMin && priceMax) {
        const prices = records.map((record) => record.price).filter(Number.isFinite);
        priceMin.placeholder = String(Math.floor(Math.min(...prices) / 100));
        priceMax.placeholder = String(Math.ceil(Math.max(...prices) / 100));
        priceMin.value = urlState.get('price_min') || '';
        priceMax.value = urlState.get('price_max') || '';
      }
      if (sort && urlState.has('sort')) sort.value = urlState.get('sort');
    }

    function syncUrl() {
      const params = new URLSearchParams(window.location.search);
      selected.forEach((values, key) => {
        params.delete(key);
        values.forEach((value) => params.append(key, value));
      });
      ['price_min', 'price_max', 'sort'].forEach((key) => params.delete(key));
      if (clean(priceMin?.value)) params.set('price_min', clean(priceMin.value));
      if (clean(priceMax?.value)) params.set('price_max', clean(priceMax.value));
      if (sort?.value && sort.value !== 'relevant') params.set('sort', sort.value);
      const query = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }

    function renderChips() {
      if (!activeFilters) return;
      activeFilters.replaceChildren();
      selected.forEach((values, key) => values.forEach((value) => {
        const button = document.createElement('button');
        const close = document.createElement('span');
        button.type = 'button';
        button.className = 'chd-filter-chip';
        button.dataset.key = key;
        button.dataset.value = value;
        button.textContent = `${titleCase(key)}: ${key === 'category' ? titleCase(value) : value}`;
        close.textContent = '×';
        close.setAttribute('aria-hidden', 'true');
        button.append(close);
        activeFilters.append(button);
      }));
      [['price_min', priceMin, 'Min price'], ['price_max', priceMax, 'Max price']].forEach(([key, input, label]) => {
        if (!clean(input?.value)) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chd-filter-chip';
        button.dataset.priceKey = key;
        button.textContent = `${label}: ${input.value} ×`;
        activeFilters.append(button);
      });
    }

    function includesSelected(record, key) {
      const values = selected.get(key);
      if (!values?.size) return true;
      const actual = (record[key] || []).map(normalize);
      return [...values].some((value) => actual.includes(normalize(value)));
    }

    function applyProducts() {
      const min = clean(priceMin?.value) ? Number(priceMin.value) * 100 : null;
      const max = clean(priceMax?.value) ? Number(priceMax.value) * 100 : null;
      const visible = records.filter((record) => (
        [...selected.keys()].every((key) => includesSelected(record, key)) &&
        (min === null || record.price >= min) &&
        (max === null || record.price <= max)
      ));
      const order = [...records];
      if (sort?.value === 'newest') order.sort((a, b) => b.published - a.published || a.index - b.index);
      if (sort?.value === 'price-asc') order.sort((a, b) => a.price - b.price || a.index - b.index);
      if (sort?.value === 'price-desc') order.sort((a, b) => b.price - a.price || a.index - b.index);
      if (sort?.value === 'relevant') order.sort((a, b) => a.index - b.index);
      order.forEach((record) => grid?.append(record.card));
      records.forEach((record) => { record.card.hidden = !visible.includes(record); });
      if (empty) empty.hidden = visible.length > 0;
      if (resultCount) resultCount.textContent = `(${visible.length})`;
      renderChips();
      syncUrl();
    }

    buildFacets();
    root.addEventListener('change', (event) => {
      const input = event.target.closest('[data-chd-facet-input]');
      if (input) {
        const values = selected.get(input.dataset.chdFacetInput);
        if (input.checked) values?.add(input.value); else values?.delete(input.value);
      }
      if (input || event.target === sort || event.target === priceMin || event.target === priceMax) applyProducts();
    });
    root.addEventListener('input', (event) => {
      if (event.target === priceMin || event.target === priceMax) applyProducts();
    });
    activeFilters?.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.key) {
        selected.get(button.dataset.key)?.delete(button.dataset.value);
        root.querySelectorAll(`[data-chd-facet-input="${button.dataset.key}"]`).forEach((input) => {
          if (input.value === button.dataset.value) input.checked = false;
        });
      }
      if (button.dataset.priceKey === 'price_min' && priceMin) priceMin.value = '';
      if (button.dataset.priceKey === 'price_max' && priceMax) priceMax.value = '';
      applyProducts();
    });
    const filterToggle = root.querySelector('[data-chd-filter-toggle]');
    const filterPanel = root.querySelector('[data-chd-filter-panel]');
    filterToggle?.addEventListener('click', () => {
      const open = filterPanel?.classList.toggle('is-open') || false;
      filterToggle.setAttribute('aria-expanded', String(open));
    });
    applyProducts();

    const creatorSearch = root.querySelector('[data-chd-creator-search]');
    const creatorSort = root.querySelector('[data-chd-creator-sort]');
    const tags = root.querySelector('[data-chd-interest-tags]');
    const creatorGrid = root.querySelector('[data-chd-creator-grid]');
    const designGrid = root.querySelector('[data-chd-design-grid]');
    const creatorStatus = root.querySelector('[data-chd-creator-status]');
    let directory = [];
    let activeTag = '';

    function renderDirectory() {
      const query = normalize(creatorSearch?.value);
      const matches = directory.filter((creator) => {
        const categories = Array.isArray(creator.categories) ? creator.categories : [];
        const products = Array.isArray(creator.products) ? creator.products : [];
        const searchable = [creator.displayName, creator.handle, creator.collectionName, ...categories, ...products.flatMap((product) => [product.title, product.description])].map(normalize);
        return (!activeTag || categories.some((category) => normalize(category) === normalize(activeTag))) && (!query || searchable.some((value) => value.includes(query)));
      });
      matches.sort((left, right) => creatorSort?.value === 'az'
        ? clean(left.displayName).localeCompare(clean(right.displayName))
        : new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0));
      creatorGrid?.replaceChildren();
      designGrid?.replaceChildren();

      matches.forEach((creator) => {
        const card = document.createElement('article');
        card.className = 'chd-creator-card';
        const avatar = document.createElement('div');
        avatar.className = 'chd-creator-card__avatar';
        const avatarImage = createImage(creator.profileImageUrl, creator.displayName);
        if (avatarImage) avatar.append(avatarImage); else avatar.textContent = clean(creator.displayName).slice(0, 1).toUpperCase() || 'C';
        const body = document.createElement('div');
        const name = document.createElement('h3');
        const meta = document.createElement('p');
        name.textContent = clean(creator.displayName) || 'Creator';
        meta.textContent = unique(creator.categories || []).join(' · ') || clean(creator.collectionName);
        body.append(name, meta);
        const link = document.createElement('a');
        link.className = 'chd-creator-card__view';
        link.href = clean(creator.collectionUrl) || '#';
        link.textContent = 'View';
        card.append(avatar, body, link);
        creatorGrid?.append(card);

        (Array.isArray(creator.products) ? creator.products : []).forEach((product) => {
          const design = document.createElement('article');
          design.className = 'chd-design-card';
          const mediaLink = document.createElement('a');
          mediaLink.className = 'chd-design-card__media';
          mediaLink.href = clean(product.viewUrl) || clean(creator.collectionUrl) || '#';
          let preview = clean(product.previewUrl);
          if (!preview) preview = asList(parseJson(product.previewUrls, [])).find(safeImageUrl) || '';
          const image = createImage(preview, product.title);
          if (image) mediaLink.append(image); else {
            const fallback = document.createElement('span');
            fallback.textContent = clean(product.title).slice(0, 1).toUpperCase() || 'D';
            mediaLink.append(fallback);
          }
          const body = document.createElement('div');
          body.className = 'chd-design-card__body';
          const title = document.createElement('h3');
          const creatorName = document.createElement('p');
          title.textContent = clean(product.title) || 'Untitled design';
          creatorName.textContent = `By ${clean(creator.displayName) || 'Creator'}`;
          body.append(title, creatorName);
          design.append(mediaLink, body);
          designGrid?.append(design);
        });
      });
      if (creatorStatus) {
        creatorStatus.hidden = false;
        creatorStatus.textContent = matches.length ? `${matches.length} creator collection${matches.length === 1 ? '' : 's'}` : 'No creator content matches your search.';
      }
    }

    async function loadCreators() {
      const endpoint = clean(root.dataset.creatorEndpoint);
      if (!endpoint) {
        if (creatorStatus) creatorStatus.textContent = 'Creator directory endpoint is not configured.';
        return;
      }
      try {
        const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        const payload = await response.json();
        if (!response.ok || !payload?.ok || !Array.isArray(payload.creators)) throw new Error('CREATOR_DIRECTORY_UNAVAILABLE');
        directory = payload.creators;
        unique(payload.categories || []).forEach((category) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'chd-interest-tag';
          button.textContent = category;
          button.setAttribute('aria-pressed', 'false');
          button.addEventListener('click', () => {
            activeTag = activeTag === category ? '' : category;
            tags?.querySelectorAll('button').forEach((item) => item.setAttribute('aria-pressed', String(item === button && Boolean(activeTag))));
            renderDirectory();
          });
          tags?.append(button);
        });
        renderDirectory();
      } catch {
        if (creatorStatus) creatorStatus.textContent = 'Creator content is temporarily unavailable.';
      }
    }

    creatorSearch?.addEventListener('input', renderDirectory);
    creatorSort?.addEventListener('change', renderDirectory);
    loadCreators();
  });
})();
