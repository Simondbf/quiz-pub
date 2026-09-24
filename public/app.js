// Quiz Pub : interface. Aucune bibliothèque ; l'ordre des propositions de
// réponse vient de choix.js, partagé avec le serveur.
import { choixPub, MAX_FAUSSES } from './choix.js';

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

/* ------------------------------ Outils ------------------------------ */

const fmt = (t) => {
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
};
const fmtDuree = (t) => {
  if (!Number.isFinite(t)) return '';
  const s = Math.round(t);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min ${String(r).padStart(2, '0')} s`;
};
const fmtSec = (t) => `${(Math.round(t * 10) / 10).toLocaleString('fr-BE')} s`;
const fmtTaille = (o) => (o >= 1024 ** 3 ? `${(o / 1024 ** 3).toLocaleString('fr-BE', { maximumFractionDigits: 1 })} Go` : `${Math.max(1, Math.round(o / 1024 ** 2))} Mo`);
const idAleatoire = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

class ErreurApi extends Error {}
const api = async (chemin, { methode = 'GET', corps } = {}) => {
  const options = { method: methode, credentials: 'same-origin', headers: {} };
  if (corps !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(corps); }
  let r;
  try { r = await fetch(chemin, options); } catch { throw new ErreurApi('Le serveur ne répond pas.'); }
  if (r.status === 401 && !chemin.endsWith('/connexion')) { montrerConnexion(); throw new ErreurApi('Connexion requise.'); }
  if (r.status === 204) return null;
  const donnees = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErreurApi(donnees.erreur || `Erreur ${r.status}`);
  return donnees;
};

const vues = ['vue-connexion', 'vue-biblio', 'vue-montage'];
const montrer = (id) => vues.forEach((v) => { $(v).hidden = v !== id; });

/* ------------------------------ Connexion ------------------------------ */

const montrerConnexion = () => {
  arreterSondages();
  montrer('vue-connexion');
  $('mdp').value = '';
  setTimeout(() => $('mdp').focus(), 0);
};

$('form-connexion').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('connexion-erreur').textContent = '';
  try {
    await api('/api/connexion', { methode: 'POST', corps: { motDePasse: $('mdp').value } });
    router();
  } catch (err) {
    $('connexion-erreur').textContent = err.message;
  }
});

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-action="deconnexion"]')) {
    await api('/api/deconnexion', { methode: 'POST' }).catch(() => {});
    montrerConnexion();
  }
});

/* ------------------------------ Sondages ------------------------------ */

const minuteries = { biblio: 0, montage: 0 };
const arreterSondages = () => { clearTimeout(minuteries.biblio); clearTimeout(minuteries.montage); };

/* ------------------------------ Bibliothèque ------------------------------ */

const ETATS = { nouvelle: 'En attente', attente: 'En attente', telechargement: 'Téléchargement', analyse: 'Analyse', prete: 'Prête', erreur: 'Erreur' };

const afficherBiblio = async () => {
  montrer('vue-biblio');
  document.title = 'Quiz Pub';
  await chargerVideos();
  chargerSysteme();
};

const chargerVideos = async () => {
  clearTimeout(minuteries.biblio);
  let videos;
  try { videos = await api('/api/videos'); } catch (e) { $('ajout-message').textContent = e.message; return; }
  const liste = $('liste-videos');
  liste.replaceChildren(...videos.map(elementVideo));
  $('liste-vide').hidden = videos.length > 0;
  const actif = videos.some((v) => v.tache || ['nouvelle', 'attente', 'telechargement', 'analyse'].includes(v.etat));
  if (actif && !$('vue-biblio').hidden) minuteries.biblio = setTimeout(chargerVideos, 1500);
};

const elementVideo = (v) => {
  const prete = v.etat === 'prete';
  const nom = prete ? creer('a', { class: 'nom', href: `#/video/${v.id}`, texte: v.titre || 'Sans titre' }) : creer('span', { class: 'nom', texte: v.titre || 'Sans titre' });
  const etat = creer('div', { class: 'etat' }, creer('span', { class: `pastille ${v.etat}`, texte: ETATS[v.etat] || v.etat }));
  if (v.tache) {
    const barre = creer('div', { class: 'barre-progres' }, creer('div', { style: `width:${Math.round(v.tache.progres * 100)}%` }));
    etat.append(barre, creer('span', { texte: `${Math.round(v.tache.progres * 100)} %` }));
  } else if (v.etat === 'erreur' && v.message) {
    etat.append(creer('span', { class: 'erreur', texte: v.message }));
  } else if (prete) {
    etat.append(creer('span', { texte: [fmtDuree(v.duree), v.taille ? fmtTaille(v.taille) : ''].filter(Boolean).join(', ') }));
  }
  const actions = creer('div', { class: 'actions' });
  if (prete) actions.append(creer('a', { class: 'bouton petit', href: `#/video/${v.id}`, texte: 'Ouvrir' }));
  actions.append(creer('button', {
    class: 'bouton petit danger', type: 'button', texte: 'Supprimer',
    onclick: async () => {
      if (!confirm(`Supprimer « ${v.titre || 'cette vidéo'} » et tous ses exports ?`)) return;
      try { await api(`/api/videos/${v.id}`, { methode: 'DELETE' }); } catch (e) { alert(e.message); }
      chargerVideos();
    },
  }));
  return creer('li', { 'data-video': v.id }, creer('div', { class: 'infos' }, nom, etat), actions);
};

$('form-lien').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('lien').value.trim();
  $('ajout-message').className = 'message';
  try {
    await api('/api/videos/youtube', { methode: 'POST', corps: { url } });
    $('lien').value = '';
    $('ajout-message').textContent = 'Téléchargement lancé. L\'analyse suivra toute seule.';
    $('ajout-message').classList.add('ok');
    chargerVideos();
  } catch (err) {
    $('ajout-message').textContent = err.message;
    $('ajout-message').classList.add('erreur');
  }
});

$('fichier').addEventListener('change', () => {
  const f = $('fichier').files[0];
  if (!f) return;
  const xhr = new XMLHttpRequest();
  $('envoi').hidden = false;
  $('ajout-message').textContent = '';
  const barre = $('envoi').querySelector('.barre-progres div');
  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    barre.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    $('envoi-texte').textContent = `Envoi de « ${f.name} » : ${Math.round((e.loaded / e.total) * 100)} %`;
  });
  xhr.addEventListener('loadend', () => {
    $('envoi').hidden = true;
    $('fichier').value = '';
    let reponse = {};
    try { reponse = JSON.parse(xhr.responseText); } catch { /* réponse vide */ }
    if (xhr.status === 401) return montrerConnexion();
    $('ajout-message').className = `message ${xhr.status === 201 ? 'ok' : 'erreur'}`;
    $('ajout-message').textContent = xhr.status === 201 ? 'Vidéo envoyée. Analyse en cours.' : (reponse.erreur || 'Envoi interrompu.');
    chargerVideos();
  });
  xhr.open('PUT', `/api/videos/televersement?nom=${encodeURIComponent(f.name)}`);
  xhr.send(f);
});

