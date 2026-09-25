// YT téléchargeur : interface. Aucune bibliothèque.
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
const taille = (o) => (!o ? '' : o >= 1e9 ? `${(o / 1e9).toFixed(1).replace('.', ',')} Go` : `${Math.max(0.1, o / 1e6).toFixed(o < 1e7 ? 1 : 0).replace('.', ',')} Mo`);
const duree = (s) => {
  if (!Number.isFinite(s)) return '';
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
// « 1:30 » → 90 ; « 90 » → 90 ; vide → null ; illisible → NaN.
export const lireTemps = (texte) => {
  const t = String(texte || '').trim().replace(',', '.');
  if (!t) return null;
  const g = t.split(':');
  if (g.length > 3 || g.some((x) => !/^\d+(\.\d+)?$/.test(x))) return NaN;
  return g.reduce((total, x) => total * 60 + Number(x), 0);
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

/* ------------------------------ Analyse du lien ------------------------------ */

const AUDIOS = [
  { cle: 'mp3-320', nom: 'MP3 320 kbit/s', detail: 'la meilleure qualité en MP3', debit: 320 },
  { cle: 'mp3-192', nom: 'MP3 192 kbit/s', detail: 'plus léger', debit: 192 },
  { cle: 'mp3-128', nom: 'MP3 128 kbit/s', detail: 'le plus léger', debit: 128 },
  { cle: 'm4a', nom: 'M4A', detail: 'qualité d\'origine, sans conversion', debit: null },
];
const nomDefinition = (r) => ({ 4320: '8K', 2160: '4K', 1440: '2K', 1080: 'Full HD', 720: 'HD' })[r] || '';

let analyse = null;       // réponse de /api/analyse
let lienAnalyse = '';     // pour ne pas relire deux fois le même lien
let numeroAnalyse = 0;

const cacherResultats = () => { $('apercu').hidden = true; $('liste-lecture').hidden = true; };

const analyser = async (url) => {
  const numero = ++numeroAnalyse;
  lienAnalyse = url;
  cacherResultats();
  $('lien-erreur').textContent = '';
  $('lien-etat').textContent = 'Lecture du lien…';
  $('analyser').disabled = true;
  try {
    const infos = await api('/api/analyse', { methode: 'POST', corps: { url } });
    if (numero !== numeroAnalyse) return;
    analyse = { ...infos, lien: url };
    $('lien-etat').textContent = '';
    if (infos.type === 'liste') afficherListe(analyse); else afficherApercu(analyse);
  } catch (err) {
    if (numero !== numeroAnalyse) return;
    $('lien-etat').textContent = '';
    $('lien-erreur').textContent = err.message;
    lienAnalyse = '';
  } finally {
    if (numero === numeroAnalyse) $('analyser').disabled = false;
  }
};

$('form-lien').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('lien').value.trim();
  if (url) analyser(url);
});
// Lien collé : lecture tout de suite, sans chercher le bouton.
let minuterieCollage = 0;
$('lien').addEventListener('input', () => {
  clearTimeout(minuterieCollage);
  const url = $('lien').value.trim();
  if (!/^https?:\/\/\S+\.\S+/.test(url) || url === lienAnalyse) return;
  minuterieCollage = setTimeout(() => analyser(url), 450);
});
if (navigator.clipboard?.readText) {
  $('coller').hidden = false;
  $('coller').addEventListener('click', async () => {
    try {
      const texte = (await navigator.clipboard.readText()).trim();
      if (texte) { $('lien').value = texte; analyser(texte); }
    } catch { annoncer('Le navigateur refuse l\'accès au presse-papiers : colle le lien à la main.'); }
  });
}

/* ------------------------------ Une vidéo ------------------------------ */

const puce = (nom, valeur, titre, detail, coche) => creer('label', { class: 'puce' },
  creer('input', { type: 'radio', name: nom, value: String(valeur), checked: coche }),
  creer('span', {}, creer('b', { texte: titre }), detail ? creer('small', { texte: detail }) : null));

