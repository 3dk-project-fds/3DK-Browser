// 3DK Browser — Favoriten-Seite: ansehen, öffnen, umbenennen, entfernen.
(function () {
  const $ = (id) => document.getElementById(id);
  const liste = $('liste');
  const zaehler = $('zaehler');
  let daten = [];

  function datum(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('de-DE') + ', ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function host(url) {
    try { return new URL(url).hostname; } catch { return url; }
  }

  function malen() {
    liste.textContent = '';
    if (!daten.length) {
      const leer = document.createElement('div');
      leer.className = 'leer';
      leer.innerHTML = 'Noch keine Favoriten.<br><b>Adresse aufsuchen und auf den Stern im Adressfeld klicken</b>.';
      liste.appendChild(leer);
      zaehler.textContent = 'Kein Favorit gespeichert';
      return;
    }
    zaehler.textContent = daten.length + ' ' + (daten.length === 1 ? 'Favorit' : 'Favoriten') + ' gespeichert · alphabetisch sortiert';
    for (const f of [...daten].sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
      const z = document.createElement('div');
      z.className = 'zeile';

      const st = document.createElement('span');
      st.className = 'stern';
      st.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3.6l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/></svg>';

      const kern = document.createElement('div');
      kern.className = 'kern';
      const n = document.createElement('span');
      n.className = 'name';
      n.textContent = f.name;
      n.title = f.url;
      const dm = document.createElement('span');
      dm.className = 'dom';
      dm.textContent = host(f.url);
      kern.append(n, dm);

      const dt = document.createElement('span');
      dt.className = 'datum';
      dt.textContent = datum(f.angelegt);

      const bn = document.createElement('button');
      bn.className = 'aktion';
      bn.textContent = 'Umbenennen';
      bn.addEventListener('click', () => {
        const edit = document.createElement('input');
        edit.className = 'name-edit';
        edit.value = f.name;
        edit.maxLength = 120;
        n.replaceWith(edit);
        edit.focus();
        edit.select();
        const fertig = (speichern) => {
          if (speichern && edit.value.trim() && edit.value.trim() !== f.name) {
            window.api.renameFavorite({ url: f.url, name: edit.value.trim() }).catch(() => {});
          } else {
            malen();
          }
        };
        edit.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') fertig(true);
          if (ev.key === 'Escape') fertig(false);
        });
        edit.addEventListener('blur', () => fertig(true));
      });

      const bx = document.createElement('button');
      bx.className = 'aktion';
      bx.textContent = 'Entfernen';
      bx.addEventListener('click', () => { window.api.removeFavorite(f.url).catch(() => {}); });

      z.append(st, kern, dt, bn, bx);

      // Öffnen: Klick auf die Zeile (außer auf die Knöpfe) lädt die Seite.
      z.addEventListener('click', (ev) => {
        if (ev.target.closest('.aktion') || ev.target.closest('.name-edit')) return;
        window.api.openInTab(f.url);
      });

      liste.appendChild(z);
    }
  }

  if (window.api && window.api.listFavorites) {
    window.api.listFavorites().then((l) => { daten = l || []; malen(); }).catch(() => {});
    window.api.onFavorites((l) => { daten = l || []; malen(); });
  } else {
    malen();
  }
})();