const chargerSysteme = async () => {
  try {
    const s = await api('/api/systeme');
    $('versions').textContent = `yt-dlp ${s.ytdlp || 'introuvable'}, ffmpeg ${s.ffmpeg || 'introuvable'}${s.cookies ? ', cookies YouTube fournis' : ''}`;
  } catch { /* affichage facultatif */ }
};

$('maj-ytdlp').addEventListener('click', async () => {
  $('maj-message').textContent = 'Mise à jour en cours…';
  try {
    const t = await api('/api/systeme/maj-ytdlp', { methode: 'POST' });
    const suivre = async () => {
      const toutes = await api('/api/taches');
      const moi = toutes.find((x) => x.id === t.id);
      if (!moi || !moi.finie) return setTimeout(suivre, 1000);
      $('maj-message').textContent = moi.etat === 'finie' ? (moi.resultat?.message || 'yt-dlp est à jour.') : moi.erreur;
      chargerSysteme();
    };
    suivre();
  } catch (e) { $('maj-message').textContent = e.message; }
});

/* ------------------------------ Montage ------------------------------ */

const m = {
  id: null, donnees: null, projet: null, info: null, coupes: [], cadenceChoisie: false,
  choisie: null, masqueChoisi: null, dessin: false,
  version: 0, versionEnregistree: 0, minuterieSauvegarde: 0, enregistrement: null,
};
const video = $('video');
const fps = () => m.info?.fps || 25;
const image = () => 1 / fps();

const ouvrirVideo = async (id) => {
  arreterSondages();
  if (m.id !== id) {
    await enregistrerMaintenant();
    Object.assign(m, { id, donnees: null, projet: null, info: null, coupes: [], choisie: null, masqueChoisi: null, dessin: false, version: 0, versionEnregistree: 0 });
    video.removeAttribute('src');
    video.load();
  }
  montrer('vue-montage');
  await rafraichirVideo(true);
};

// charger : recharge aussi le projet (à l'ouverture, ou après une analyse).
const rafraichirVideo = async (charger = false) => {
  clearTimeout(minuteries.montage);
  const id = m.id;
  let d;
  try { d = await api(`/api/videos/${id}`); } catch (e) {
    $('titre-video').textContent = e.message;
    return;
  }
  if (m.id !== id) return;
  const etaitPrete = m.donnees?.etat === 'prete';
  m.donnees = d;
  $('titre-video').textContent = d.titre || 'Sans titre';
  document.title = `${d.titre || 'Vidéo'} · Quiz Pub`;
  const prete = d.etat === 'prete' && d.projet;
  if (!prete) {
    montrerAttente(d);
  } else {
    $('montage-attente').hidden = true;
    $('montage').hidden = false;
    if (charger || !etaitPrete || !m.projet) chargerProjet(d);
    afficherExports();
  }
  const actif = d.tache || (d.taches || []).some((t) => !t.finie);
  if (actif && !$('vue-montage').hidden) minuteries.montage = setTimeout(() => rafraichirVideo(false), 1500);
};

const montrerAttente = (d) => {
  $('montage').hidden = true;
  $('montage-attente').hidden = false;
  const t = d.tache;
  $('attente-texte').textContent = t
    ? `${t.libelle} : ${t.message || 'en cours'} (${Math.round(t.progres * 100)} %)`
    : d.etat === 'erreur' ? d.message || 'Une erreur est survenue.' : 'En attente…';
  $('attente-texte').classList.toggle('erreur', d.etat === 'erreur' && !t);
  $('attente-barre').hidden = !t;
  if (t) $('attente-barre').firstElementChild.style.width = `${Math.round(t.progres * 100)}%`;
  const actions = $('attente-actions');
  actions.replaceChildren();
  if (d.etat === 'erreur' && d.fichierPresent && !t) {
    actions.append(creer('button', { class: 'bouton principal', type: 'button', texte: 'Relancer l\'analyse', onclick: relancerAnalyse }));
  }
  actions.append(creer('a', { class: 'bouton', href: '#/', texte: 'Retour aux vidéos' }));
};

const chargerProjet = (d) => {
  m.projet = structuredClone(d.projet);
  m.info = d.info;
  m.coupes = d.coupes || [];
  m.version = 0;
  m.versionEnregistree = 0;
  if (!m.projet.pubs.some((p) => p.id === m.choisie)) m.choisie = m.projet.pubs[0]?.id || null;
  const src = `/media/${m.id}/source`;
  if (!video.src.endsWith(src)) video.src = src;
  $('ecran').style.aspectRatio = `${m.info.largeur} / ${m.info.hauteur}`;
  // Réglages du quiz
  $('question').value = m.projet.reglages.question;
  $('duree-question').value = m.projet.reglages.dureeQuestion;
  $('afficher-reponse').checked = m.projet.reglages.reponse;
  remplirCadences(d.cadenceConseillee);
  $('sauvegarde').textContent = '';
  toutAfficher();
};

const toutAfficher = () => {
  afficherPubs();
  afficherMasques();
  afficherResumeQuiz();
  dessinerFrise();
  majTemps();
};

/* --------------------------- Enregistrement --------------------------- */

const modifie = () => {
  m.version++;
  $('sauvegarde').textContent = 'Modifications non enregistrées';
  clearTimeout(m.minuterieSauvegarde);
  m.minuterieSauvegarde = setTimeout(enregistrerMaintenant, 700);
};

const enregistrerMaintenant = async () => {
  clearTimeout(m.minuterieSauvegarde);
  if (!m.projet || m.version === m.versionEnregistree) return;
  if (m.enregistrement) { await m.enregistrement; return enregistrerMaintenant(); }
  const version = m.version;
  const id = m.id;
  $('sauvegarde').textContent = 'Enregistrement…';
  m.enregistrement = api(`/api/videos/${id}/projet`, { methode: 'PUT', corps: m.projet })
    .then(() => {
      if (m.id !== id) return;
      m.versionEnregistree = version;
      $('sauvegarde').textContent = m.version === version ? 'Modifications enregistrées' : 'Enregistrement…';
    })
    .catch((e) => { if (m.id === id) $('sauvegarde').textContent = `Échec de l'enregistrement : ${e.message}`; })
    .finally(() => { m.enregistrement = null; });
  await m.enregistrement;
  if (m.version !== m.versionEnregistree && m.id === id) m.minuterieSauvegarde = setTimeout(enregistrerMaintenant, 300);
};
// Onglet fermé juste après une modification : dernier envoi, même si la page s'en va.
window.addEventListener('pagehide', () => {
  if (!m.projet || m.version === m.versionEnregistree) return;
  fetch(`/api/videos/${m.id}/projet`, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m.projet) }).catch(() => {});
});

