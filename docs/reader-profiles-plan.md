# Plan — Profils de lecture + panneau ⚙️ + zoom pincement

> Statut : **CONCEPTION (plan validé, pas encore implémenté)**.
> Décisions prises : stockage **backend synchronisé par compte** ; on livrera **l'ensemble
> en une passe conçue** (panneau + profils + pincement), après ce plan.

## 1. Vision
Un lecteur **épuré** : plus de boutons éparpillés, tout est centralisé dans un **rouage ⚙️**
qui ouvre un panneau stylé (façon NeoReader). Ce qui s'affiche dans le panneau est décidé par
le **profil de lecture** actif. Les profils sont des **presets nommés, custom, par utilisateur,
synchronisés par compte**. Un profil `default` a tout activé. Chaque utilisateur peut avoir un
**profil par défaut**. On ajoute aussi un **geste de zoom** (double-tap / pincement / les deux).

## 2. Existant (base sur laquelle on construit)
- `app/front/src/readerSettings.js` — réglages **par utilisateur** (localStorage, clé `reader_settings_<uid>`) :
  - `buttons` : 7 boutons affichables/masquables — `scrollnav, fitwidth, fullscreen, flip, autoscroll, scale, sensitivity`.
  - Plages de valeurs custom : `scaleLevels`, `sensLevels`, `speedLevels` (+ `SCALE/SENS/SPEED_CHOICES`).
  - `autoEdgePause`.
- `app/front/src/pages/Settings.jsx` — page où l'utilisateur coche les boutons visibles + choisit les plages.
- `app/front/src/pages/EpubReader.jsx` — barre d'outils qui affiche les boutons activés + cycle les valeurs ; **zoom = double-tap** (pas de pincement).
- **Liaison connue** : `autoscroll` (défilement auto) dépend de `speedLevels` (vitesse). Les deux sont liés.

## 3. Modèle de données — un « profil »
```jsonc
{
  "id": "p1",
  "name": "Épuré",
  "visible": {              // quelles options apparaissent dans le panneau (fullscreen TOUJOURS visible)
    "scrollnav": false, "fitwidth": true, "flip": false,
    "autoscroll": false, "scale": true, "sensitivity": false
  },
  "values": {               // valeurs AUTORISÉES quand l'option est visible
    "scaleLevels": [100, 50],
    "sensLevels":  [1, 2, 3],
    "speedLevels": [20, 70, 160]
  },
  "defaults": {             // état initial à l'ouverture d'une lecture avec ce profil
    "fitwidth": false, "flip": true, "scale": 100, "sens": 1,
    "autoscroll": false, "speed": 70, "autoEdgePause": 0
  },
  "zoomGesture": "pinch"    // "doubletap" | "pinch" | "both"
}
```
Store **par utilisateur** :
```jsonc
{
  "activeId": "p1",         // profil courant (dernier sélectionné)
  "defaultId": "default",   // profil appliqué à une NOUVELLE lecture
  "profiles": { "default": { …tout visible… }, "p1": { … } }
}
```
- **`default`** = le « all » : toutes les options visibles + plages complètes. Non supprimable (fallback).
- Création / duplication / renommage / suppression des autres profils.

## 4. Backend (synchronisé par compte)
- **Stockage** : 1 blob JSON par utilisateur. Le plus simple : réutiliser le pattern par-user
  existant (comme `reading_progress`/`favorites`) → table `reader_profiles (user_id TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`.
- **Endpoints** (auth `get_current_user`) :
  - `GET  /api/me/reader-profiles` → renvoie le blob (seed `default` au 1er appel).
  - `PUT  /api/me/reader-profiles` → sauvegarde le blob complet (CRUD profils + activeId/defaultId).
- **Migration** : au 1er chargement, si l'utilisateur a d'anciens réglages `localStorage`
  (`reader_settings_<uid>`), on en fait un profil « Perso » (client lit le local → PUT), puis on
  bascule sur le backend comme source de vérité.
- **Isolation** : tout est clé par `user_id` → aucun impact entre comptes.

## 5. Frontend
### 5.1 Lecteur — panneau ⚙️
- La barre d'outils actuelle → un seul bouton **⚙️** (+ **plein écran** qui reste toujours visible).
- Clic ⚙️ → **panneau** (bottom-sheet mobile / modal desktop), stylé, qui affiche **uniquement**
  les options `visible` du profil actif :
  - Échelle (cycle sur `values.scaleLevels`), Sensibilité (`sensLevels`),
  - Défilement auto + Vitesse (`speedLevels`) — **groupés** (voir §6),
  - Fit-largeur, Animation page, Molette : toggles,
  - **Geste de zoom** : double-tap / pincement / les deux.
- **Sélecteur de profil** en haut du panneau (chips/liste) → change tout le set à la volée.
### 5.2 Page Réglages — gestionnaire de profils (par user)
- Liste des profils : créer / dupliquer / renommer / supprimer ; définir le **profil par défaut**.
- Éditeur d'un profil : cocher les options **visibles** + choisir les **valeurs autorisées**
  (grilles de cases pour scale/sens/speed) + `defaults` + `zoomGesture`.
- `default` : tout visible, non supprimable.

## 6. Options liées (garde-fous)
- **auto-scroll ⇄ vitesse** : si `autoscroll` est visible, il faut ≥ 1 `speedLevels`
  (sinon la vitesse est fixe). L'éditeur **interdit** « autoscroll visible + 0 vitesse ».
- **fit-largeur ⇄ échelle/zoom** : fit-largeur = mode défilement ; échelle/zoom = mode paginé.
  On documente/verrouille les combinaisons incohérentes.

## 7. Zoom : pincement + toggle
- Implémenter le **pinch** (tactile 2 doigts → scale) — absent aujourd'hui.
- `zoomGesture` par profil : `doubletap` / `pinch` / `both`. On garde le double-tap existant,
  on ajoute le pinch, et le profil décide lequel est actif.

## 8. Roadmap d'implémentation (une passe conçue, en étapes)
- **A. Backend** : table `reader_profiles` + endpoints GET/PUT + seed `default` + migration localStorage.
- **B. Panneau ⚙️** : lit le profil actif, plein écran persistant, sélecteur de profil.
- **C. Gestionnaire de profils** (page Réglages) : CRUD + éditeur visible/valeurs + profil par défaut.
- **D. Pincement + toggle** de geste de zoom.
- **E. Polish** : styles NeoReader, transitions, responsive.

## 9. Questions à trancher (au démarrage de la conception détaillée)
1. Profil **par manga** (override) ou seulement par user pour la v1 ? (Proposé : par user d'abord, override manga en extension.)
2. `activeId` persisté **global** vs **par manga** ? (Proposé : global v1.)
3. Le profil `default` est-il **éditable** (valeurs) ou strictement tout-activé/verrouillé ?
4. Style du panneau : bottom-sheet plein largeur mobile + modal centré desktop ?
5. Faut-il un **profil par appareil** en plus (ex. tél vs PC) ? (Le backend synchronise ; à voir si on veut une notion d'appareil.)
