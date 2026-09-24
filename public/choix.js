// Propositions affichées pendant la question, partagées par la page et le
// serveur : la page annonce la lettre de la bonne réponse, le serveur
// dessine exactement le même ordre dans la vidéo.
export const LETTRES = ['A', 'B', 'C', 'D'];
export const MAX_FAUSSES = 3;

const pareil = (a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }) === 0;

// null tant qu'il manque la bonne réponse ou une fausse proposition.
// La place de la bonne réponse dépend de l'identifiant de la pub : elle
// change d'une pub à l'autre et ne bouge plus ensuite.
export const choixPub = (p) => {
  const reponse = String(p?.reponse || '').trim();
  if (!reponse) return null;
  const fausses = [];
  for (const brut of Array.isArray(p?.propositions) ? p.propositions : []) {
    const s = String(brut ?? '').trim();
    if (s && !pareil(s, reponse) && !fausses.some((f) => pareil(f, s))) fausses.push(s);
  }
  if (!fausses.length) return null;
  const textes = fausses.slice(0, MAX_FAUSSES);
  let h = 7;
  for (const c of String(p.id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const place = h % (textes.length + 1);
  textes.splice(place, 0, reponse);
  return { choix: textes.map((texte, i) => ({ lettre: LETTRES[i], texte, bonne: i === place })), lettre: LETTRES[place] };
};
