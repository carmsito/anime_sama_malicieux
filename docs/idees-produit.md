# Idées produit — MangaLib

Brainstorm des évolutions de l'application (le produit, pas l'ops). Deux parties :
1. **Validé** — à développer (en cours).
2. **Pour plus tard** — idées différenciantes à creuser quand on aura le temps.

---

## 1. Validé — à développer

### #2 Bibliothèque structurée
- **Statuts de lecture** par utilisateur : *En cours / Terminé / En pause / À lire*.
- **Filtres & tri** : non-lus, par genre, dernier lu, statut, favoris.
- **Collections / étagères** + **tags/labels custom** par manga (« à relire », « pépite »).

### #4 Home / découverte
- Rails : **récemment ajoutés**, **nouveaux chapitres**, **parcours par genre**.
- **Reco simple** « parce que tu lis X » (similarité de genres via métadonnées scrapées).

### #5 Confort de lecture
- **Sélecteur de chapitres** avec marqueurs lu/non-lu + saut direct.
- **Signets** dans un chapitre.
- **Sépia / filtre luminosité** (lecture de nuit) — options de profil.
- Reader : auto-marquer un chapitre lu à la fin + « marquer les précédents comme lus ».

### Page « Mon activité » (stats enrichies)
Repose sur `reading_progress` (déjà là). Gratuit via `updated_at` :
- **Heatmap** d'activité (chapitres/pages par jour, façon GitHub).
- **Streak** de jours consécutifs (+ record).
- **Rythme** (chap/semaine, pages/jour, courbe 30 j).
- **Quand tu lis** (par heure, par jour de semaine).
- **Tops** (manga le plus lu, séries terminées, dernier chapitre).
- **Répartition par genre** (métadonnées scrapées).

Avec un petit tracking du temps de session :
- **Temps total** de lecture, durée moyenne de session, vitesse (pages/min).

Format :
- **Wrapped annuel** (récap partageable en carte image).
- **Jalons / succès** (100 chapitres, 1re série terminée, streak 7 j…).
- **Objectifs de lecture** (« 10 chapitres/semaine » + anneau de progression).

> Reco de regroupement : une **page « Mon activité »** unique qui réunit stats + statuts +
> objectifs + Wrapped → destination cohérente et gratifiante.

---

## 2. Pour plus tard — idées différenciantes (hors de l'ordinaire)

Exploitent nos atouts uniques : le **moteur d'ambiance** et le **pipeline vision**.

### Autour de l'ambiance / vision
- **Lecture cinématique** (FEATURE SIGNATURE) : détection des **cases (panels)** →
  « Guided View » (tap = case suivante avec zoom malin) + **auto pan/zoom** façon Ken Burns +
  **ambiance sonore par scène** → le chapitre devient un **motion-comic**. Personne ne le fait.
- **Ambiance sonore adaptative** (proto déjà étudié) : décor par scène (pluie/ville/tension/
  combat), intensité qui suit le **score d'action**, crossfades Web Audio.
- **Ambilight / halo lumineux** : glow autour de la page qui reprend les **couleurs dominantes**
  de la planche. Peu coûteux, effet « waouh ».
- **Bibliothèque par mood** : filtrer par le *vibe* (agrégé depuis le classifieur).
- **Pacing adaptatif** : l'auto-scroll ralentit sur les planches denses, accélère sur l'action.

### Vision / IA texte
- **Traduction à la volée** (OCR des bulles + trad) pour lire les **raws** non traduits.
- **« Previously on… »** : mini-résumé quand on reprend après longtemps.

### Social / co-lecture
- **Watch-party manga** : lecture **synchronisée** à deux (même page, réactions live).
- **Annotations partagées** sur les planches (book-club privé).
- **Ambiances communautaires** : soundscapes partagés par manga.

### Petits trucs marquants
- **Cartes partageables** générées (« en train de lire… », une stat, le Wrapped).
- **Haptique** (mobile) synchronisée sur les temps forts d'action.
- **Mode nuit / « encore un chapitre »** : nudges + « bonne nuit » qui coupe l'ambiance en fondu.
- **« Surprise-moi »** : ouvre un chapitre non-lu au hasard parmi les favoris.
- **Import/export** de bibliothèque (ou import depuis MAL/AniList).
- **Multi-utilisateur** : mini-classement/activité entre comptes.

> Feature signature recommandée : **détection de cases + ambiance adaptative + ambilight** =
> une **« lecture cinématique »** qu'aucun lecteur (Mihon/Tachiyomi, lecteurs web) n'offre.
