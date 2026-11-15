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
