// Standalone concept interactions. No dependencies or network requests.
const themeButton = document.getElementById('theme-toggle');
try {
  // A saved explicit choice wins; dark is the default for a new reader.
  if (localStorage.getItem('oilbasis.theme') === 'light') document.documentElement.dataset.theme = 'light';
  else document.documentElement.dataset.theme = 'dark';
  document.documentElement.style.colorScheme = document.documentElement.dataset.theme;
} catch {}
function applyMockTheme(theme, persist = true) {
  const next = theme === 'light' ? 'light' : 'dark';
  const dark = next === 'dark';
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111713' : '#173d32');
  themeButton?.setAttribute('aria-pressed', String(dark));
  themeButton?.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  if (themeButton) themeButton.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  const label = document.querySelector('[data-theme-label]');
  if (label) label.textContent = dark ? 'Light' : 'Dark';
  if (persist) { try { localStorage.setItem('oilbasis.theme', next); } catch {} }
}
applyMockTheme(document.documentElement.dataset.theme, false);
themeButton?.addEventListener('click', () => applyMockTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

const search = document.querySelector('[data-search]');
const filterButtons = [...document.querySelectorAll('[data-filter]')];
const marketRows = [...document.querySelectorAll('#commodity-body tr')];
const watchRows = [...document.querySelectorAll('[data-watch]')];
const emptyState = document.querySelector('[data-empty]');
const densityButton = document.querySelector('[data-density]');
let activeFilter = 'all';

function filterMarkets() {
  const query = search.value.trim().toLowerCase();
  let visible = 0;

  marketRows.forEach((row) => {
    const matchesText = !query || row.textContent.toLowerCase().includes(query);
    const matchesFilter = activeFilter === 'all' || row.dataset.category === activeFilter;
    row.hidden = !(matchesText && matchesFilter);
    if (!row.hidden) visible += 1;
  });

  watchRows.forEach((row) => {
    row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
  });

  emptyState.hidden = visible !== 0;
}

filterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    activeFilter = button.dataset.filter;
    filterButtons.forEach((item) => {
      const selected = item === button;
      item.classList.toggle('on', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    filterMarkets();
  });
});

search.addEventListener('input', filterMarkets);
search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    search.value = '';
    filterMarkets();
    search.blur();
  }
});

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') || (event.key === '/' && !typing)) {
    event.preventDefault();
    search.focus();
  }
});

densityButton.addEventListener('click', () => {
  const compact = document.body.classList.toggle('compact');
  densityButton.setAttribute('aria-pressed', String(compact));
  densityButton.textContent = compact ? 'Comfortable view' : 'Compact view';
});

const clocks = [...document.querySelectorAll('[data-clock]')];
const formatters = new Map();
function updateClocks() {
  const now = new Date();
  clocks.forEach((clock) => {
    const zone = clock.dataset.clock;
    if (!formatters.has(zone)) {
      formatters.set(zone, new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }));
    }
    clock.textContent = formatters.get(zone).format(now);
  });
}
updateClocks();
setInterval(updateClocks, 1000);