/* ------------------------------ Pubs ------------------------------ */

const pubs = () => m.projet?.pubs || [];
const pubChoisie = () => pubs().find((p) => p.id === m.choisie) || null;
const pubA = (t) => pubs().find((p) => t >= p.debut - 1e-6 && t < p.fin - 1e-6) || null;
const numero = (p) => pubs().indexOf(p) + 1;

// Même règle que le serveur : le début du dernier plan de la seconde moitié.
const estimerRevelation = (debut, fin) => {
  const longueur = fin - debut;
  const dedans = m.coupes.filter((c) => c > debut + 0.5 && c < fin - 1.0 && c >= debut + longueur * 0.4);
  return dedans.length ? { t: dedans[dedans.length - 1], source: 'coupe' } : { t: fin - Math.min(4, longueur * 0.25), source: 'estimee' };
};
const caler = (t) => Math.round(Math.round(t * fps()) / fps() * 1000) / 1000;

const choisirPub = (id, aller = false) => {
  m.choisie = id;
  const p = pubChoisie();
  if (p && aller) allerA(p.debut);
  afficherPubs();
  dessinerFrise();
};

const placerRepere = (p, quoi, t) => {
  const e = image();
  const duree = m.info.duree;
  t = caler(t);
  if (quoi === 'debut') p.debut = Math.min(Math.max(0, t), p.revelation - e);
  if (quoi === 'revelation') { p.revelation = Math.min(Math.max(p.debut + e, t), p.fin - e); p.source = 'manuel'; }
  if (quoi === 'fin') p.fin = Math.max(Math.min(duree, t), p.revelation + e);
  m.projet.pubs.sort((a, b) => a.debut - b.debut);
  modifie();
  afficherPubs();
  dessinerFrise();
  afficherResumeQuiz();
};

const couperAu = (t) => {
  t = caler(t);
  const p = pubA(t);
  if (!p) {
    // Hors de toute pub : on en crée une jusqu'à la suivante (15 s au plus).
    const suivante = pubs().find((x) => x.debut > t);
    const fin = Math.min(m.info.duree, suivante ? suivante.debut : m.info.duree, t + 15);
    if (fin - t < 1) return annoncer('Pas assez de place pour une nouvelle pub ici.');
    const r = estimerRevelation(t, fin);
    const nouvelle = { id: idAleatoire(), debut: t, revelation: caler(r.t), fin: caler(fin), source: r.source, reponse: '', propositions: [], inclure: true };
    m.projet.pubs.push(nouvelle);
    m.projet.pubs.sort((a, b) => a.debut - b.debut);
    m.choisie = nouvelle.id;
  } else {
    if (t - p.debut < 0.5 || p.fin - t < 0.5) return annoncer('Trop près du début ou de la fin de la pub pour la couper ici.');
    const suite = { id: idAleatoire(), debut: t, revelation: 0, fin: p.fin, source: 'estimee', reponse: '', propositions: [], inclure: p.inclure };
    if (p.revelation > t + image()) { suite.revelation = p.revelation; suite.source = p.source; }
    else { const r = estimerRevelation(t, p.fin); suite.revelation = caler(r.t); suite.source = r.source; }
    p.fin = t;
    if (p.revelation >= t - image()) { const r = estimerRevelation(p.debut, t); p.revelation = caler(r.t); p.source = r.source; }
    m.projet.pubs.splice(m.projet.pubs.indexOf(p) + 1, 0, suite);
    // Les masques de la pub coupée valent aussi pour sa seconde partie.
    for (const mq of m.projet.masques) if (mq.pubs.includes(p.id)) mq.pubs.push(suite.id);
    m.choisie = suite.id;
  }
  modifie();
  toutAfficher();
};

const fusionnerAvecSuivante = (p) => {
  const i = pubs().indexOf(p);
  const b = pubs()[i + 1];
  if (!b) return;
  p.fin = b.fin;
  p.revelation = b.revelation;
  p.source = b.source;
  if (!String(p.reponse || '').trim()) { p.reponse = b.reponse; p.propositions = b.propositions || []; }
  m.projet.pubs.splice(i + 1, 1);
  for (const mq of m.projet.masques) {
    if (mq.pubs.includes(b.id)) mq.pubs = [...new Set([...mq.pubs.filter((x) => x !== b.id), p.id])];
  }
  modifie();
  toutAfficher();
};

const supprimerPub = (p) => {
  const i = pubs().indexOf(p);
  m.projet.pubs.splice(i, 1);
  for (const mq of m.projet.masques) mq.pubs = mq.pubs.filter((x) => x !== p.id);
  m.choisie = pubs()[Math.min(i, pubs().length - 1)]?.id || null;
  modifie();
  toutAfficher();
};

const COULEURS_REPERES = { debut: 'var(--bleu)', revelation: 'var(--rouge)', fin: 'var(--jaune)' };
const NOMS_REPERES = { debut: 'Début', revelation: 'Révélation', fin: 'Fin' };

const resumePub = (p) => `${fmt(p.debut)} à ${fmt(p.fin)}, ${fmtSec(p.fin - p.debut)}${p.reponse ? `, ${p.reponse}` : ''}${choixPub(p) ? `, ${choixPub(p).choix.length} choix` : ''}`;

