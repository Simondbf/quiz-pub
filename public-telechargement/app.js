// Site de téléchargement : interface. Aucune bibliothèque.
const $ = (id) => document.getElementById(id);
const creer = (balise, attributs = {}, ...enfants) => {
  const el = document.createElement(balise);
  for (const [k, v] of Object.entries(attributs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'texte') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const e of enfants.flat()) if (e !== null && e !== undefined && e !== false) el.append(e instanceof Node ? e : String(e));
  return el;
};
const taille = (o) => (o >= 1e9 ? `${(o / 1e9).toFixed(1).replace('.', ',')} Go` : `${Math.max(0.1, o / 1e6).toFixed(1).replace('.', ',')} Mo`);
const duree = (s) => {
  if (!Number.isFinite(s)) return '';
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

let minuterieAnnonce = 0;
const annoncer = (texte) => {
  $('annonce').textContent = texte;
  $('annonce').hidden = false;
  clearTimeout(minuterieAnnonce);
  minuterieAnnonce = setTimeout(() => { $('annonce').hidden = true; }, 4000);
};

class ErreurApi extends Error {}
const api = async (chemin, { methode = 'GET', corps } = {}) => {
  const r = await fetch(chemin, {
    method: methode,
    headers: corps !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  if (r.status === 401 && !chemin.endsWith('/connexion')) { montrer('vue-connexion'); throw new ErreurApi('Connexion requise.'); }
  if (r.status === 204) return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErreurApi(d.erreur || `Erreur ${r.status}`);
  return d;
};
const montrer = (vue) => { ['vue-connexion', 'vue-principale'].forEach((v) => { $(v).hidden = v !== vue; }); };

/* ------------------------------ Connexion ------------------------------ */

$('form-connexion').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('connexion-erreur').textContent = '';
  try {
    await api('/api/connexion', { methode: 'POST', corps: { motDePasse: $('mdp').value } });
    $('mdp').value = '';
    demarrer();
  } catch (err) { $('connexion-erreur').textContent = err.message; }
});
$('deconnexion').addEventListener('click', async () => {
  await api('/api/deconnexion', { methode: 'POST' }).catch(() => {});
  montrer('vue-connexion');
});

/* ------------------------------ Liste ------------------------------ */

let systeme = { quiz: false };
let minuterieSuivi = 0;

const afficher = (liste) => {
  $('vide').hidden = liste.length > 0;
  $('liste').replaceChildren(...liste.map((t) => {
    const type = t.mode === 'musique' ? 'Musique MP3' : 'Vidéo MP4';
    const li = creer('li', { class: `element${t.etat === 'erreur' ? ' erreur-element' : ''}`, 'data-id': t.id, 'data-etat': t.etat });
    li.append(creer('div', { class: 'titre', texte: t.titre || t.url }));
    if (t.etat === 'pret') {
      li.append(creer('div', { class: 'infos', texte: [type, duree(t.duree), taille(t.taille)].filter(Boolean).join(', ') }));
      const actions = creer('div', { class: 'actions' },
        creer('a', { class: 'bouton petit principal', href: `/fichiers/${t.id}`, download: t.nom, texte: 'Enregistrer' }));
      if (systeme.quiz && t.mode === 'video') {
        actions.append(creer('button', { class: 'bouton petit', type: 'button', texte: t.quiz ? 'Renvoyer au quiz' : 'Envoyer au quiz', onclick: (e) => envoyerAuQuiz(t, e.currentTarget) }));
      }
      actions.append(creer('button', { class: 'bouton petit danger', type: 'button', texte: 'Supprimer', onclick: () => supprimer(t) }));
      li.append(actions);
      if (t.quiz) li.append(creer('div', { class: 'envoye', texte: 'Envoyée au quiz.' }));
    } else if (t.etat === 'erreur') {
      li.append(creer('div', { class: 'infos', texte: type }), creer('div', { class: 'message erreur', texte: t.message }),
        creer('div', { class: 'actions' },
          creer('button', { class: 'bouton petit', type: 'button', texte: 'Réessayer', onclick: () => lancer(t.url, t.mode).then(() => api(`/api/telechargements/${t.id}`, { methode: 'DELETE' })).then(charger).catch((err) => annoncer(err.message)) }),
          creer('button', { class: 'bouton petit danger', type: 'button', texte: 'Supprimer', onclick: () => supprimer(t) })));
    } else {
      const p = t.tache?.progres ?? 0;
      li.append(creer('div', { class: 'infos', texte: `${type} : ${t.etat === 'attente' ? 'en attente…' : `${t.tache?.message || 'téléchargement'} (${Math.round(p * 100)} %)`}` }),
        creer('div', { class: 'barre' }, creer('div', { style: `width:${Math.round(p * 100)}%` })),
        creer('div', { class: 'actions' }, creer('button', { class: 'bouton petit', type: 'button', texte: 'Annuler', onclick: () => supprimer(t, false) })));
    }
    return li;
  }));
};

const charger = async () => {
  clearTimeout(minuterieSuivi);
  const liste = await api('/api/telechargements');
  afficher(liste);
  if (liste.some((t) => t.etat === 'attente' || t.etat === 'telechargement')) minuterieSuivi = setTimeout(() => charger().catch(() => {}), 1200);
};

const supprimer = async (t, demander = true) => {
  if (demander && !confirm(`Supprimer « ${t.titre || t.url} » du serveur ?`)) return;
  try { await api(`/api/telechargements/${t.id}`, { methode: 'DELETE' }); } catch (err) { annoncer(err.message); }
  charger().catch(() => {});
};

const envoyerAuQuiz = async (t, bouton) => {
  bouton.disabled = true;
  bouton.textContent = 'Envoi au quiz…';
  try {
    await api(`/api/telechargements/${t.id}/quiz`, { methode: 'POST' });
    annoncer('Vidéo envoyée au quiz : elle s\'analyse là-bas.');
  } catch (err) { annoncer(err.message); }
  charger().catch(() => {});
};

/* ------------------------------ Nouveau téléchargement ------------------------------ */

const lancer = (url, mode) => api('/api/telechargements', { methode: 'POST', corps: { url, mode } });

$('form-lien').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('lien-erreur').textContent = '';
  $('lancer').disabled = true;
  try {
    await lancer($('lien').value.trim(), document.querySelector('input[name=mode]:checked').value);
    $('lien').value = '';
    await charger();
  } catch (err) { $('lien-erreur').textContent = err.message; }
  $('lancer').disabled = false;
});