const modeChoisi = () => document.querySelector('input[name=mode]:checked')?.value || 'video';
const qualiteChoisie = () => {
  const v = document.querySelector('input[name=qualite]:checked')?.value;
  return v === 'max' ? 'max' : Number(v) || 1080;
};

const majMode = () => {
  const mode = modeChoisi();
  $('choix-video').hidden = mode !== 'video';
  $('choix-musique').hidden = mode !== 'musique';
  const q = Number(document.querySelector('input[name=qualite]:checked')?.value);
  $('note-video').hidden = !(mode === 'video' && q > 1080);
};

const afficherApercu = (v) => {
  $('apercu-image').hidden = !v.miniature;
  if (v.miniature) { $('apercu-image').src = v.miniature; $('apercu-image').onerror = () => { $('apercu-image').hidden = true; }; }
  $('apercu-titre').textContent = v.titre || 'Sans titre';
  $('apercu-infos').textContent = [v.chaine, duree(v.duree), v.site && !/^youtube/i.test(v.site) ? v.site : ''].filter(Boolean).join(' · ');
  const avecImage = v.qualites.length > 0 || v.videoInconnue;
  const onglets = document.querySelectorAll('input[name=mode]');
  onglets[0].disabled = !avecImage;
  onglets[1].disabled = !v.son && !avecImage;
  onglets[avecImage ? 0 : 1].checked = true;
  // Par défaut : la meilleure définition lisible partout (1080p au plus).
  const defaut = (v.qualites.find((q) => q.res <= 1080) || v.qualites[0])?.res;
  $('choix-video').replaceChildren(...(v.qualites.length
    ? v.qualites.map((q) => puce('qualite', q.res, `${q.res}p`,
      [nomDefinition(q.res), taille(q.taille) ? `environ ${taille(q.taille)}` : ''].filter(Boolean).join(' · '), q.res === defaut))
    : [puce('qualite', 'max', 'Meilleure qualité', 'celle que propose le site', true)]));
  $('choix-musique').replaceChildren(...AUDIOS.map((a, i) => {
    const poids = a.debit && v.duree ? (a.debit * 1000 / 8) * v.duree : a.cle === 'm4a' ? v.son?.taille : null;
    return puce('audio', a.cle, a.nom, [a.detail, poids ? `environ ${taille(poids)}` : ''].filter(Boolean).join(' · '), i === 0);
  }));
  document.querySelectorAll('input[name=qualite]').forEach((i) => i.addEventListener('change', majMode));
  $('extrait').open = false;
  $('extrait-debut').value = '';
  $('extrait-fin').value = '';
  $('apercu-erreur').textContent = '';
  majMode();
  $('apercu').hidden = false;
};
document.querySelectorAll('input[name=mode]').forEach((i) => i.addEventListener('change', majMode));

const lancer = (corps) => api('/api/telechargements', { methode: 'POST', corps });

$('telecharger').addEventListener('click', async () => {
  const v = analyse;
  if (!v) return;
  $('apercu-erreur').textContent = '';
  const debut = lireTemps($('extrait-debut').value), fin = lireTemps($('extrait-fin').value);
  if (Number.isNaN(debut) || Number.isNaN(fin)) { $('apercu-erreur').textContent = 'Écris le début et la fin comme 1:30.'; return; }
  if (debut !== null && fin !== null && fin <= debut) { $('apercu-erreur').textContent = 'La fin de l\'extrait doit venir après le début.'; return; }
  if (v.duree && ((debut ?? 0) >= v.duree || (fin !== null && fin > v.duree + 1))) { $('apercu-erreur').textContent = `La vidéo dure ${duree(v.duree)}.`; return; }
  const mode = modeChoisi();
  $('telecharger').disabled = true;
  try {
    await lancer({
      url: v.url || v.lien, mode, titre: v.titre, chaine: v.chaine, miniature: v.miniature,
      qualite: mode === 'video' ? qualiteChoisie() : undefined,
      audio: mode === 'musique' ? document.querySelector('input[name=audio]:checked')?.value : undefined,
      debut, fin,
    });
    cacherResultats();
    $('lien').value = '';
    lienAnalyse = '';
    analyse = null;
    annoncer('Téléchargement lancé : il apparaît plus bas.');
    await charger();
  } catch (err) { $('apercu-erreur').textContent = err.message; }
  $('telecharger').disabled = false;
});