const afficherPubs = () => {
  const liste = $('liste-pubs');
  liste.replaceChildren(...pubs().map((p, i) => {
    const choisie = p.id === m.choisie;
    const li = creer('li', { class: `pub${choisie ? ' choisie' : ''}${p.inclure ? '' : ' exclue'}`, 'data-pub': p.id });
    li.append(creer('button', {
      class: 'entete', type: 'button', 'aria-expanded': String(choisie),
      onclick: () => choisirPub(p.id, true),
    },
    creer('span', { class: 'numero', texte: `Pub ${i + 1}` }),
    creer('span', { class: 'resume-pub', texte: resumePub(p) }),
    p.source === 'estimee' ? creer('span', { class: 'a-verifier', texte: 'à vérifier' }) : null));
    if (!choisie) return li;
    const detail = creer('div', { class: 'detail' });
    for (const quoi of ['debut', 'revelation', 'fin']) {
      detail.append(creer('div', { class: 'repere', 'data-repere': quoi },
        creer('span', { class: 'nom-repere' }, creer('i', { style: `background:${COULEURS_REPERES[quoi]}` }), NOMS_REPERES[quoi]),
        creer('button', { class: 'bouton petit valeur', type: 'button', title: 'Aller à ce moment', texte: fmt(p[quoi]), onclick: () => allerA(quoi === 'fin' ? p.fin - image() : p[quoi]) }),
        creer('span', { class: 'actions', style: 'margin:0;gap:4px;flex-wrap:nowrap' },
          creer('button', { class: 'bouton petit', type: 'button', title: 'Une image plus tôt', 'aria-label': `${NOMS_REPERES[quoi]} une image plus tôt`, texte: '−', onclick: () => placerRepere(p, quoi, p[quoi] - image()) }),
          creer('button', { class: 'bouton petit', type: 'button', title: 'Une image plus tard', 'aria-label': `${NOMS_REPERES[quoi]} une image plus tard`, texte: '+', onclick: () => placerRepere(p, quoi, p[quoi] + image()) })),
        creer('button', { class: 'bouton petit', type: 'button', 'data-caler': quoi, title: `Touche ${quoi === 'debut' ? 'D' : quoi === 'revelation' ? 'R' : 'F'}`, texte: 'Au curseur', onclick: () => placerRepere(p, quoi, video.currentTime) }),
      ));
    }
    const reponse = creer('input', { type: 'text', maxlength: '120', value: p.reponse || '', placeholder: 'Par exemple : Côte d\'Or', 'data-champ': 'reponse' });
    reponse.addEventListener('input', () => { p.reponse = reponse.value; modifie(); afficherResumeQuiz(); majAideChoix(); });
    // Mise à jour de l'en-tête seulement : refaire toute la liste en quittant
    // le champ volerait le clic fait dans le champ suivant.
    const majResume = () => { li.querySelector('.resume-pub').textContent = resumePub(p); };
    reponse.addEventListener('change', majResume);
    detail.append(creer('label', { class: 'champ' }, creer('span', { texte: 'Réponse (la marque)' }), reponse));
    // Fausses propositions, montrées avec la bonne pendant l'image figée.
    if (!Array.isArray(p.propositions)) p.propositions = [];
    const aide = creer('p', { class: 'discret aide-choix', 'aria-live': 'polite' });
    const majAideChoix = () => {
      const c = choixPub(p);
      const remplies = p.propositions.some((x) => String(x || '').trim());
      aide.textContent = c
        ? `À l'écran : ${c.choix.length} propositions, la bonne réponse en ${c.lettre}.`
        : remplies ? 'Écris aussi la bonne réponse : sans elle, les propositions ne s\'affichent pas.'
          : 'Facultatif. Sans proposition, le quiz pose seulement la question.';
    };
    const exemples = ['Une marque crédible', 'Une autre, crédible ou pas', 'Une absurde, pour rire'];
    const champs = creer('div', { class: 'propositions' });
    for (let k = 0; k < MAX_FAUSSES; k++) {
      const champ = creer('input', { type: 'text', maxlength: '60', value: p.propositions[k] || '', placeholder: exemples[k], 'data-champ': `proposition-${k}`, 'aria-label': `Fausse proposition ${k + 1}` });
      champ.addEventListener('input', () => {
        while (p.propositions.length <= k) p.propositions.push('');
        p.propositions[k] = champ.value;
        modifie(); afficherResumeQuiz(); majAideChoix();
      });
      champ.addEventListener('change', majResume);
      champs.append(champ);
    }
    majAideChoix();
    detail.append(creer('div', { class: 'champ' }, creer('span', { texte: 'Fausses propositions' }), champs, aide));
    const inclure = creer('input', { type: 'checkbox', checked: p.inclure });
    inclure.addEventListener('change', () => { p.inclure = inclure.checked; modifie(); afficherPubs(); dessinerFrise(); afficherResumeQuiz(); });
    detail.append(creer('label', { class: 'case' }, inclure, 'Dans le quiz'));
    const i2 = pubs().indexOf(p);
    detail.append(creer('div', { class: 'actions' },
      creer('button', { class: 'bouton petit', type: 'button', texte: 'Voir la révélation', onclick: () => { allerA(Math.max(p.debut, p.revelation - 3)); video.play(); } }),
      creer('button', { class: 'bouton petit', type: 'button', texte: 'Couper au curseur', title: 'Touche C', onclick: () => couperAu(video.currentTime) }),
      i2 < pubs().length - 1 ? creer('button', { class: 'bouton petit', type: 'button', texte: 'Fusionner avec la suivante', onclick: () => fusionnerAvecSuivante(p) }) : null,
      creer('button', { class: 'bouton petit danger', type: 'button', texte: 'Supprimer', onclick: () => supprimerPub(p) }),
    ));
    li.append(detail);
    return li;
  }));
  const generales = $('actions-generales');
  generales.replaceChildren(
    creer('button', { class: 'bouton petit', type: 'button', id: 'bouton-couper', texte: libelleCouper(), onclick: () => couperAu(video.currentTime) }),
    creer('button', { class: 'bouton petit', type: 'button', texte: 'Refaire l\'analyse', onclick: relancerAnalyse }),
  );
};

const relancerAnalyse = async () => {
  if (m.projet && !confirm('Refaire l\'analyse remplace le découpage en pubs et les masques trouvés automatiquement. Les masques dessinés pour toute la vidéo sont gardés. Continuer ?')) return;
  await enregistrerMaintenant();
  try {
    await api(`/api/videos/${m.id}/analyser`, { methode: 'POST' });
    m.projet = null;
    rafraichirVideo(true);
  } catch (e) { annoncer(e.message); }
};

/* ------------------------------ Lecteur ------------------------------ */

const allerA = (t) => {
  if (!m.info) return;
  video.currentTime = Math.min(Math.max(0, t), Math.max(0, m.info.duree - image() / 2));
  majTemps();
};

// Le bouton change de rôle selon que le curseur est dans une pub ou entre deux.
const libelleCouper = () => (pubA(video.currentTime) ? 'Couper la pub au curseur' : 'Nouvelle pub au curseur');

