# Découpage dynamique — documentation d'intégration

## Contexte

Le découpage actif dans `split_manga.py` utilise une **hauteur fixe de 1878px** (fonction `split_fixed`).

Cette valeur a été calibrée sur **Katekyo Hitman Reborn — édition Glénat FR** :
tous les fichiers sources téléchargés étaient des multiples exacts de 1878px
(7512 / 9390 / 11268 / 13146px), ce qui a confirmé que 1878px est la hauteur
réelle d'une page dans ce scan.

La logique dynamique (commentée en bas de `split_manga.py`) détecte
automatiquement les séparateurs sans connaître la hauteur à l'avance.
Elle est utile si un autre manga a une hauteur de page inconnue ou variable.

---

## Principe de la détection dynamique

1. **Luminosité par ligne** — chaque ligne de pixels est réduite à 1px de large
   et sa luminosité moyenne est calculée (ImageMagick, espace niveaux de gris).

2. **Zones blanches** (`threshold > 240`, run ≥ 25px) — espaces blancs entre pages.

3. **Zones sombres** (`threshold < 90`, run ≥ 25px) — bannières titre (ex. le
   bandeau diagonal « KATEKYO HITMAN REBORN » qui sépare des sections).

4. **Fusion des zones proches** (gap ≤ 200px) — regroupe les sous-zones
   adjacentes en un seul séparateur logique.

5. **Coupure au milieu** de chaque zone fusionnée → liste de points de coupe.

6. **Filtre taille minimale** (`min_page`, défaut 300px) — supprime les coupures
   qui produiraient des sections trop petites (parasites).

7. **Coupure secondaire** — si une section résultante dépasse `max_ratio = 1.8`
   (hauteur > 1.8× la largeur), analyse de la marge droite pour détecter la fin
   de la première page via sa zone de numérotation blanche.

---

## Comment l'activer

### Option A — Remplacer `split_fixed` par la détection dynamique dans le scraper

Dans `anime-sama.py`, la fonction `process_chapter_epub` appelle `split_fixed`.
Pour basculer en dynamique, décommenter les fonctions dans `split_manga.py`
et remplacer dans `anime-sama.py` :

```python
# Avant (fixe)
from split_manga import split_fixed
pages = split_fixed(str(source), tmp, page_height=page_height)

# Après (dynamique)
from split_manga import split_image
split_image(str(source), str(tmp), min_page=300)
pages = sorted(tmp.glob("*.jpg"), key=lambda p: int(p.stem))
```

### Option B — Détection automatique de la hauteur de page

Détecter la hauteur sur la première image du chapitre, puis utiliser `split_fixed`
pour les suivantes (meilleur des deux approches) :

```python
from split_manga import get_dimensions, split_fixed
# from split_manga import compute_cuts  # décommenter dans split_manga.py

def detect_page_height(first_img: Path) -> int:
    """Détecte la hauteur d'une page via la première image du chapitre."""
    w, h, cuts = compute_cuts(str(first_img))
    if len(cuts) > 2:
        return cuts[1]  # hauteur de la première page détectée
    return h  # image déjà au bon format

# Utilisation
page_h = detect_page_height(source_files[0])
for source in source_files:
    pages = split_fixed(str(source), tmp, page_height=page_h)
```

---

## Paramètres à calibrer selon le manga

| Paramètre | Défaut | Rôle |
|-----------|--------|------|
| `threshold` zones blanches | 240 | Sensibilité aux séparateurs clairs |
| `threshold` zones sombres | 90 | Sensibilité aux bannières sombres |
| `min_run` | 25px | Largeur minimale d'un séparateur valide |
| `merge_gap` | 200px | Distance max pour fusionner deux zones |
| `min_page` | 300px | Hauteur minimale d'une page en sortie |
| `max_ratio` | 1.8 | Ratio H/W au-delà duquel chercher une coupure secondaire |

---

## Valeur par défaut 1878px

`split_fixed` utilise **1878px** comme gabarit universel.
Si un manga a une hauteur de page différente, passer `--page-height N` en CLI
ou le paramètre `page_height=N` dans le code.

```bash
python3 split_manga.py image.jpg dossier/ --page-height 1900
```