/* ------------------------------ Une playlist ------------------------------ */

const FORMATS_LISTE = {
  video: [['max', 'Meilleure qualité disponible'], ['2160', '4K 2160p au plus'], ['1080', '1080p au plus (lisible partout)'], ['720', '720p au plus'], ['480', '480p au plus']],
  musique: AUDIOS.map((a) => [a.cle, `${a.nom}, ${a.detail}`]),
};
const majFormatListe = () => {
  const mode = document.querySelector('input[name=ll-mode]:checked').value;
  $('ll-format-libelle').textContent = mode === 'video' ? 'Définition' : 'Format';
  $('ll-format').replaceChildren(...FORMATS_LISTE[mode].map(([v, n]) => creer('option', { value: v, texte: n, selected: v === '1080' || v === 'mp3-320' })));
};
document.querySelectorAll('input[name=ll-mode]').forEach((i) => i.addEventListener('change', majFormatListe));

const cochees = () => [...document.querySelectorAll('#ll-entrees input[type=checkbox]:checked')];
const majBoutonListe = () => {
  const n = cochees().length;
  $('ll-telecharger').textContent = n ? `Télécharger ${n > 1 ? `les ${n} vidéos` : 'la vidéo'}` : 'Télécharger';
  $('ll-telecharger').disabled = !n;
};

