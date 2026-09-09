(() => {
  document.querySelectorAll('[data-local-datetime]').forEach(el => {
    const date = new Date(el.dataset.localDatetime || el.textContent);
    if (Number.isFinite(date.getTime())) {
      el.textContent = date.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });
    }
  });

  document.querySelectorAll('form[data-confirm]').forEach(form => {
    form.addEventListener('submit', event => {
      const message = form.dataset.confirm || 'Are you sure?';
      if (!window.confirm(message)) event.preventDefault();
    });
  });

  const builder = document.querySelector('[data-rank-builder]');
  if (!builder) return;

  const requiredCount = Number(builder.dataset.requiredCount || 25);
  const pool = document.getElementById('bandPool');
  const list = document.getElementById('rankList');
  const search = document.getElementById('bandSearch');
  const searchStatus = document.getElementById('bandSearchStatus');
  const searchEmpty = document.getElementById('bandSearchEmpty');
  const count = document.getElementById('selectedCount');
  const rankingsJson = document.getElementById('rankingsJson');
  const save = document.getElementById('saveRankings');
  const message = document.getElementById('rankMessage');
  const clear = document.getElementById('clearRankings');
  let dragging = null;

  function selectedIds() {
    return [...list.querySelectorAll('.rank-item')].map(el => Number(el.dataset.bandId));
  }

  function makeItem(button) {
    const li = document.createElement('li');
    li.className = 'rank-item';
    li.draggable = true;
    li.dataset.bandId = button.dataset.bandId;
    li.dataset.bandName = button.dataset.bandName;
    li.dataset.location = button.dataset.location || '';

    const rank = document.createElement('span');
    rank.className = 'rank-number';
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⋮⋮';
    grip.setAttribute('role', 'button');
    grip.setAttribute('aria-label', 'Drag to reorder');
    grip.setAttribute('title', 'Drag to reorder');
    const copy = document.createElement('span');
    copy.className = 'rank-copy';
    const strong = document.createElement('strong');
    strong.textContent = button.dataset.bandName;
    const small = document.createElement('small');
    small.textContent = button.dataset.location || 'Location not listed';
    copy.append(strong, small);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-band';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${button.dataset.bandName}`);
    li.append(rank, grip, copy, remove);
    return li;
  }

  function update() {
    const items = [...list.querySelectorAll('.rank-item')];
    items.forEach((item, i) => { item.querySelector('.rank-number').textContent = String(i + 1); });
    const ids = selectedIds();
    rankingsJson.value = JSON.stringify(ids);
    count.textContent = String(ids.length);
    pool.querySelectorAll('.band-option').forEach(btn => {
      btn.classList.toggle('is-selected', ids.includes(Number(btn.dataset.bandId)));
    });
    const remaining = requiredCount - ids.length;
    if (remaining > 0) {
      message.innerHTML = `Rank <strong>${remaining}</strong> more band${remaining === 1 ? '' : 's'} to complete your ballot.`;
      save.disabled = true;
    } else {
      message.innerHTML = '<strong>Your ballot is complete.</strong> Save whenever you are ready.';
      save.disabled = false;
    }
  }

  pool.addEventListener('click', event => {
    const button = event.target.closest('.band-option');
    if (!button || button.classList.contains('is-selected') || list.children.length >= requiredCount) return;
    list.appendChild(makeItem(button));
    update();
  });

  list.addEventListener('click', event => {
    const remove = event.target.closest('.remove-band');
    if (!remove) return;
    remove.closest('.rank-item').remove();
    update();
  });

  function normalizeSearch(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function filterBands() {
    const term = normalizeSearch(search.value);
    const terms = term ? term.split(' ') : [];
    const buttons = [...pool.querySelectorAll('.band-option')];
  
    let visible = 0;
  
    buttons.forEach(btn => {
      const haystack = normalizeSearch(
        `${btn.dataset.bandName || ''} ${btn.dataset.location || ''}`
      );
  
      const matches =
        terms.length === 0 ||
        terms.every(word => haystack.includes(word));
  
      btn.classList.toggle('is-filtered-out', !matches);
      btn.hidden = !matches;
      btn.setAttribute('aria-hidden', matches ? 'false' : 'true');
  
      if (matches) visible += 1;
    });
  
    if (searchStatus) {
      searchStatus.textContent = term
        ? `${visible} matching band${visible === 1 ? '' : 's'}`
        : `${buttons.length} bands available`;
    }
  
    if (searchEmpty) {
      searchEmpty.hidden = visible !== 0;
    }
  }

  search.addEventListener('input', filterBands);
  search.addEventListener('search', filterBands);
  filterBands();

  

  clear.addEventListener('click', () => {
    list.innerHTML = '';
    update();
  });

  list.addEventListener('dragstart', event => {
    const item = event.target.closest('.rank-item');
    if (!item) return;
    dragging = item;
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  });

  list.addEventListener('dragend', () => {
    if (dragging) dragging.classList.remove('dragging');
    dragging = null;
    update();
  });

  list.addEventListener('dragover', event => {
    event.preventDefault();
    if (!dragging) return;
    const after = [...list.querySelectorAll('.rank-item:not(.dragging)')].reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = event.clientY - box.top - box.height / 2;
      return offset < 0 && offset > closest.offset ? { offset, element: child } : closest;
    }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
    if (after) list.insertBefore(dragging, after); else list.appendChild(dragging);
  });
  // Touch/pen drag support using the visible grip. Desktop still uses native HTML5 drag-and-drop.
  let pointerDragging = null;

  list.addEventListener('pointerdown', event => {
    const grip = event.target.closest('.grip');
    if (!grip || event.pointerType === 'mouse') return;
    const item = grip.closest('.rank-item');
    if (!item) return;
    pointerDragging = item;
    item.classList.add('dragging');
    grip.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  list.addEventListener('pointermove', event => {
    if (!pointerDragging || event.pointerType === 'mouse') return;
    event.preventDefault();
    const candidates = [...list.querySelectorAll('.rank-item:not(.dragging)')];
    let before = null;
    for (const child of candidates) {
      const box = child.getBoundingClientRect();
      if (event.clientY < box.top + box.height / 2) {
        before = child;
        break;
      }
    }
    if (before) list.insertBefore(pointerDragging, before);
    else list.appendChild(pointerDragging);
  });

  function finishPointerDrag() {
    if (!pointerDragging) return;
    pointerDragging.classList.remove('dragging');
    pointerDragging = null;
    update();
  }

  list.addEventListener('pointerup', finishPointerDrag);
  list.addEventListener('pointercancel', finishPointerDrag);

  update();
})();
