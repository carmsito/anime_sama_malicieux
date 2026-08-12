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

---

## 3. Dynamic comic / « lecture cinématique » — rendre la lecture VIVANTE (détail)

Transformer des planches statiques en une expérience semi-animée. Brique de base : la
**détection des cases (panels)** par page (vision : détection des gouttières/contours, sans
ML au départ ; option modèle ensuite). Elle débloque tout le reste.

### Caméra & mouvement
- **Guided View 2.0** : avance case par case, mais la caméra **glisse et zoome en douceur**
  d'une case à l'autre (easing) au lieu de sauter.
- **Ken Burns par case** : léger pan/zoom lent PENDANT qu'une case est à l'écran → une image
  fixe « respire ».
- **Transitions cinématiques** : whip-pan rapide sur l'action, fondu lent sur le calme —
  choisi selon le **score d'action** du classifieur.
- **Pacing adaptatif** : cases dramatiques tenues plus longtemps ; pages denses lues plus
  lentement (durée dérivée de la taille/du nombre de cases).
- **Focus / spotlight** : assombrit tout sauf la case active.
- **Parallaxe 2.5D** : séparer bulles/avant-plan du fond → légère profondeur au scroll ou au
  **gyroscope** du téléphone (on incline, ça bouge).
- **Bulles séquencées** : révéler les bulles dans l'ordre de lecture avec un petit pop timé.

### Le monde qui vit (ambiance)
- **Soundscape adaptatif** (proto étudié) : décor par scène + couche action qui suit le score,
  crossfades Web Audio.
- **SFX réactifs** : one-shot (impact, whoosh, pluie qui monte) déclenché sur la révélation
  d'une grosse case d'action.
- **Ambilight / halo** : glow autour de la page repris des **couleurs dominantes de la case**,
  qui change de case en case. Peu coûteux, gros effet.
- **Tinte dynamique** : fond/tinte du reader qui épouse le mood de la scène (coucher de soleil
  chaud, nuit froide).
- **Haptique** : tap léger sur les cases d'impact (mobile).
- **Couche musique** optionnelle sous l'ambiance, calée sur la scène.

### Micro-vie partout (petits gains)
- **Covers animées** : parallaxe/inclinaison subtile dans la bibliothèque (gyro/hover).
- **Overlay météo** : si décor = pluie, fines particules animées + son (via le label du
  classifieur).
- **Respiration** de la case courante (oscillation d'échelle imperceptible).

### Comment ça s'assemble (pipeline)
Détection de cases → métadonnées par case (bbox, score d'action, label décor via le
classifieur) → le reader joue une **« piste caméra »** à travers les cases avec pacing +
ambiance + ambilight + SFX. C'est un **mode motion-comic auto-play** (bouton « Cinéma »),
distinct de la lecture normale.

### Ordre de construction conseillé (MVP → riche)
1. **MVP** : détection de cases (CV, sans ML) → Guided View avec pan/zoom easé + focus dimming
   + ambilight. À lui seul, ça « prend vie ».
2. **+** Ken Burns par case + couche ambiance adaptative + pacing.
3. **+** parallaxe/gyro, SFX one-shots, haptique, overlay météo.

> Réutilise l'existant : le **classifieur d'ambiance** fournit déjà scène + score d'action →
> il pilote le pacing, l'ambilight et les déclencheurs SFX. Le gros nouveau chantier =
> la **détection de cases**.