const majTemps = () => {
  $('temps').textContent = fmt(video.currentTime || 0);
  const couper = $('bouton-couper');
  if (couper && m.projet) {
    const libelle = libelleCouper();
    if (couper.textContent !== libelle) couper.textContent = libelle;
  }
  $('bouton-lecture').textContent = video.paused ? 'Lire' : 'Pause';
  dessinerFrise();
  majCalque();
};
video.addEventListener('timeupdate', majTemps);
video.addEventListener('seeked', majTemps);
video.addEventListener('play', () => { majTemps(); boucleLecture(); });
video.addEventListener('pause', majTemps);
video.addEventListener('loadedmetadata', majTemps);
let imageBoucle = 0;
const boucleLecture = () => {
  cancelAnimationFrame(imageBoucle);
  const pas = () => {
    majTemps();
    if (!video.paused) imageBoucle = requestAnimationFrame(pas);
  };
  imageBoucle = requestAnimationFrame(pas);
};

const reperes = () => {
  const r = new Set(m.coupes.map((c) => Math.round(c * 1000) / 1000));
  for (const p of pubs()) { r.add(p.debut); r.add(p.revelation); r.add(p.fin); }
  return [...r].sort((a, b) => a - b);
};
const coupeVoisine = (sens) => {
  const t = video.currentTime;
  const liste = reperes();
  const cible = sens > 0 ? liste.find((x) => x > t + image() / 2) : [...liste].reverse().find((x) => x < t - image() / 2);
  if (cible !== undefined) { video.pause(); allerA(cible); }
};

const actionsTransport = {
  lecture: () => (video.paused ? video.play() : video.pause()),
  'image-prec': () => { video.pause(); allerA(video.currentTime - image()); },
  'image-suiv': () => { video.pause(); allerA(video.currentTime + image()); },
  'coupe-prec': () => coupeVoisine(-1),
  'coupe-suiv': () => coupeVoisine(1),
};
document.querySelectorAll('.transport [data-action]').forEach((b) => b.addEventListener('click', () => actionsTransport[b.dataset.action]()));

document.addEventListener('keydown', (e) => {
  if ($('montage').hidden || $('vue-montage').hidden || !m.projet) return;
  if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const p = pubChoisie() || pubA(video.currentTime);
  const touche = e.key;
  if (touche === ' ') { e.preventDefault(); actionsTransport.lecture(); }
  else if (touche === 'ArrowLeft' || touche === 'ArrowRight') {
    e.preventDefault();
    video.pause();
    allerA(video.currentTime + (touche === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : image()));
  } else if (touche === 'ArrowUp' || touche === 'ArrowDown') { e.preventDefault(); coupeVoisine(touche === 'ArrowUp' ? -1 : 1); }
  else if (p && /^[drf]$/i.test(touche)) {
    e.preventDefault();
    m.choisie = p.id;
    placerRepere(p, { d: 'debut', r: 'revelation', f: 'fin' }[touche.toLowerCase()], video.currentTime);
  } else if (/^c$/i.test(touche)) { e.preventDefault(); couperAu(video.currentTime); }
  else if ((touche === 'Delete' || touche === 'Backspace') && m.masqueChoisi && !$('p-masques').hidden) {
    e.preventDefault();
    supprimerMasque(m.masqueChoisi);
  }
});

/* ------------------------------ Frise ------------------------------ */

const couleur = (nom) => getComputedStyle(document.documentElement).getPropertyValue(nom).trim();

const dessinerFrise = () => {
  const c = $('frise');
  if (!m.info || $('montage').hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const l = c.clientWidth, h = c.clientHeight;
  if (!l) return;
  if (c.width !== Math.round(l * dpr)) c.width = Math.round(l * dpr);
  if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, l, h);
  const D = m.info.duree;
  const x = (t) => (t / D) * l;
  const haut = 8, bas = h - 16;
  pubs().forEach((p, i) => {
    g.fillStyle = couleur(i % 2 ? '--bande-b' : '--bande-a');
    g.globalAlpha = p.inclure ? 1 : 0.35;
    g.fillRect(x(p.debut), haut, Math.max(1, x(p.fin) - x(p.debut)), bas - haut);
    g.globalAlpha = 1;
    if (p.id === m.choisie) {
      g.strokeStyle = couleur('--accent');
      g.lineWidth = 2;
      g.strokeRect(x(p.debut) + 1, haut + 1, Math.max(1, x(p.fin) - x(p.debut)) - 2, bas - haut - 2);
    }
    g.fillStyle = couleur('--bleu');
    g.fillRect(x(p.debut), haut, 2, bas - haut);
    g.fillStyle = couleur('--rouge');
    g.fillRect(x(p.revelation) - 1, haut, 3, bas - haut);
    if (x(p.fin) - x(p.debut) > 26) {
      g.fillStyle = couleur('--texte');
      g.font = '600 11px system-ui, sans-serif';
      g.fillText(String(i + 1), x(p.debut) + 5, haut + 14);
    }
  });
  g.fillStyle = couleur('--gris');
  for (const t of m.coupes) g.fillRect(x(t), h - 12, 1, 8);
  g.fillStyle = couleur('--accent');
  const tc = video.currentTime || 0;
  g.fillRect(x(tc) - 1, 0, 2, h);
  g.beginPath(); g.moveTo(x(tc) - 5, 0); g.lineTo(x(tc) + 5, 0); g.lineTo(x(tc), 6); g.closePath(); g.fill();
};

const friseVersTemps = (e) => {
  const r = $('frise').getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (m.info?.duree || 0);
};
let glisseFrise = false;
$('frise').addEventListener('pointerdown', (e) => {
  if (!m.info) return;
  glisseFrise = true;
  $('frise').setPointerCapture(e.pointerId);
  const t = friseVersTemps(e);
  allerA(t);
  const p = pubA(t);
  if (p && p.id !== m.choisie) choisirPub(p.id);
});
$('frise').addEventListener('pointermove', (e) => { if (glisseFrise) allerA(friseVersTemps(e)); });
$('frise').addEventListener('pointerup', () => { glisseFrise = false; afficherPubs(); });
window.addEventListener('resize', () => requestAnimationFrame(dessinerFrise));

/* ------------------------------ Masques ------------------------------ */

const masques = () => m.projet?.masques || [];
const PORTEES = { tout: 'Toute la vidéo', pubs: 'Pendant certaines pubs', avant: 'Avant la révélation de certaines pubs' };
const STYLES = { flou: 'Flou', pixels: 'Pixels', noir: 'Bande noire' };

const masqueActif = (mq, t) => {
  if (mq.portee === 'tout') return true;
  return pubs().some((p) => mq.pubs.includes(p.id) && t >= p.debut && t < (mq.portee === 'avant' ? p.revelation : p.fin));
};