// Sur téléphone : coller le lien d'un seul geste.
if (navigator.clipboard?.readText) {
  $('coller').hidden = false;
  $('coller').addEventListener('click', async () => {
    try {
      const texte = (await navigator.clipboard.readText()).trim();
      if (texte) $('lien').value = texte;
    } catch { annoncer('Le navigateur refuse l\'accès au presse-papiers : colle le lien à la main.'); }
  });
}

/* ------------------------------ yt-dlp ------------------------------ */

const afficherSysteme = () => {
  $('version').textContent = `yt-dlp ${systeme.ytdlp || 'introuvable'}${systeme.cookies ? ', cookies YouTube fournis' : ''}.`;
  $('conservation').textContent = `Les fichiers restent ${systeme.conservationJours} jours sur le serveur, puis sont effacés.`;
};
$('maj').addEventListener('click', async () => {
  $('maj').disabled = true;
  $('maj-message').textContent = 'Mise à jour de yt-dlp…';
  try {
    const t = await api('/api/systeme/maj-ytdlp', { methode: 'POST' });
    let etat = t;
    while (etat.etat === 'attente' || etat.etat === 'en-cours') {
      await new Promise((r) => setTimeout(r, 1000));
      etat = await api(`/api/taches/${t.id}`);
    }
    $('maj-message').textContent = etat.etat === 'finie' ? (etat.resultat?.message || 'yt-dlp est à jour.') : (etat.erreur || 'Mise à jour impossible.');
    systeme = await api('/api/systeme');
    afficherSysteme();
  } catch (err) { $('maj-message').textContent = err.message; }
  $('maj').disabled = false;
});

/* ------------------------------ Démarrage ------------------------------ */

const demarrer = async () => {
  let session;
  try { session = await api('/api/session'); } catch { return; }
  $('deconnexion').hidden = session.motDePasse === false;
  if (!session.connecte) return montrer('vue-connexion');
  montrer('vue-principale');
  try {
    systeme = await api('/api/systeme');
    afficherSysteme();
    await charger();
  } catch (err) { if (err.message !== 'Connexion requise.') annoncer(err.message); }
};
demarrer();