const afficherListe = (l) => {
  $('ll-titre').textContent = l.titre || 'Playlist';
  $('ll-infos').textContent = [l.chaine, `${l.nombre} vidéo${l.nombre > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
  document.querySelector('input[name=ll-mode][value=video]').checked = true;
  majFormatListe();
  $('ll-entrees').replaceChildren(...l.entrees.map((e, i) => creer('li', {},
    creer('label', {},
      creer('input', { type: 'checkbox', checked: true, 'data-i': String(i), onchange: majBoutonListe }),
      e.miniature ? creer('img', { src: e.miniature, alt: '', loading: 'lazy', onerror: (ev) => ev.target.remove() }) : null,
      creer('span', { class: 'entree-texte' }, creer('span', { texte: e.titre || e.url }), e.duree ? creer('small', { class: 'discret', texte: duree(e.duree) }) : null)))));
  $('ll-etat').textContent = '';
  majBoutonListe();
  $('liste-lecture').hidden = false;
};
$('ll-tout').addEventListener('click', () => { document.querySelectorAll('#ll-entrees input').forEach((c) => { c.checked = true; }); majBoutonListe(); });
$('ll-rien').addEventListener('click', () => { document.querySelectorAll('#ll-entrees input').forEach((c) => { c.checked = false; }); majBoutonListe(); });

$('ll-telecharger').addEventListener('click', async () => {
  const l = analyse;
  const choisies = cochees().map((c) => l.entrees[Number(c.dataset.i)]);
  const mode = document.querySelector('input[name=ll-mode]:checked').value;
  const format = $('ll-format').value;
  $('ll-telecharger').disabled = true;
  let faits = 0;
  for (const e of choisies) {
    $('ll-etat').textContent = `Ajout ${faits + 1} sur ${choisies.length}…`;
    try {
      await lancer({
        url: e.url, mode, titre: e.titre, chaine: l.chaine, miniature: e.miniature,
        qualite: mode === 'video' ? (format === 'max' ? 'max' : Number(format)) : undefined,
        audio: mode === 'musique' ? format : undefined,
      });
      faits++;
    } catch (err) { annoncer(`${e.titre} : ${err.message}`); }
  }
  cacherResultats();
  $('lien').value = '';
  lienAnalyse = '';
  annoncer(`${faits} téléchargement${faits > 1 ? 's' : ''} lancé${faits > 1 ? 's' : ''} : ils se font l'un après l'autre.`);
  charger().catch(() => {});
});

/* ------------------------------ Les téléchargements ------------------------------ */

let systeme = {};
let minuterieSuivi = 0;

const afficher = (liste) => {
  $('vide').hidden = liste.length > 0;
  $('liste').replaceChildren(...liste.map((t) => {
    const li = creer('li', { 'data-etat': t.etat, 'data-id': t.id });
    const infos = [t.format, t.duree ? duree(t.duree) : '', t.taille ? taille(t.taille) : ''].filter(Boolean).join(', ');
    const tete = creer('div', { class: 'tete' },
      t.miniature ? creer('img', { class: 'vignette', src: t.miniature, alt: '', loading: 'lazy', onerror: (ev) => ev.target.remove() }) : null,
      creer('div', { class: 'tete-texte' },
        creer('p', { class: 'titre', texte: t.titre || t.url }),
        creer('p', { class: 'infos discret', texte: infos })));
    li.append(tete);
    if (t.etat === 'attente' || t.etat === 'telechargement') {
      const p = t.tache?.progres ?? 0;
      li.append(creer('div', { class: 'progres' },
        creer('div', { class: 'barre-progres' }, creer('div', { style: `width:${Math.round(p * 100)}%` })),
        creer('span', { class: 'discret', texte: t.etat === 'attente' ? 'En attente…' : `${t.tache?.message || 'Téléchargement'} (${Math.round(p * 100)} %)` })));
    }
    if (t.etat === 'erreur') li.append(creer('p', { class: 'message erreur', texte: t.message }));
    const actions = creer('div', { class: 'actions' });
    if (t.etat === 'pret') {
      actions.append(creer('a', { class: 'bouton principal', href: `/fichiers/${t.id}`, texte: 'Enregistrer' }));
      if (t.mode === 'video' && systeme.quiz) {
        actions.append(creer('button', { class: 'bouton', type: 'button', texte: t.quiz ? 'Renvoyer au quiz' : 'Envoyer au quiz', onclick: (ev) => envoyerAuQuiz(t, ev.currentTarget) }));
      }
    }
    if (t.etat === 'erreur') {
      actions.append(creer('button', { class: 'bouton', type: 'button', texte: 'Réessayer', onclick: () => reessayer(t) }));
    }
    actions.append(creer('button', { class: 'bouton danger', type: 'button', texte: t.etat === 'telechargement' || t.etat === 'attente' ? 'Annuler' : 'Supprimer', onclick: () => supprimer(t) }));
    li.append(actions);
    if (t.quiz) li.append(creer('p', { class: 'envoye', texte: 'Envoyée au quiz.' }));
    return li;
  }));
};

const charger = async () => {
  clearTimeout(minuterieSuivi);
  const liste = await api('/api/telechargements');
  afficher(liste);
  if (liste.some((t) => t.etat === 'attente' || t.etat === 'telechargement')) minuterieSuivi = setTimeout(() => charger().catch(() => {}), 1200);
};

const supprimer = async (t) => {
  if (!confirm(`Supprimer « ${t.titre || t.url} » du serveur ?`)) return;
  try { await api(`/api/telechargements/${t.id}`, { methode: 'DELETE' }); } catch (err) { annoncer(err.message); }
  charger().catch(() => {});
};

const reessayer = async (t) => {
  try {
    await lancer({ url: t.url, mode: t.mode, qualite: t.qualite ?? undefined, audio: t.audio ?? undefined, debut: t.extrait?.debut ?? null, fin: t.extrait?.fin ?? null, titre: t.titre, chaine: t.chaine, miniature: t.miniature });
    await api(`/api/telechargements/${t.id}`, { methode: 'DELETE' });
  } catch (err) { annoncer(err.message); }
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

/* ------------------------------ yt-dlp ------------------------------ */

const afficherSysteme = () => {
  $('version').textContent = `Moteur : yt-dlp ${systeme.ytdlp || 'introuvable'}${systeme.cookies ? ', cookies YouTube fournis' : ''}.`;
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