// Aperçu fidèle au rendu : on redessine la zone de l'image courante avec le
// même flou ou la même pixellisation que ffmpeg appliquera (voir rendu.js).
const petitCanevas = document.createElement('canvas');
const peindreMasque = (canevas, mq, el) => {
  if (!canevas) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const actif = el.classList.contains('flou') || el.classList.contains('pixels');
  if (!actif || el.classList.contains('inactif') || !vw || video.readyState < 2) { canevas.hidden = true; return; }
  const dpr = window.devicePixelRatio || 1;
  const L = Math.max(1, Math.round(el.clientWidth * dpr)), H = Math.max(1, Math.round(el.clientHeight * dpr));
  if (canevas.width !== L || canevas.height !== H) { canevas.width = L; canevas.height = H; }
  const g = canevas.getContext('2d');
  const sx = mq.x * vw, sy = mq.y * vh, sw = Math.max(2, mq.w * vw), sh = Math.max(2, mq.h * vh);
  g.clearRect(0, 0, L, H);
  try {
    if (mq.style === 'pixels') {
      const bloc = Math.max(6, Math.round(Math.min(sw, sh) / 4));
      petitCanevas.width = Math.max(1, Math.ceil(sw / bloc));
      petitCanevas.height = Math.max(1, Math.ceil(sh / bloc));
      petitCanevas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, petitCanevas.width, petitCanevas.height);
      g.imageSmoothingEnabled = false;
      g.drawImage(petitCanevas, 0, 0, L, H);
    } else {
      // Comme ffmpeg : on découpe la zone, on prolonge ses bords, puis on floute.
      const flou = Math.max(8, Math.round(Math.min(sw, sh) / 3)) * (L / sw);
      const m2 = Math.ceil(flou * 3);
      petitCanevas.width = L + 2 * m2;
      petitCanevas.height = H + 2 * m2;
      const t = petitCanevas.getContext('2d');
      t.drawImage(video, sx, sy, sw, sh, m2, m2, L, H);
      t.drawImage(petitCanevas, m2, m2, L, 1, m2, 0, L, m2);
      t.drawImage(petitCanevas, m2, m2 + H - 1, L, 1, m2, m2 + H, L, m2);
      t.drawImage(petitCanevas, m2, 0, 1, H + 2 * m2, 0, 0, m2, H + 2 * m2);
      t.drawImage(petitCanevas, m2 + L - 1, 0, 1, H + 2 * m2, m2 + L, 0, m2, H + 2 * m2);
      g.filter = `blur(${flou.toFixed(1)}px)`;
      g.drawImage(petitCanevas, -m2, -m2);
      g.filter = 'none';
    }
    canevas.hidden = false;
  } catch {
    canevas.hidden = true;
  }
};

const majCalque = () => {
  const calque = $('calque');
  if (!m.projet) return;
  const t = video.currentTime || 0;
  const surOngletMasques = !$('p-masques').hidden;
  calque.classList.toggle('actif', surOngletMasques);
  calque.classList.toggle('dessin', m.dessin);
  const existants = new Map([...calque.querySelectorAll('.masque')].map((el) => [el.dataset.masque, el]));
  for (const mq of masques()) {
    let el = existants.get(mq.id);
    existants.delete(mq.id);
    if (!el) {
      el = creer('div', { class: 'masque', 'data-masque': mq.id }, creer('canvas', { class: 'voile' }), creer('span', { class: 'poignee' }));
      calque.append(el);
    }
    el.className = `masque ${mq.style}${masqueActif(mq, t) ? '' : ' inactif'}${mq.id === m.masqueChoisi && surOngletMasques ? ' choisi' : ''}`;
    el.style.left = `${mq.x * 100}%`; el.style.top = `${mq.y * 100}%`;
    el.style.width = `${mq.w * 100}%`; el.style.height = `${mq.h * 100}%`;
    peindreMasque(el.querySelector('canvas.voile'), mq, el);
    el.style.pointerEvents = surOngletMasques && !m.dessin ? 'auto' : 'none';
  }
  for (const el of existants.values()) el.remove();
};

const afficherMasques = () => {
  const liste = $('liste-masques');
  liste.replaceChildren(...masques().map((mq, i) => {
    const li = creer('li', { class: `masque-ligne${mq.id === m.masqueChoisi ? ' choisi' : ''}`, 'data-masque': mq.id });
    li.append(creer('div', { class: 'haut' },
      creer('button', { class: 'nom-masque', type: 'button', texte: `Masque ${i + 1}${mq.auto ? ' (trouvé à l\'analyse)' : ''}`, onclick: () => choisirMasque(mq.id) }),
      creer('button', { class: 'bouton petit danger', type: 'button', texte: 'Retirer', onclick: () => supprimerMasque(mq.id) })));
    const style = creer('select', { 'aria-label': 'Aspect du masque' }, ...Object.entries(STYLES).map(([v, n]) => creer('option', { value: v, texte: n, selected: mq.style === v })));
    style.addEventListener('change', () => { mq.style = style.value; modifie(); majCalque(); });
    const portee = creer('select', { 'aria-label': 'Quand le masque s\'applique' }, ...Object.entries(PORTEES).map(([v, n]) => creer('option', { value: v, texte: n, selected: mq.portee === v })));
    portee.addEventListener('change', () => {
      mq.portee = portee.value;
      if (mq.portee !== 'tout' && !mq.pubs.length) { const p = pubA(video.currentTime) || pubChoisie(); if (p) mq.pubs = [p.id]; }
      modifie(); afficherMasques(); majCalque();
    });
    li.append(creer('div', { class: 'reglages' }, style, portee));
    if (mq.portee !== 'tout') {
      li.append(creer('div', { class: 'puces', role: 'group', 'aria-label': 'Pubs concernées' },
        ...pubs().map((p, k) => creer('button', {
          type: 'button', 'aria-pressed': String(mq.pubs.includes(p.id)), texte: `Pub ${k + 1}`,
          onclick: () => {
            mq.pubs = mq.pubs.includes(p.id) ? mq.pubs.filter((x) => x !== p.id) : [...mq.pubs, p.id];
            modifie(); afficherMasques(); majCalque();
          },
        }))));
      if (!mq.pubs.length) li.append(creer('p', { class: 'aide', texte: 'Choisis au moins une pub, sinon ce masque ne sert jamais.' }));
    }
    return li;
  }));
  if (!masques().length) liste.append(creer('li', { class: 'discret', texte: 'Aucun masque. Dessine-en un sur l\'image.' }));
  majCalque();
};

