# PWA offline / téléchargements — mémo (à faire)

But : lire des chapitres **hors-ligne** (mode avion / sans co) façon Netflix, en stockant le
contenu **dans le PWA** (pas dans les fichiers du téléphone — voir « Limites »).

## État actuel (déjà en place)
- **Service worker** `app/front/public/sw.js` : met en cache l'**app shell** (JS/CSS hashés,
  index, manifest, icônes) → **le PWA se lance déjà hors-ligne** (l'UI charge).
- Il **ignore `/api/`** : images de chapitres, covers et listes **ne sont PAS stockées** →
  hors-ligne aujourd'hui = app vide (pas de contenu). L'audio `/ambience/*` est volontairement
  toujours servi en direct (jamais caché).

## À construire
1. **Bouton « Télécharger »** (par chapitre, puis par tome/lot) :
   - récupère la liste `/api/mangas/{id}/chapters/{n}/images` puis chaque `/images/{i}` ;
   - stocke images + **cover** + **métadonnées** (nb pages, titre) + **découpage des cases**
     (JSON de `/api/reader/panels`, pour que le Cinéma marche offline) dans un cache dédié
     (Cache Storage `mangalib-offline` et/ou IndexedDB pour les blobs + l'index).
2. **Lecture offline** : le SW sert les images depuis le cache offline si le chapitre est
   téléchargé (sinon réseau). Le lecteur lit le découpage stocké (repli JS `detectPanels`).
3. **Écran « Téléchargements »** : liste des chapitres dispo hors-ligne (index local, car les
   listes viennent d'API qui échouent offline). Accessible même sans co.
4. **Progression offline** : marque-page en local + **file de resynchro** au retour du réseau
   (POST `/api/.../progress`).
5. **Gestion du stockage** : afficher l'espace utilisé (`navigator.storage.estimate()`),
   supprimer un téléchargement, demander le **stockage persistant**
   (`navigator.storage.persist()`).

## Limites (important, surtout iOS)
- Un PWA **ne peut pas lire les fichiers du téléphone** (dossier Téléchargements / app Fichiers)
  de façon persistante : bac à sable navigateur. **File System Access API** = Chrome
  Android/PC uniquement, **pas iOS**. Donc « télécharger dans les Fichiers puis lire depuis le
  PWA » = **impossible sur iPhone**. Seule voie iOS = **cache in-app** (ci-dessus).
- **iOS** : le stockage web d'un PWA marche mais WebKit peut **évincer** les données sous
  pression, `storage.persist()` mal supporté → téléchargements **non garantis permanents**.
  Quotas plus stricts (un tome ≈ 5–30 Mo d'images ; beaucoup de tomes ⇒ Go ⇒ risque de purge).
  → prévenir l'utilisateur ; pour du « garanti offline » il faudrait une **app native**.
- **Android/PC** : fiable, quotas généreux ; option bonus « choisir un dossier » (File System
  Access) pour une vraie persistance côté fichiers.

## Phases proposées
- **Phase 1** : télécharger **1 chapitre** + le relire **entièrement offline** (images +
  découpage) + écran Téléchargements minimal.
- **Phase 2** : progression offline + resynchro, gestion du stockage, téléchargement par tome.

Voir aussi la mémoire projet `prod_topology_http` (le SW/PWA n'a de sens qu'en HTTPS →
`https://62-238-63-117.nip.io`).
