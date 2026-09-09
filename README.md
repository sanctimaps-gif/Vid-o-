# Vid-O

Vous donnez l'adresse de votre site et une consigne en français. Vid-O lit le site, écrit les
scripts, fabrique les vidéos verticales et vous rend des Shorts prêts à être publiés — avec leur
titre, leur description, leurs hashtags et leur miniature.

**Rien n'est payant.** Aucune clé, aucun compte, aucun abonnement n'est nécessaire : le rendu se
fait sur votre machine avec FFmpeg, la voix off passe par edge-tts, et les scripts sont écrits par
un rédacteur intégré qui fonctionne hors ligne. Les rédacteurs plus fins sont eux aussi gratuits —
Ollama en local, ou le palier gratuit de Groq, Google AI Studio, OpenRouter ou Mistral.

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
2. **Écriture.** Le rédacteur reçoit votre consigne et ce qui a été extrait, puis écrit une campagne
   complète : accroche, scènes, voix off, textes incrustés, titre et description YouTube. Il choisit
   quelle photo du site illustre quelle scène, et n'a pas le droit d'inventer un prix ou une
   caractéristique produit qui ne figure pas dans les données extraites. Voir « Le rédacteur » plus
   bas pour choisir lequel.
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
```

Aucun fichier `.env` n'est nécessaire pour démarrer. Copiez `.env.example` vers `.env` seulement
si vous voulez régler quelque chose.

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
| `--writer ollama` | Choisit le rédacteur des scripts (voir ci-dessous) |

`--plan` est pratique pour retoucher un script à la main : ouvrez le `plan.json` d'une campagne,
corrigez une phrase, relancez. Aucun appel au modèle, donc aucun coût.

### Depuis le navigateur

```bash
npm run serve
```

Puis ouvrez `http://localhost:4173`. Vous saisissez l'adresse et la consigne, la progression défile
en direct, et les vidéos s'affichent avec leur titre, leur description et un bouton de
téléchargement.

## Le rédacteur

C'est la seule brique qui pourrait coûter de l'argent, alors elle est interchangeable. En mode
`auto`, Vid-O prend le premier fournisseur **gratuit** disponible sur votre machine, dans cet ordre.

| Rédacteur | Ce qu'il faut | Coût | Qualité |
| --- | --- | --- | --- |
| `ollama` | [Ollama](https://ollama.com) installé, puis `ollama pull llama3.1:8b` | gratuit, hors ligne, sans compte | très bonne |
| `groq`, `gemini`, `openrouter`, `mistral` | une clé du palier gratuit, sans carte bancaire | gratuit dans la limite du quota | très bonne |
| `custom` | `VIDO_LLM_BASE_URL` vers un serveur compatible OpenAI (llama.cpp, LM Studio, vLLM) | selon votre serveur | variable |
| `template` | rien du tout | gratuit, hors ligne | correcte, formulations plus attendues |
| `anthropic` | `ANTHROPIC_API_KEY` | **facturé à l'usage** | la meilleure |

`template` est le filet de sécurité : il compose les scripts à partir du catalogue extrait — nom,
prix, description — avec des tournures qui n'affirment rien sur le produit. Il n'invente donc jamais
de caractéristique, mais il ne trouvera pas d'angle créatif comme le ferait un modèle. C'est ce qui
tourne si vous ne configurez rien.

`anthropic` n'est jamais sélectionné automatiquement, même si la clé est présente : il faut le
demander avec `--writer anthropic` ou `VIDO_WRITER=anthropic`.

Pour voir ce qui est utilisable chez vous :

```bash
npm run doctor
```

## Musique de fond

Déposez vos fichiers `.mp3` dans `assets/music/`. Vid-O en attribue un par vidéo, l'atténue
automatiquement dès que la voix parle et le fait descendre en fin de vidéo. Sans fichier, les
vidéos gardent la seule voix off. Aucune musique n'est fournie : n'utilisez que des pistes dont
vous détenez les droits pour la publication.

## Réglages

Tout se règle dans `.env` (voir `.env.example`) :

- `VIDO_WRITER` — rédacteur des scripts, `auto` par défaut.
- `VIDO_OLLAMA_MODEL`, `OLLAMA_HOST` — le modèle local et son adresse.
- `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY` — paliers gratuits.
- `VIDO_TTS`, `VIDO_EDGE_VOICE`, `ELEVENLABS_API_KEY`, `VIDO_ELEVENLABS_VOICE_ID` — la voix off.
- `VIDO_FONT_BOLD`, `VIDO_FONT_REGULAR` — les polices d'incrustation, détectées automatiquement.
- `VIDO_MAX_PAGES` — nombre de pages produit explorées.
- `VIDO_RESPECT_ROBOTS` — à ne passer à `false` que sur un site qui vous appartient.

## Vérifier le rendu sans rien installer de plus

```bash
npm run smoke
```

Fabrique une vidéo de démonstration à partir d'images générées localement. Ni site distant, ni
appel à un modèle : c'est le moyen le plus rapide de valider votre installation FFmpeg et vos
polices.

## Ce que Vid-O ne fait pas

- Il ne publie pas à votre place : les fichiers sont produits, la mise en ligne reste manuelle.
- Il n'invente pas d'images. S'il n'y a aucune photo exploitable sur le site, les scènes sont
  fabriquées sur un fond aux couleurs de la marque.
- Relisez toujours les scripts avant publication : ce sont vos allégations commerciales.