const choisirMasque = (id) => {
  m.masqueChoisi = id;
  const mq = masques().find((x) => x.id === id);
  // Se place à un moment où le masque s'applique, pour le voir à l'œuvre.
  if (mq && !masqueActif(mq, video.currentTime)) {
    const p = pubs().find((x) => mq.pubs.includes(x.id));
    if (p) allerA(p.debut + Math.min(1, (p.revelation - p.debut) / 2));
  }
  afficherMasques();
};

const supprimerMasque = (id) => {
  m.projet.masques = masques().filter((x) => x.id !== id);
  if (m.masqueChoisi === id) m.masqueChoisi = null;
  modifie();
  afficherMasques();
};

$('dessiner').addEventListener('click', () => {
  m.dessin = !m.dessin;
  $('dessiner').setAttribute('aria-pressed', String(m.dessin));
  $('dessiner').textContent = m.dessin ? 'Annuler le dessin' : 'Dessiner un masque';
  $('aide-dessin').hidden = !m.dessin;
  if (m.dessin) video.pause();
  majCalque();
});

// Tracé, déplacement et redimensionnement, en fractions de l'image.
let geste = null;
const posCalque = (e) => {
  const r = $('calque').getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
};
$('calque').addEventListener('pointerdown', (e) => {
  if ($('p-masques').hidden || !m.projet) return;
  const p = posCalque(e);
  const cible = e.target.closest('.masque');
  $('calque').setPointerCapture(e.pointerId);
  e.preventDefault();
  if (m.dessin) {
    const trace = creer('div', { class: 'trace' });
    $('calque').append(trace);
    geste = { type: 'trace', depart: p, trace };
  } else if (cible) {
    const mq = masques().find((x) => x.id === cible.dataset.masque);
    if (!mq) return;
    if (m.masqueChoisi !== mq.id) { m.masqueChoisi = mq.id; afficherMasques(); }
    geste = { type: e.target.classList.contains('poignee') ? 'taille' : 'deplace', depart: p, mq, origine: { ...mq } };
  } else if (m.masqueChoisi) {
    m.masqueChoisi = null;
    afficherMasques();
  }
});
$('calque').addEventListener('pointermove', (e) => {
  if (!geste) return;
  const p = posCalque(e);
  if (geste.type === 'trace') {
    const x = Math.min(p.x, geste.depart.x), y = Math.min(p.y, geste.depart.y);
    Object.assign(geste.trace.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${Math.abs(p.x - geste.depart.x) * 100}%`, height: `${Math.abs(p.y - geste.depart.y) * 100}%` });
    return;
  }
  const dx = p.x - geste.depart.x, dy = p.y - geste.depart.y, o = geste.origine, mq = geste.mq;
  if (geste.type === 'deplace') {
    mq.x = Math.min(1 - o.w, Math.max(0, o.x + dx));
    mq.y = Math.min(1 - o.h, Math.max(0, o.y + dy));
  } else {
    mq.w = Math.min(1 - o.x, Math.max(0.01, o.w + dx));
    mq.h = Math.min(1 - o.y, Math.max(0.01, o.h + dy));
  }
  majCalque();
});
const finGeste = (e) => {
  if (!geste) return;
  const g = geste;
  geste = null;
  if (g.type === 'trace') {
    g.trace.remove();
    const p = posCalque(e);
    const x = Math.min(p.x, g.depart.x), y = Math.min(p.y, g.depart.y);
    const w = Math.abs(p.x - g.depart.x), h = Math.abs(p.y - g.depart.y);
    if (w < 0.01 || h < 0.01) return;
    const mq = { id: idAleatoire(), x: arr(x), y: arr(y), w: arr(w), h: arr(h), style: 'flou', portee: 'tout', pubs: [], auto: false };
    m.projet.masques.push(mq);
    m.masqueChoisi = mq.id;
    m.dessin = false;
    $('dessiner').setAttribute('aria-pressed', 'false');
    $('dessiner').textContent = 'Dessiner un masque';
    $('aide-dessin').hidden = true;
    modifie();
    afficherMasques();
  } else {
    for (const k of ['x', 'y', 'w', 'h']) g.mq[k] = arr(g.mq[k]);
    modifie();
  }
};
const arr = (v) => Math.round(v * 10000) / 10000;
$('calque').addEventListener('pointerup', finGeste);
$('calque').addEventListener('pointercancel', () => { if (geste?.trace) geste.trace.remove(); geste = null; majCalque(); });

/* ------------------------------ Onglets ------------------------------ */

const onglets = ['pubs', 'masques', 'export'];
const montrerOnglet = (nom) => {
  onglets.forEach((o) => {
    const actif = o === nom;
    $(`o-${o}`).setAttribute('aria-selected', String(actif));
    $(`o-${o}`).tabIndex = actif ? 0 : -1;
    $(`p-${o}`).hidden = !actif;
  });
  if (nom !== 'masques' && m.dessin) $('dessiner').click();
  majCalque();
  if (nom === 'export') { afficherResumeQuiz(); majLienEdl(); }
};
onglets.forEach((o, i) => {
  $(`o-${o}`).addEventListener('click', () => montrerOnglet(o));
  $(`o-${o}`).addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const suivant = onglets[(i + (e.key === 'ArrowRight' ? 1 : onglets.length - 1)) % onglets.length];
    montrerOnglet(suivant);
    $(`o-${suivant}`).focus();
  });
});

/* ------------------------------ Export ------------------------------ */

const CADENCES = [
  ['23.976', '23,976'], ['24', '24'], ['25', '25'], ['29.97', '29,97'], ['29.97df', '29,97 drop frame'],
  ['30', '30'], ['50', '50'], ['59.94', '59,94'], ['59.94df', '59,94 drop frame'], ['60', '60'],
];
const remplirCadences = (conseillee) => {
  const s = $('cadence');
  const avant = s.value;
  s.replaceChildren(...CADENCES.map(([v, n]) => creer('option', { value: v, texte: v === conseillee ? `${n} (celle de la vidéo)` : n })));
  s.value = avant && m.cadenceChoisie ? avant : conseillee || '25';
  majLienEdl();
};
$('cadence').addEventListener('change', () => { m.cadenceChoisie = true; majLienEdl(); });
$('position').addEventListener('input', majLienEdl);
function majLienEdl() {
  const position = $('position').value.trim();
  const ok = /^\d{1,2}[:;.]\d{2}[:;.]\d{2}[:;.]\d{2}$/.test(position);
  $('position').classList.toggle('invalide', !ok);
  $('lien-edl').setAttribute('aria-disabled', String(!ok));
  $('lien-edl').href = ok && m.id ? `/api/videos/${m.id}/marqueurs.edl?cadence=${encodeURIComponent($('cadence').value)}&position=${encodeURIComponent(position)}` : '#';
}
$('lien-edl').addEventListener('click', async (e) => {
  if ($('lien-edl').getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
  // Les marqueurs doivent refléter les derniers réglages.
  if (m.version !== m.versionEnregistree) {
    e.preventDefault();
    await enregistrerMaintenant();
    window.location.href = $('lien-edl').href;
  }
});

const reglages = () => m.projet.reglages;
$('question').addEventListener('input', () => { reglages().question = $('question').value; modifie(); });
$('duree-question').addEventListener('input', () => {
  const v = Number($('duree-question').value);
  const ok = Number.isFinite(v) && v >= 1 && v <= 30;
  $('duree-question').classList.toggle('invalide', !ok);
  if (ok) { reglages().dureeQuestion = v; modifie(); afficherResumeQuiz(); }
});
$('afficher-reponse').addEventListener('change', () => { reglages().reponse = $('afficher-reponse').checked; modifie(); afficherResumeQuiz(); });

const afficherResumeQuiz = () => {
  if (!m.projet) return;
  const dans = pubs().filter((p) => p.inclure);
  const Q = reglages().dureeQuestion;
  const total = dans.reduce((s, p) => s + (p.fin - p.debut) + Q, 0);
  const sansReponse = reglages().reponse ? dans.filter((p) => !String(p.reponse || '').trim()).length : 0;
  const avecChoix = dans.filter((p) => choixPub(p)).length;
  const details = [
    avecChoix ? `${avecChoix} avec propositions` : '',
    sansReponse ? `${sansReponse} sans réponse écrite` : '',
  ].filter(Boolean).join(', ');
  $('resume-quiz').textContent = dans.length
    ? `${dans.length} pub${dans.length > 1 ? 's' : ''}, ${fmtDuree(total)} au total${details ? ` (${details})` : ''}.`
    : 'Aucune pub cochée « Dans le quiz ».';
  $('monter').disabled = !dans.length;
};

const lancerExport = async (type) => {
  await enregistrerMaintenant();
  try {
    await api(`/api/videos/${m.id}/exports`, { methode: 'POST', corps: { type } });
    await rafraichirVideo(false);
  } catch (e) { annoncer(e.message); }
};
$('monter').addEventListener('click', () => lancerExport('quiz'));
$('nettoyer').addEventListener('click', () => lancerExport('nettoyee'));

const nomLisible = (nom) => {
  const r = nom.match(/^(quiz|nettoyee)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.(mp4|edl)$/);
  if (!r) return nom;
  const date = new Date(Date.UTC(+r[2], +r[3] - 1, +r[4], +r[5], +r[6], +r[7]));
  const quand = date.toLocaleString('fr-BE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `${r[1] === 'quiz' ? 'Quiz' : 'Vidéo nettoyée'} du ${quand}`;
};

const afficherExports = () => {
  const d = m.donnees;
  const liste = $('liste-exports');
  const enCours = (d.taches || []).filter((t) => t.type.startsWith('export-') && !t.finie);
  const echecs = (d.taches || []).filter((t) => t.type.startsWith('export-') && t.etat === 'erreur').slice(0, 1);
  const fichiers = (d.exports || []).filter((f) => f.nom.endsWith('.mp4'));
  const edls = new Set((d.exports || []).filter((f) => f.nom.endsWith('.edl')).map((f) => f.nom));
  liste.replaceChildren(
    ...enCours.map((t) => creer('li', { 'data-tache': t.id },
      creer('span', { class: 'nom-fichier', texte: t.etat === 'attente' ? `${t.libelle} : en attente` : t.libelle }),
      creer('span', { class: 'progression' }, creer('span', { class: 'barre-progres' }, creer('div', { style: `width:${Math.round(t.progres * 100)}%` })), `${Math.round(t.progres * 100)} %`),
      creer('button', { class: 'bouton petit', type: 'button', texte: 'Annuler', onclick: async () => { await api(`/api/taches/${t.id}`, { methode: 'DELETE' }).catch(() => {}); rafraichirVideo(false); } }))),
    ...echecs.map((t) => creer('li', { class: 'erreur', texte: `${t.libelle} : ${t.erreur}` })),
    ...fichiers.map((f) => {
      const edl = f.nom.replace(/\.mp4$/, '.edl');
      return creer('li', { 'data-fichier': f.nom },
        creer('span', { class: 'nom-fichier' }, nomLisible(f.nom), creer('span', { class: 'discret', texte: `  ${fmtTaille(f.taille)}` })),
        creer('a', { class: 'bouton petit principal', href: `/media/${m.id}/exports/${f.nom}`, download: '', texte: 'Télécharger' }),
        edls.has(edl) ? creer('a', { class: 'bouton petit', href: `/media/${m.id}/exports/${edl}`, download: '', texte: 'Marqueurs' }) : null,
        creer('a', { class: 'bouton petit', href: `/media/${m.id}/exports/${f.nom}?voir=1`, target: '_blank', rel: 'noopener', texte: 'Voir' }),
        creer('button', { class: 'bouton petit danger', type: 'button', texte: 'Supprimer', onclick: async () => {
          if (!confirm(`Supprimer « ${nomLisible(f.nom)} » ?`)) return;
          await api(`/api/videos/${m.id}/exports/${f.nom}`, { methode: 'DELETE' }).catch((e) => annoncer(e.message));
          rafraichirVideo(false);
        } }));
    }),
  );
  $('exports-vide').hidden = liste.children.length > 0;
};

const annoncer = (texte) => { $('sauvegarde').textContent = texte; };

/* ------------------------------ Navigation ------------------------------ */

async function router() {
  let session;
  try { session = await api('/api/session'); } catch { return; }
  // Site sans mot de passe : rien à déconnecter.
  document.querySelectorAll('[data-action="deconnexion"]').forEach((el) => { el.hidden = session.motDePasse === false; });
  if (!session.connecte) return montrerConnexion();
  const r = location.hash.match(/^#\/video\/([a-z0-9]{8})$/);
  if (r) {
    montrer('vue-montage');
    await ouvrirVideo(r[1]);
  } else {
    await enregistrerMaintenant();
    video.pause();
    await afficherBiblio();
  }
}
window.addEventListener('hashchange', router);
router();

// Pour les tests de bout en bout.
window.__quizPub = { m, pubs, masques };
