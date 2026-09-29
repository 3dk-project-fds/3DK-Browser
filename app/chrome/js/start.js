// 3DK Browser — Startseite: Eingabefeld verhält sich wie die Adressleiste.
const box = document.getElementById('search');
box.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && box.value.trim()) {
    window.api.openInTab(box.value.trim());
  }
});
