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

function subjectFromBrief(brief, fallback) {
  const match =
    /\b(?:sur|about|des|les|of the|the)\s+(?:\d+\s+)?(?:meilleur(?:e|s|es)?\s+|best\s+|top\s+)?([\p{L}\s]{3,28})/iu.exec(
      brief,
    );
  const captured = match?.[1]?.trim();
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

export function writeCampaign(site, brief, count) {
  const lang = detectLang(site, brief);
  const book = PHRASES[lang];
  const total = count ?? requestedCount(brief);

  const ranked = [...site.products].sort((a, b) => {
    const score = (product) =>
      (product.imageIndexes?.length ? 4 : 0) +
      (product.price ? 2 : 0) +
      (product.description && product.description.length > 60 ? 1 : 0);
    return score(b) - score(a);
  });

  const selected = ranked.slice(0, total);
  if (selected.length === 0) {
    throw new Error(
      "Aucune fiche produit exploitable n'a été trouvée. Essayez l'adresse d'une page de collection " +
        "ou de catalogue plutôt que la page d'accueil.",
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
        narration: pick(book.hooks, index),
        onScreenText: pick(book.hookTexts, index),
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

    if (selected.length > 1 && index === 0) {
      scenes[0] = {
        narration: book.listHook(selected.length, subject),
        onScreenText: `${selected.length} ${subject.toUpperCase()}`.slice(0, 30),
        imageIndex: scenes[0].imageIndex,
        role: "hook",
      };
    }

    const label = normalize(product.title);
    return {
      slug: slugify(product.title, `video-${index + 1}`),
      concept: label,
      scenes,
      youtubeTitle: (selected.length > 1
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
