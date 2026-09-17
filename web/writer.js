/**
 * Rédacteur intégré, version navigateur.
 * Il n'écrit que ce que le site contient déjà — nom, prix, description — et ne complète
 * qu'avec des tournures qui n'affirment rien sur le produit. Aucun appel réseau.
 */

const PHRASES = {
  fr: {
    hooks: [
      "Si vous ne deviez en retenir qu'une seule, ce serait celle-ci.",
      "Voici la piece dont on nous parle le plus en ce moment.",
      "Celle-la, on la sort et on ne la range plus.",
      "Il y a une raison pour laquelle celle-ci part la premiere.",
      "Arretez de faire defiler, regardez ca deux secondes.",
      "Cette piece-la, elle change une tenue entiere.",
    ],
    hookTexts: [
      "A NE PAS RATER",
      "LE COUP DE COEUR",
      "CELLE QU'ON GARDE",
      "LA PLUS DEMANDEE",
      "REGARDEZ CA",
      "LA PIECE CLE",
    ],
    detailIntro: ["A retenir", "En bref", "Ce qu'il faut savoir", "Le detail"],
    transitions: ["Voila ce qu'il faut savoir dessus.", "Dans le detail, ca donne ceci."],
    siteHooks: [
      "Prenez trente secondes, on vous montre ce qu'il y a ici.",
      "Vous ne connaissez pas encore cet endroit. Ca vaut le detour.",
      "Voila ce qu'on peut trouver sur ce site.",
      "On vous fait faire le tour, restez jusqu'a la fin.",
      "Il y a de quoi faire ici, on vous montre.",
    ],
    siteHookTexts: ["A DECOUVRIR", "LE TOUR DU PROPRIETAIRE", "CA SE PASSE ICI", "REGARDEZ CA", "TRENTE SECONDES"],
    siteTitle: (brand) => `${brand}, en trente secondes #Shorts`,
    siteSeriesTitle: (position, total, topic, brand) => `${position}/${total} — ${topic} | ${brand} #Shorts`,
    priceLine: (price) => `Elle est affichee a ${price} sur le site.`,
    ctaLines: [
      "Tout est sur le site, le lien est juste en dessous.",
      "Le reste de la selection vous attend sur le site.",
      "Rendez-vous sur le site pour la voir en entier.",
    ],
    ctaTexts: ["LE LIEN EST EN DESSOUS", "A VOIR SUR LE SITE", "C'EST PAR ICI"],
    listHook: (count, what) => `On passe en revue ${count} ${what}, restez jusqu'a la fin.`,
    title: (product, brand) => `${product} — ${brand} #Shorts`,
    seriesTitle: (position, total, product) => `${position} sur ${total} : ${product} #Shorts`,
    description: (product, brand, url) =>
      `${product}, a retrouver chez ${brand}.\n\nToute la selection est sur ${url}`,
    defaultTags: ["selection", "nouveaute", "boutique"],
  },
  en: {
    hooks: [
      "If you only keep one, make it this one.",
      "This is the piece everyone keeps asking about.",
      "You take this one out and it never goes back.",
      "There is a reason this one goes first.",
      "Stop scrolling for two seconds and look at this.",
      "This single piece changes a whole outfit.",
    ],
    hookTexts: [
      "DO NOT MISS THIS",
      "OUR FAVOURITE",
      "THE ONE YOU KEEP",
      "MOST REQUESTED",
      "LOOK AT THIS",
      "THE KEY PIECE",
    ],
    detailIntro: ["Worth knowing", "In short", "What to know", "The detail"],
    transitions: ["Here is what you should know about it.", "Here it is in detail."],
    siteHooks: [
      "Give us thirty seconds and we will show you around.",
      "You do not know this place yet. It is worth a look.",
      "Here is what you can find on this site.",
      "We are taking you through it, stay until the end.",
      "There is a lot here. Let us show you.",
    ],
    siteHookTexts: ["TAKE A LOOK", "THE FULL TOUR", "IT HAPPENS HERE", "LOOK AT THIS", "THIRTY SECONDS"],
    siteTitle: (brand) => `${brand}, in thirty seconds #Shorts`,
    siteSeriesTitle: (position, total, topic, brand) => `${position}/${total} — ${topic} | ${brand} #Shorts`,
    priceLine: (price) => `It is listed at ${price} on the site.`,
    ctaLines: [
      "Everything is on the site, link right below.",
      "The rest of the selection is waiting on the site.",
      "Head to the site to see the full thing.",
    ],
    ctaTexts: ["LINK BELOW", "SEE IT ON THE SITE", "THIS WAY"],
    listHook: (count, what) => `We are going through ${count} ${what}, stay until the end.`,
    title: (product, brand) => `${product} — ${brand} #Shorts`,
    seriesTitle: (position, total, product) => `${position} of ${total}: ${product} #Shorts`,
    description: (product, brand, url) => `${product}, available at ${brand}.\n\nFull selection on ${url}`,
    defaultTags: ["selection", "new in", "shop"],
  },
};

