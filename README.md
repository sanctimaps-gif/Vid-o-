# Vid-O

Vous donnez l'adresse de votre site et une consigne en français. Vid-O lit le site, écrit les
scripts, fabrique les vidéos verticales et vous rend des Shorts prêts à être publiés — avec leur
titre, leur description, leurs hashtags et leur miniature.

```
vido "https://ma-boutique.fr" "fais découvrir à l'auditeur les 5 meilleures tenues du magasin, une vidéo par tenue"
```

```
out/ma-boutique-fr-2026-09-091132/
├── 01-veste-lin.mp4        1080x1920, 28 s, prêt à poster
├── 01-veste-lin.jpg        miniature
├── 01-veste-lin.json       titre, description, tags, script scène par scène
├── 02-robe-nuit.mp4
├── ...
├── plan.json               les scripts, réutilisables
└── A-POSTER.md             tous les titres et descriptions à copier-coller
```

## Comment ça marche

1. **Lecture du site.** Vid-O explore votre site : catalogue Shopify ou WooCommerce quand il y en a
   un, sinon les fiches produit trouvées depuis la page d'accueil. Il en tire les noms, les prix,
   les descriptions et les photos, et respecte votre `robots.txt`.
2. **Écriture.** Claude reçoit votre consigne et ce qui a été extrait, puis écrit une campagne
   complète : accroche, scènes, voix off, textes incrustés, titre et description YouTube. Il choisit
   lui-même quelle photo du site illustre quelle scène, et n'a pas le droit d'inventer un prix ou
   une caractéristique produit qui ne figure pas dans les données extraites.
3. **Fabrication.** Chaque scène est montée en 1080x1920 : la photo produit posée sur son propre
   flou plein cadre, un léger zoom, les sous-titres calés sur la voix off, votre couleur de marque,
   une barre de progression. Voix off, musique et normalisation du son sont assemblées, puis le tout
   est encodé en MP4 H.264/AAC.

## Installation

Il faut Node.js 20 ou plus, et FFmpeg.

```bash
git clone https://github.com/sanctimaps-gif/Vid-o-.git
cd Vid-o-
npm install
cp .env.example .env    # puis renseignez ANTHROPIC_API_KEY
```

FFmpeg :

```bash
sudo apt install ffmpeg fonts-dejavu-core   # Debian / Ubuntu
brew install ffmpeg                         # macOS
```

Voix off gratuite (recommandée, voix neuronales de Microsoft Edge) :

```bash
pipx install edge-tts    # ou : pip install edge-tts
```

Vérifiez que tout est en place :

```bash
npm run doctor
```

## Utilisation

### En ligne de commande

```bash
npm run dev -- "https://ma-boutique.fr" "fais 5 vidéos sur les 5 meilleures tenues du magasin"
```

Après un `npm run build`, la commande `vido` est disponible directement.

| Option | Effet |
| --- | --- |
| `--count 5` | Force le nombre de vidéos (sinon il est déduit de votre consigne) |
| `--out ./out` | Dossier de sortie |
| `--tts edge\|elevenlabs\|none` | Fournisseur de voix off |
| `--voice fr-FR-HenriNeural` | Voix à utiliser |
| `--music ./assets/music` | Dossier de musiques de fond |
| `--plan plan.json` | Refabrique les vidéos depuis un plan existant, sans rappeler le modèle |

`--plan` est pratique pour retoucher un script à la main : ouvrez le `plan.json` d'une campagne,
corrigez une phrase, relancez. Aucun appel au modèle, donc aucun coût.

### Depuis le navigateur

```bash
npm run serve
```

Puis ouvrez `http://localhost:4173`. Vous saisissez l'adresse et la consigne, la progression défile
en direct, et les vidéos s'affichent avec leur titre, leur description et un bouton de
téléchargement.

## Musique de fond

Déposez vos fichiers `.mp3` dans `assets/music/`. Vid-O en attribue un par vidéo, l'atténue
automatiquement dès que la voix parle et le fait descendre en fin de vidéo. Sans fichier, les
vidéos gardent la seule voix off. Aucune musique n'est fournie : n'utilisez que des pistes dont
vous détenez les droits pour la publication.

## Réglages

Tout se règle dans `.env` (voir `.env.example`) :

- `VIDO_MODEL` — modèle utilisé pour écrire les scripts, `claude-opus-5` par défaut.
- `VIDO_TTS`, `VIDO_EDGE_VOICE`, `ELEVENLABS_API_KEY`, `VIDO_ELEVENLABS_VOICE_ID` — la voix off.
- `VIDO_FONT_BOLD`, `VIDO_FONT_REGULAR` — les polices d'incrustation, détectées automatiquement.
- `VIDO_MAX_PAGES` — nombre de pages produit explorées.
- `VIDO_RESPECT_ROBOTS` — à ne passer à `false` que sur un site qui vous appartient.

## Vérifier le rendu sans clé API

```bash
npm run smoke
```

Fabrique une vidéo de démonstration à partir d'images générées localement. Ni site distant, ni
appel au modèle : c'est le moyen le plus rapide de valider votre installation FFmpeg et vos polices.

## Ce que Vid-O ne fait pas

- Il ne publie pas à votre place : les fichiers sont produits, la mise en ligne reste manuelle.
- Il n'invente pas d'images. S'il n'y a aucune photo exploitable sur le site, les scènes sont
  fabriquées sur un fond aux couleurs de la marque.
- Relisez toujours les scripts avant publication : ce sont vos allégations commerciales.
