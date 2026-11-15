// Standalone mockup interactions. Kept in its own file because the production server's CSP allows
// same-origin scripts but blocks inline ones — an inline copy left the boot overlay stuck on screen.
const boot = document.getElementById('boot');
const done = () => boot.classList.add('done');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

setTimeout(done, reduce ? 250 : 950);
boot.addEventListener('click', done);

document.querySelectorAll('.subnav button').forEach((b) => b.addEventListener('click', () => {
  b.parentElement.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
}));

// Palette switcher: a design-review control, not a shipped preference.
const paletteButtons = [...document.querySelectorAll('[data-palette]')];
const setPalette = (name) => {
  document.body.dataset.theme = name;
  paletteButtons.forEach((b) => b.classList.toggle('on', b.dataset.palette === name));
  try { localStorage.setItem('watchtower.mockPalette', name); } catch {}
};
paletteButtons.forEach((b) => b.addEventListener('click', () => setPalette(b.dataset.palette)));
const params = new URLSearchParams(location.search);
const requested = params.get('theme');
let saved = null;
try { saved = localStorage.getItem('watchtower.mockPalette'); } catch {}
const initial = paletteButtons.some((b) => b.dataset.palette === requested) ? requested
  : paletteButtons.some((b) => b.dataset.palette === saved) ? saved
    : document.body.dataset.theme || 'reuters';
setPalette(initial);