const CURRENCY_SIGNS = { EUR: "€", USD: "$", GBP: "£", CHF: "CHF", CAD: "$" };

const pick = (list, index) => list[index % list.length];

/** Raccourcit sans couper un mot en deux. */
function trimWords(text, max) {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : cut).trim();
}


export function normalize(text) {
  return String(text ?? "")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPrice(raw) {
  let price = normalize(raw);
  for (const [code, sign] of Object.entries(CURRENCY_SIGNS)) {
    price = price.replace(new RegExp(`\\s*\\b${code}\\b`, "i"), ` ${sign}`);
  }
  return price.replace(/(\d)[.,]00\b/g, "$1").replace(/\s+/g, " ").trim();
}

function sentences(text, limit) {
  if (!text) return [];
  return normalize(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12 && sentence.length < 190)
    .slice(0, limit);
}

function shortLabel(title) {
  const clean = normalize(title).replace(/\s*[|–-]\s*.*$/, "");
  return clean.split(/\s+/).slice(0, 5).join(" ").slice(0, 34).toUpperCase();
}

function slugify(input, fallback) {
  const slug = String(input)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function detectLang(site, brief) {
  if (/^en/i.test(site.lang)) return "en";
  if (/^fr/i.test(site.lang)) return "fr";
  return /\b(les|des|une|vid[ée]os?|magasin|boutique|meilleur|fais|tenues?)\b/i.test(brief) ? "fr" : "en";
}

export function requestedCount(brief, fallback = 3) {
  const digits = /\b(\d{1,2})\s*(?:vid[ée]os?|shorts?|clips?)/i.exec(brief);
  const parsed = Number.parseInt(digits?.[1] ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(8, parsed);

  const written = { deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, two: 2, three: 3, four: 4, five: 5 };
  for (const [word, value] of Object.entries(written)) {
    if (new RegExp(`\\b${word}\\b\\s*(?:vid[ée]os?|shorts?|clips?)`, "i").test(brief)) return value;
  }

  // « les 5 meilleures tenues » : un nombre isolé dans la consigne vaut aussi demande.
  const loose = /\b([1-8])\b/.exec(brief);
  if (loose) return Number.parseInt(loose[1], 10);
  return fallback;
}

/**
 * Mots porteurs de sens dans la consigne. Les verbes d'instruction et les
 * articles n'aident pas à choisir un produit : seuls les mots de contenu comptent.
 */
const STOPWORDS = new Set(
  ("fais faire fait video videos vidéo vidéos short shorts clip clips sur les des une " +
    "un le la de du pour avec et en qui que dans mon ma mes notre nos site web page " +
    "auditeur spectateur decouvrir découvrir decouvre présente presente presenter " +
    "présenter parle parler montre montrer mettre avant meilleur meilleure meilleurs " +
    "meilleures top best make about the of for with and my our show tell present " +
    "promote video videos please then also")
    .split(" "),
);

/**
 * Racine grossière d'un mot : « robes » et « robe » doivent se reconnaître,
 * sinon une consigne au pluriel ne retrouve jamais un produit au singulier.
 */
function stem(word) {
  return word
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[sx]$/, "");
}

function wordsOf(text) {
  return normalize(text ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .map(stem);
}

export function briefKeywords(brief) {
  return [
    ...new Set(
      normalize(brief)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word))
        .map(stem),
    ),
  ].filter((word) => word.length > 2);
}

/** À quel point ce contenu correspond-il à ce qui a été demandé ? */
function relevance(product, keywords) {
  if (keywords.length === 0) return 0;
  const title = new Set(wordsOf(product.title));
  const body = new Set(wordsOf(product.description));
  let score = 0;
  for (const word of keywords) {
    if (title.has(word)) score += 3;
    else if (body.has(word)) score += 1;
  }
  return score;
}

function subjectFromBrief(brief, fallback) {
  const match =
    /\b(?:sur|about|des|les|of the|the)\s+(?:\d+\s+)?(?:meilleur(?:e|s|es)?\s+|best\s+|top\s+)?([\p{L}\s]{3,28})/iu.exec(
      brief,
    );
  const captured = match?.[1]?.trim().split(/\s+/).slice(0, 3).join(" ");
  return captured && captured.length > 2 ? captured.toLowerCase() : fallback;
}

/** Couleur d'accent : la teinte la plus franche d'un visuel du site. */
function accentFromBitmap(bitmap) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, 8, 8);
    const { data } = ctx.getImageData(0, 0, 8, 8);

    let best = null;
    for (let offset = 0; offset < data.length; offset += 4) {
      const [r, g, b] = [data[offset] / 255, data[offset + 1] / 255, data[offset + 2] / 255];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lightness = (max + min) / 2;
      if (lightness < 0.12 || lightness > 0.92 || max === min) continue;

      const delta = max - min;
      const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
      let hue;
      if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
      else if (max === g) hue = ((b - r) / delta + 2) / 6;
      else hue = ((r - g) / delta + 4) / 6;
      if (!best || saturation > best.saturation) best = { hue, saturation };
    }
    if (!best || best.saturation < 0.12) return null;
    return `hsl(${Math.round(best.hue * 360)} ${Math.round(Math.min(85, Math.max(62, best.saturation * 100)))}% 56%)`;
  } catch {
    return null;
  }
}

