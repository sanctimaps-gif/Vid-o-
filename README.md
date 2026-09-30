# Vid-O

Vous donnez l'adresse de votre site et une consigne en français. Vid-O lit le site, écrit les
scripts, fabrique les vidéos verticales et vous rend des Shorts prêts à être publiés — avec leur
titre, leur description, leurs hashtags et leur miniature.

**Rien n'est payant.** Aucune clé, aucun compte, aucun abonnement n'est nécessaire : le rendu se
fait sur votre machine avec FFmpeg, la voix off passe par edge-tts, et les scripts sont écrits par
un rédacteur intégré qui fonctionne hors ligne. Les rédacteurs plus fins sont eux aussi gratuits —
Ollama en local, ou le palier gratuit de Groq, Google AI Studio, OpenRouter ou Mistral.

**Essayez sans rien installer :** [sanctimaps-gif.github.io/Vid-o-](https://sanctimaps-gif.github.io/Vid-o-/)
fabrique les vidéos directement dans votre navigateur, y compris sur téléphone, et poursuit le
montage quand la page passe en arrière-plan.

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

## Deux façons de faire une vidéo

**Composer** (`vido "<url>" "<consigne>"`, et la page navigateur) : Vid-O lit le site, en tire
des textes et des images, écrit des scripts et monte des plans avec sous-titres et voix off.

**Filmer** (`vido tour <url>`) : Vid-O ouvre votre site dans un vrai navigateur et s'en sert
devant la caméra — la carte qu'on déplace, le repère qu'on ouvre, la page qu'on parcourt — puis
ajoute une carte de fin à vos couleurs et votre musique. C'est le mode à utiliser pour montrer
une **interface en fonctionnement** : une carte interactive, une application. Aucune capture
d'écran fixe ne remplace le mouvement réel de votre site.

```bash
npm install playwright && npx playwright install chromium
npm run tour -- "https://ma-carte.fr" --seconds 20 --music ./assets/music/calme.mp3
```

> **La page navigateur ne peut pas filmer.** Le JavaScript d'un site n'a pas le droit de lire les
> pixels d'un autre site : ni iframe, ni canvas, aucune méthode. Filmer exige un navigateur qu'on
> pilote, donc un ordinateur — ou l'action GitHub ci-dessous, qui le fait pour vous.

### Depuis un téléphone, sans rien installer

Le dépôt contient une action GitHub « Visite filmée ». Ouvrez l'onglet **Actions** du dépôt,
choisissez-la, saisissez l'adresse de votre site et lancez-la : GitHub ouvre le navigateur à votre
place et vous rend le MP4 dans les fichiers joints à l'exécution.

| | Composer | Filmer |
| --- | --- | --- |
| Ce qu'on voit | vos visuels, vos textes, des plans montés | votre site en train d'être utilisé |
| Sous-titres et voix off | oui | non, musique seule |
| Convient à | une boutique, un catalogue, un site de contenu | une carte, une application, toute interface |
| Où ça tourne | navigateur ou ordinateur | ordinateur, ou l'action GitHub |

## Comment ça marche

1. **Lecture du site.** Vid-O explore votre site : catalogue Shopify ou WooCommerce quand il y en a
   un, sinon les fiches atteintes depuis la page d'accueil. Il ne cherche pas que des produits :
   les pages d'un même dossier qui ne diffèrent que par leur nom — `/saints/…`, `/lieux/…`,
   `/f/…` — forment un catalogue, et chacune devient un sujet présentable. Il en tire les noms,
   les descriptions, les prix s'il y en a et les photos, et respecte votre `robots.txt`.
   Une fiche sans prix est présentée, pas vendue : le vocabulaire de boutique est réservé aux
   pages qui affichent un prix, et chaque vidéo ouvre sur la page de son propre sujet.
2. **Visite du site** (page navigateur). Vid-O photographie la page d'accueil, puis deux autres
   pages du site : la vidéo suit ce parcours, adresse affichée à l'écran. Quand la page se
   construit toute seule après son affichage — **carte interactive**, application JavaScript —
   il le reconnaît et attend qu'elle ait fini : il mesure sur la capture elle-même si la carte
   est dessinée, et redemande plus tard tant qu'elle ne l'est pas. Sans cela on filmerait le
   cadre vide qui précède la carte. C'est quelques dizaines de secondes de plus, une seule fois.
3. **Écriture.** Le rédacteur reçoit votre consigne et ce qui a été extrait, puis écrit une campagne
   complète : accroche, scènes, voix off, textes incrustés, titre et description YouTube. Seul le
   texte fait pour être lu est retenu : le code de la page, les menus et les pieds de page en sont
   retirés avant écriture, sans quoi la voix off finirait par les lire. Il choisit
   quelle photo du site illustre quelle scène, et n'a pas le droit d'inventer un prix ou une
   caractéristique produit qui ne figure pas dans les données extraites. Voir « Le rédacteur » plus
   bas pour choisir lequel.
4. **Fabrication.** La vidéo s'ouvre sur votre page réelle, dans une fenêtre de navigateur qui
   défile, puis enchaîne vos visuels plein cadre en 1080x1920 : léger zoom, sous-titres calés sur la
   voix off, votre couleur de marque, une barre de progression, et votre nom de domaine affiché en
   permanence. Voix off, musique et normalisation du son sont assemblées, puis le tout est encodé
   en MP4 H.264/AAC.

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

### Filmer une visite

```bash
npm run tour -- "https://ma-carte.fr" --seconds 20 --music ./musique.mp3
```

| Option | Effet |
| --- | --- |
| `--seconds 20` | Durée de la visite, avant la carte de fin |
| `--width 540` | Largeur du viewport en pixels CSS ; 540 donne une mise en page de téléphone |
| `--music ./x.mp3` | Musique de fond, un fichier dont vous détenez les droits |
| `--search "Saint"` | Ce qu'on tape dans la recherche du site ; par défaut, un mot déduit du site |
| `--tagline "…"` | Phrase de la carte de fin ; par défaut, la description de votre site |
| `--no-end-card` | Termine sur le site, sans carte de fin |

Vid-O repère le conteneur de carte (Leaflet, Mapbox, MapLibre, OpenLayers), attend qu'il ait fini
de se dessiner, puis **se sert du site** : il déplace la carte, zoome, ouvre un repère, va chercher
la recherche — y compris derrière un menu —, **tape la requête lettre par lettre**, laisse la liste
se remplir et ouvre un résultat. C'est une démonstration de ce que votre site sait faire, pas
seulement une vue de ce à quoi il ressemble. Sans carte, il fait la même chose puis parcourt la
page.

Le mot recherché est déduit du site lui-même : celui qui revient le plus souvent en tête de ses
intitulés, de ses repères ou de leurs `title`. Une requête inventée ne ramènerait rien, et une
démonstration qui affiche « aucun résultat » dessert le site. `--search` permet de l'imposer.

La carte de fin reprend le nom, la description et le visuel déclarés par votre site.

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

## La mémoire

Sur la page navigateur, chaque vidéo est écrite dans le stockage hors ligne du navigateur
(IndexedDB) **dès qu'elle est prête**, pas à la fin du lot. Conséquences :

- fermer l'onglet, recharger la page ou manquer de mémoire au montage de la quatrième ne fait plus
  perdre les trois premières ;
- au retour, la section **Mémoire** les réaffiche, rejouables et téléchargeables ;
- une génération qui n'est pas allée au bout est signalée, avec le nombre de vidéos sauvées et un
  bouton qui repose l'adresse et la consigne pour la relancer.

Les vidéos ne quittent jamais l'appareil. Les vingt-quatre dernières sont gardées ; au-delà, les
plus anciennes cèdent la place, et « Tout effacer » vide la mémoire d'un coup. Si le stockage est
refusé — navigation privée, place insuffisante — la génération se poursuit et Vid-O prévient que
les vidéos ne survivront pas au rechargement.

Sur la version ordinateur, la mémoire est le dossier de sortie : les fichiers y restent, avec leur
`plan.json` et leur `A-POSTER.md`.

## Un modèle sans clé et sans compte

Sur la page navigateur, le sélecteur **« Qui écrit les scripts »** propose une **IA sur votre
appareil**. Aucune clé, aucun compte, aucun serveur : le modèle — Qwen 1.5B ou Gemma 2B — est
téléchargé une seule fois puis gardé en cache, et il travaille sur le processeur graphique de
l'appareil via WebGPU. Ni votre consigne ni le contenu de votre site ne quittent le navigateur.

**ChatGPT et Gemini ne s'utilisent pas sans clé.** Leurs adresses refusent toute requête non
authentifiée, et les passerelles qui prétendent le contraire relaient votre texte chez un tiers
inconnu, sans garantie ni lendemain. Vid-O n'en utilise aucune : pour se passer de compte, le
modèle tourne chez vous.

Ce que cela coûte, honnêtement :

- **1,1 à 1,6 Go** au premier usage. À faire en Wi-Fi, gardé ensuite sur l'appareil.
- **WebGPU** : Chrome et Edge l'ont, Safari depuis iOS 18, Firefox derrière une option. Vid-O
  interroge la carte graphique avant de promettre quoi que ce soit, et le dit quand elle manque.
- Un petit modèle écrit moins bien qu'un grand. Si la qualité prime, la clé d'un palier gratuit
  reste supérieure — c'est le troisième choix du sélecteur.

Dans tous les cas, l'échec est sans conséquence : le rédacteur intégré prend le relais et les
vidéos sont produites quand même.

Le modèle reçoit aussi **ce que la vidéo montrera** : les pages du site qui ont été filmées, et le
nombre d'images exploitables. Le texte parle donc de ce qui est à l'écran, au lieu d'annoncer une
photo qui n'existe pas.

## Musique de fond

**Sur la page navigateur**, aucune musique n'est ajoutée par défaut. Vous pouvez fournir votre
propre fichier, ou demander une composition à la volée — nappe, arpège, basse et percussions selon
l'ambiance choisie. Dans ce dernier cas rien n'est téléchargé, donc aucune réclamation de droits
n'est possible sur ce que vous publiez. La musique s'efface sous chaque phrase de la voix off.

**Sur la version ordinateur**, déposez vos fichiers `.mp3` dans `assets/music/`. Vid-O en attribue
un par vidéo, l'atténue dès que la voix parle et le fait descendre en fin de vidéo. Sans fichier,
les vidéos gardent la seule voix off. Aucune musique n'est fournie : n'utilisez que des pistes dont
vous détenez les droits.

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

## Les deux versions

| | Navigateur ([la page](https://sanctimaps-gif.github.io/Vid-o-/)) | Ordinateur (ce dépôt) |
| --- | --- | --- |
| Installation | aucune | Node.js + FFmpeg |
| Lecture du site | via un relais public quand le site refuse l'accès direct | directe |
| Voix off | oui, par un service de synthèse gratuit ; sous-titres seuls s'il ne répond pas | oui, edge-tts, meilleure qualité |
| Musique de fond | aucune par défaut ; votre fichier, ou une composition à la demande | vos fichiers dans `assets/music/` |
| Suivi de la consigne | mots-clés de la consigne, ou un vrai modèle avec une clé gratuite | rédacteur intégré, Ollama, paliers gratuits, Claude |
| Page du site à l'écran | trois pages capturées, plein écran, qui défilent ; attente du chargement sur les sites à carte | visuels du site |
| Illustration | visuels du site, vos propres images, et les vues des pages quand le site n'a pas de photos | visuels du site |
| Sortie | MP4 ou WebM selon le navigateur | MP4 H.264/AAC |
| Pendant le montage | continue en arrière-plan, écran maintenu allumé | c'est un programme, rien à surveiller |
| Rédacteur | intégré | intégré, Ollama, paliers gratuits, Claude |

Le code de la page navigateur est dans `web/` et `index.html` ; celui de la version ordinateur
dans `src/`. Ce sont deux moteurs de rendu différents — canvas d'un côté, FFmpeg de l'autre — qui
suivent la même charte visuelle.

## Ce que Vid-O ne fait pas

- Il ne publie pas à votre place : les fichiers sont produits, la mise en ligne reste manuelle.
- Il n'invente pas d'images. Quand le site n'expose aucune photo — c'est le cas d'une carte ou
  d'une application, dont la page ne contient rien à récupérer — les vues prises pendant la visite
  servent de visuels, chaque plan parcourant une portion différente d'une page réelle. S'il n'y a
  ni photo ni capture, les scènes sont fabriquées sur un fond aux couleurs de la marque.
- La capture de vos pages est demandée à des services gratuits en parallèle. Ils fabriquent
  l'image à la demande et répondent souvent d'abord une image d'attente : Vid-O la reconnaît à son
  uniformité, la refuse et redemande. Sur un site à carte, seuls les services capables d'attendre
  avant de déclencher sont interrogés, et Vid-O vérifie sur l'image que la carte est dessinée
  avant de l'accepter. Si aucun n'aboutit, la vidéo montre une page reconstituée avec vos vrais
  textes et visuels.
- Il ne clique pas à votre place. Il ouvre les pages et attend qu'elles soient dessinées ; il ne
  déroule pas un menu, ne remplit pas un formulaire et n'entre pas dans une zone qui demande une
  connexion.
- Relisez toujours les scripts avant publication : ce sont vos allégations commerciales.
