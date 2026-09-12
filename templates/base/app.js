/* Theme toggle, deep links into collapsed sections, and nav that opens
   the section it jumps to. No dependencies. */
(function () {
  var root = document.documentElement,
      btn = document.getElementById('tt'),
      lbl = document.getElementById('ttl');

  function current() {
    var s = root.getAttribute('data-theme');
    if (s) return s;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function sync() { if (lbl) lbl.textContent = current() === 'dark' ? 'Light' : 'Dark'; }
  sync();
  if (btn) btn.addEventListener('click', function () {
    root.setAttribute('data-theme', current() === 'dark' ? 'light' : 'dark');
    sync();
  });

  /* A link to #architecture must open that section, not scroll past a
     collapsed one. Walk up and open every ancestor details too. */
  function openFromHash() {
    var h = location.hash;
    if (!h || h.length < 2) return;
    var el = document.getElementById(h.slice(1));
    if (!el) return;
    var d = el.tagName === 'DETAILS' ? el : el.querySelector('details') || el.closest('details');
    while (d) { d.open = true; d = d.parentElement ? d.parentElement.closest('details') : null; }
    setTimeout(function () { el.scrollIntoView({ block: 'start' }); }, 60);
  }
  openFromHash();
  window.addEventListener('hashchange', openFromHash);

  document.querySelectorAll('nav.jump a').forEach(function (a) {
    a.addEventListener('click', function () {
      var t = document.querySelector(a.getAttribute('href'));
      if (!t) return;
      var d = t.querySelector('details');
      if (d) d.open = true;
    });
  });

  /* The toggle label names the next activation's effect, not the current
     state: "Expand" while closed, "Collapse" while open. `toggle` fires on
     every open/close, including ones driven by openFromHash and the nav
     jump above, so the label stays correct no matter what opened it. */
  document.querySelectorAll('details.sec').forEach(function (d) {
    var label = d.querySelector('.sec-toggle span');
    var summary = d.querySelector('summary');
    function sync() {
      if (label) label.textContent = d.open ? 'Collapse' : 'Expand';
      if (summary) summary.setAttribute('aria-expanded', d.open ? 'true' : 'false');
    }
    d.addEventListener('toggle', sync);
    sync();
  });
})();
