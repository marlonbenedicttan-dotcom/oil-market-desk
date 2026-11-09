// Motion for the global coverage map.
//
// A few pixels of pointer parallax on the map that is already on screen: no canvas, no library, no
// extra request. The map image and its marker layer receive the same transform, so the dots stay on
// their countries. Touch devices and readers who asked for reduced motion get the static map.
(function () {
  'use strict';
  var fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)');
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!fine || !fine.matches || (calm && calm.matches)) return;

  var MAX = 5;              // px of travel; more reads as a gimmick and blurs the dots
  var map = null, frame = 0, gx = 0, gy = 0;

  function apply() {
    frame = 0;
    if (!map || !map.isConnected) { map = null; return; }
    map.style.setProperty('--gx', (gx * MAX).toFixed(2) + 'px');
    map.style.setProperty('--gy', (gy * MAX).toFixed(2) + 'px');
  }

  function reset() {
    if (!map) return;
    map.style.setProperty('--gx', '0px');
    map.style.setProperty('--gy', '0px');
    map.classList.remove('is-live');
    map = null; gx = 0; gy = 0;
  }

  // Delegated: the global board is re-rendered on every market visit, so per-element listeners would
  // have to be re-attached each time.
  document.addEventListener('pointermove', function (e) {
    var target = e.target && e.target.closest ? e.target.closest('.gb-map') : null;
    if (!target) { if (map) reset(); return; }
    var r = target.getBoundingClientRect();
    if (!r.width || !r.height) return;
    map = target;
    map.classList.add('is-live');
    gx = (0.5 - (e.clientX - r.left) / r.width) * 2;   // inverse: the map leans away from the pointer
    gy = (0.5 - (e.clientY - r.top) / r.height) * 2;
    if (!frame) frame = requestAnimationFrame(apply);
  }, { passive: true });

  document.addEventListener('pointerout', function (e) {
    if (map && e.target && map.contains(e.target) && !map.contains(e.relatedTarget)) reset();
  }, { passive: true });
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', function () { if (document.hidden) reset(); });
})();