/**
 * Sujets de repli quand le site n'expose aucune fiche produit :
 * d'abord ses titres de section, sinon la page d'accueil prise dans son ensemble.
 * Chaque sujet reçoit ses propres visuels, pour que les vidéos ne se ressemblent pas.
 */
function fallbackSubjects(site, total, brief) {
  const usable = site.images.filter((image) => image.bitmap).map((image) => image.index);
  const share = (position) =>
    usable.length === 0 ? [] : [usable[position % usable.length], usable[(position + 1) % usable.length]];

  const keywords = briefKeywords(brief);
  const sections = (site.sections ?? [])
    .filter((section) => section.title && section.text.length > 40)
    .map((section) => ({ ...section, score: relevance({ title: section.title, description: section.text }, keywords) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, total);

  if (sections.length > 0) {
    return sections.map((section, position) => ({
      title: section.title,
      url: site.url,
      description: section.text,
      imageIndexes: share(position),
    }));
  }

  // Aucun titre exploitable : une seule vidéo, construite sur la présentation du site.
  const pitch = [site.description, site.pageText].filter(Boolean).join(" ").slice(0, 600);
  if (!site.title && !pitch) return [];
  return [
    {
      title: site.title || site.siteName,
      url: site.url,
      description: pitch,
      imageIndexes: share(0),
    },
  ];
}

export function writeCampaign(site, brief, count) {
  const lang = detectLang(site, brief);
  const book = PHRASES[lang];
  const total = count ?? requestedCount(brief);

  // La consigne décide d'abord : un produit qu'elle nomme passe devant un produit
  // simplement bien illustré. À égalité seulement, la richesse de la fiche tranche.
  const keywords = briefKeywords(brief);
  const ranked = [...site.products].sort((a, b) => {
    const wanted = relevance(b, keywords) - relevance(a, keywords);
    if (wanted !== 0) return wanted;
    const richness = (product) =>
      (product.imageIndexes?.length ? 4 : 0) +
      (product.price ? 2 : 0) +
      (product.description && product.description.length > 60 ? 1 : 0);
    return richness(b) - richness(a);
  });

  let selected = ranked.slice(0, total);
  let kind = "product";

  // Beaucoup de sites n'ont pas de fiches produit. Plutôt que d'abandonner, on parle
  // du site lui-même, à partir de ses titres de section puis de son texte.
  if (selected.length === 0) {
    selected = fallbackSubjects(site, total, brief);
    kind = "site";
  }
  if (selected.length === 0) {
    throw new Error(
      `La page de ${site.domain} a été lue, mais elle ne contient ni fiche produit, ni titre, ni texte ` +
        "exploitable. Essayez l'adresse d'une page de contenu — une collection, un catalogue, une page « à propos ».",
    );
  }

  const subject = subjectFromBrief(brief, lang === "fr" ? "pièces" : "pieces");
  const usable = new Set(site.images.filter((image) => image.bitmap).map((image) => image.index));
  const firstBitmap = site.images.find((image) => image.bitmap)?.bitmap;

  const videos = selected.map((product, index) => {
    const available = (product.imageIndexes ?? []).filter((i) => usable.has(i));
    const image = (position) => (available.length > 0 ? pick(available, position) : -1);

    const scenes = [
      {
        narration: pick(kind === "site" ? book.siteHooks : book.hooks, index),
        onScreenText: pick(kind === "site" ? book.siteHookTexts : book.hookTexts, index),
        imageIndex: image(0),
        role: "hook",
      },
      {
        narration: `${normalize(product.title)}.`,
        onScreenText: shortLabel(product.title),
        imageIndex: image(0),
        role: "body",
      },
    ];

    const details = sentences(product.description, 2);
    if (details.length === 0) {
      scenes.push({
        narration: pick(book.transitions, index),
        onScreenText: shortLabel(site.siteName),
        imageIndex: image(1),
        role: "body",
      });
    }
    details.forEach((detail, position) => {
      scenes.push({
        narration: detail,
        onScreenText: pick(book.detailIntro, index + position),
        imageIndex: image(position + 1),
        role: "body",
      });
    });

    if (product.price) {
      const price = formatPrice(product.price);
      scenes.push({
        narration: book.priceLine(price),
        onScreenText: price.toUpperCase(),
        imageIndex: image(0),
        role: "body",
      });
    }

    scenes.push({
      narration: pick(book.ctaLines, index),
      onScreenText: pick(book.ctaTexts, index),
      imageIndex: -1,
      role: "cta",
    });

    if (selected.length > 1 && index === 0 && kind === "product") {
      scenes[0] = {
        narration: book.listHook(selected.length, subject),
        onScreenText: trimWords(`${selected.length} ${subject.toUpperCase()}`, 30),
        imageIndex: scenes[0].imageIndex,
        role: "hook",
      };
    }

    const label = normalize(product.title);
    return {
      slug: slugify(product.title, `video-${index + 1}`),
      concept: label,
      scenes,
      youtubeTitle: (kind === "site"
        ? selected.length > 1
          ? book.siteSeriesTitle(index + 1, selected.length, label, site.siteName)
          : book.siteTitle(site.siteName)
        : selected.length > 1
          ? book.seriesTitle(index + 1, selected.length, label)
          : book.title(label, site.siteName)
      ).slice(0, 98),
      youtubeDescription: book.description(label, site.siteName, site.url),
      hashtags: [slugify(site.siteName, "boutique").replace(/-/g, ""), ...book.defaultTags.slice(0, 2)],
      tags: [label, site.siteName, ...book.defaultTags],
    };
  });

  return {
    language: lang,
    brandName: site.siteName,
    brandSummary: site.description || site.title,
    accentColor: (firstBitmap && accentFromBitmap(firstBitmap)) || "#f43f5e",
    backgroundColor: "#101623",
    videos,
  };
}
