// Liest das Theme aus den Einstellungen (Main-Prozess) und wendet es an.
// Erwartet window.api.getSettings() / onSettings() (beide Preloads).
(function () {
  function apply(s) {
    if (s && s.theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
  function init() {
    const api = (window.api && window.api.getSettings) ? window.api : null;
    if (!api) return;
    api.getSettings().then(apply);
    if (api.onSettings) api.onSettings(apply);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
