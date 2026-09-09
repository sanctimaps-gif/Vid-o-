import type { PlanOptions, Writer } from "../prompt.js";
import type { CampaignPlan, Scene, SiteProduct, SiteSnapshot, VideoPlan } from "../../types.js";
import { normalizeTypography, slugify, truncate } from "../../util/text.js";
import { dominantColor } from "../../render/visuals.js";

/**
 * Rédacteur hors ligne : aucun compte, aucune clé, aucun réseau.
 * Il n'écrit que ce que le site contient déjà — nom, prix, description — et ne complète
 * qu'avec des tournures qui n'affirment aucun fait sur le produit.
 */

type Lang = "fr" | "en";

interface Phrasebook {
  hooks: string[];
  hookTexts: string[];
  transitions: string[];
  priceLine: (price: string) => string;
  priceText: (price: string) => string;
  ctaLines: string[];
  ctaTexts: string[];
  detailIntro: string[];
  listHook: (count: number, what: string) => string;
  title: (product: string, brand: string) => string;
  description: (product: string, brand: string, url: string) => string;
  seriesTitle: (position: number, total: number, product: string) => string;
  defaultTags: string[];
}

const PHRASES: Record<Lang, Phrasebook> = {
  fr: {
    hooks: [
      "Si vous ne deviez en retenir qu'une seule, ce serait celle-ci.",
      "Voici la piece dont on nous parle le plus en ce moment.",
      "Celle-la, on la sort et on ne la range plus.",
      "Il y a une raison pour laquelle celle-ci part la premiere.",
      "Arretez de faire defiler, regardez ca deux secondes.",
      "Celle-ci, on la garde longtemps.",
      "On commence par la plus demandee.",
      "Cette piece-la, elle change une tenue entiere.",
    ],
    hookTexts: [
      "A NE PAS RATER",
      "LE COUP DE COEUR",
      "CELLE QU'ON GARDE",
      "LA PLUS DEMANDEE",
      "REGARDEZ CA",
      "NOTRE PREFEREE",
      "ON COMMENCE FORT",
      "LA PIECE CLE",
    ],
    transitions: [
      "Voila ce qu'il faut savoir dessus.",
      "Dans le detail, ca donne ceci.",
      "Le site la decrit comme ceci.",
      "Quelques mots sur elle.",
    ],
    priceLine: (price) => `Elle est affichee a ${price} sur le site.`,
    priceText: (price) => price.toUpperCase(),
    ctaLines: [
      "Tout est sur le site, le lien est juste en dessous.",
      "Le reste de la selection vous attend sur le site.",
      "Rendez-vous sur le site pour la voir en entier.",
      "Le lien est en description, allez y jeter un oeil.",
    ],
    ctaTexts: ["LE LIEN EST EN DESSOUS", "A VOIR SUR LE SITE", "C'EST PAR ICI", "LIEN EN DESCRIPTION"],
    detailIntro: ["A retenir", "En bref", "Ce qu'il faut savoir", "Le detail"],
    listHook: (count, what) => `On passe en revue ${count} ${what}, restez jusqu'a la fin.`,
    title: (product, brand) => `${product} — ${brand} #Shorts`,
    description: (product, brand, url) =>
      `${product}, a retrouver chez ${brand}.\n\nToute la selection est sur ${url}`,
    seriesTitle: (position, total, product) => `${position} sur ${total} : ${product} #Shorts`,
    defaultTags: ["selection", "nouveaute", "boutique"],
  },
  en: {
    hooks: [
      "If you only keep one, make it this one.",
      "This is the piece everyone keeps asking about.",
      "You take this one out and it never goes back.",
      "There is a reason this one goes first.",
      "Stop scrolling for two seconds and look at this.",
      "This one stays with you for years.",
      "We are starting with the most requested one.",
      "This single piece changes a whole outfit.",
    ],
    hookTexts: [
      "DO NOT MISS THIS",
      "OUR FAVOURITE",
      "THE ONE YOU KEEP",
      "MOST REQUESTED",
      "LOOK AT THIS",
      "THE STANDOUT",
      "STARTING STRONG",
      "THE KEY PIECE",
    ],
    transitions: [
      "Here is what you should know about it.",
      "Here it is in detail.",
      "The site describes it like this.",
      "A few words about it.",
    ],
    priceLine: (price) => `It is listed at ${price} on the site.`,
    priceText: (price) => price.toUpperCase(),
    ctaLines: [
      "Everything is on the site, link right below.",
      "The rest of the selection is waiting on the site.",
      "Head to the site to see the full thing.",
      "Link is in the description, go take a look.",
    ],
    ctaTexts: ["LINK BELOW", "SEE IT ON THE SITE", "THIS WAY", "LINK IN DESCRIPTION"],
    detailIntro: ["Worth knowing", "In short", "What to know", "The detail"],
    listHook: (count, what) => `We are going through ${count} ${what}, stay until the end.`,
    title: (product, brand) => `${product} — ${brand} #Shorts`,
    description: (product, brand, url) =>
      `${product}, available at ${brand}.\n\nFull selection on ${url}`,
    seriesTitle: (position, total, product) => `${position} of ${total}: ${product} #Shorts`,
    defaultTags: ["selection", "new in", "shop"],
  },
};

function pick<T>(list: T[], index: number): T {
  return list[index % list.length]!;
}

/** Découpe une description en phrases courtes, utilisables telles quelles en voix off. */
function sentences(text: string | undefined, limit: number): string[] {
  if (!text) return [];
  return normalizeTypography(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12 && sentence.length < 190)
    .slice(0, limit);
}

const CURRENCY_SIGNS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", CHF: "CHF", CAD: "$" };

/** `129.00 EUR` devient `129 €` : plus court à l'écran, plus naturel à l'oral. */
function formatPrice(raw: string): string {
  let price = normalizeTypography(raw);
  for (const [code, sign] of Object.entries(CURRENCY_SIGNS)) {
    price = price.replace(new RegExp(`\\s*\\b${code}\\b`, "i"), ` ${sign}`);
  }
  return price.replace(/(\d)[.,]00\b/g, "$1").replace(/\s+/g, " ").trim();
}

/** Titre de produit raccourci pour tenir sur deux lignes à l'écran. */
function shortLabel(title: string): string {
  const clean = normalizeTypography(title).replace(/\s*[|–-]\s*.*$/, "");
  const words = clean.split(/\s+/).slice(0, 5).join(" ");
  return truncate(words, 34).toUpperCase();
}

function scenesForProduct(
  product: SiteProduct,
  site: SiteSnapshot,
  book: Phrasebook,
  seed: number,
): Scene[] {
  const images = product.imageIndexes.filter((index) =>
    site.images.some((image) => image.index === index && image.localPath),
  );
  const image = (position: number): number => (images.length > 0 ? pick(images, position) : -1);

  const scenes: Scene[] = [
    {
      narration: pick(book.hooks, seed),
      onScreenText: pick(book.hookTexts, seed),
      imageIndex: image(0),
      role: "hook",
    },
    {
      narration: `${normalizeTypography(product.title)}.`,
      onScreenText: shortLabel(product.title),
      imageIndex: image(0),
      role: "body",
    },
  ];

  const details = sentences(product.description, 2);
  if (details.length > 0) {
    scenes.push({
      narration: details[0]!,
      onScreenText: pick(book.detailIntro, seed),
      imageIndex: image(1),
      role: "body",
    });
  }
  if (details.length > 1) {
    scenes.push({
      narration: details[1]!,
      onScreenText: pick(book.detailIntro, seed + 1),
      imageIndex: image(2),
      role: "body",
    });
  }
  if (details.length === 0) {
    scenes.push({
      narration: pick(book.transitions, seed),
      onScreenText: shortLabel(site.siteName),
      imageIndex: image(1),
      role: "body",
    });
  }

  if (product.price) {
    const price = formatPrice(product.price);
    scenes.push({
      narration: book.priceLine(price),
      onScreenText: book.priceText(price),
      imageIndex: image(0),
      role: "body",
    });
  }

  scenes.push({
    narration: pick(book.ctaLines, seed),
    onScreenText: pick(book.ctaTexts, seed),
    imageIndex: -1,
    role: "cta",
  });

  return scenes;
}

/** Mots du brief qui décrivent ce que l'on montre, réutilisés dans l'accroche de série. */
function subjectFromBrief(brief: string, fallback: string): string {
  const match = /\b(?:sur|about|des|les|of the|the)\s+(?:\d+\s+)?(?:meilleur(?:e|s|es)?\s+|best\s+|top\s+)?([\p{L}\s]{3,28})/iu.exec(
    brief,
  );
  const captured = match?.[1]?.trim();
  return captured && captured.length > 2 ? captured.toLowerCase() : fallback;
}

function detectLang(site: SiteSnapshot, brief: string): Lang {
  if (/^en/i.test(site.lang)) return "en";
  if (/^fr/i.test(site.lang)) return "fr";
  // Sans indication du site, on suit la langue de la consigne.
  const frenchMarkers = /\b(les|des|une|vidéos?|vidéo|magasin|boutique|meilleur|fais|sur le|tenues?)\b/i;
  return frenchMarkers.test(brief) ? "fr" : "en";
}

function requestedCount(brief: string, fallback: number): number {
  const digits = /\b(\d{1,2})\s*(?:vid[ée]os?|shorts?|clips?)/i.exec(brief);
  const parsed = Number.parseInt(digits?.[1] ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(8, parsed);

  const written: Record<string, number> = {
    deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8,
    two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8,
  };
  for (const [word, value] of Object.entries(written)) {
    if (new RegExp(`\\b${word}\\b\\s*(?:vid[ée]os?|shorts?|clips?)`, "i").test(brief)) return value;
  }

  // « les 5 meilleures tenues » : un nombre isolé dans la consigne vaut aussi demande.
  const loose = /\b([1-8])\b/.exec(brief);
  if (loose?.[1]) return Number.parseInt(loose[1], 10);
  return fallback;
}

export class TemplateWriter implements Writer {
  readonly id = "template";
  readonly name = "rédacteur intégré (hors ligne, sans compte)";
  readonly free = true;

  async write(options: PlanOptions): Promise<CampaignPlan> {
    const { site } = options;
    const lang = detectLang(site, options.brief);
    const book = PHRASES[lang];
    const count = options.count ?? requestedCount(options.brief, 3);

    // Les produits illustrés passent devant : une vidéo sans visuel est toujours moins bonne.
    const ranked = [...site.products].sort((a, b) => {
      const score = (product: SiteProduct): number =>
        (product.imageIndexes.length > 0 ? 4 : 0) +
        (product.price ? 2 : 0) +
        (product.description && product.description.length > 60 ? 1 : 0);
      return score(b) - score(a);
    });

    const selected = ranked.slice(0, count);
    if (selected.length === 0) {
      throw new Error(
        "Aucun produit ni aucune page exploitable n'a été trouvé sur ce site. " +
          "Indiquez l'adresse d'une page de collection ou de catalogue, ou utilisez un rédacteur en ligne " +
          "(VIDO_WRITER=ollama) capable de travailler à partir du seul texte de la page.",
      );
    }

    options.onProgress?.(`${selected.length} vidéo(s) construite(s) depuis le catalogue`);

    const subject = subjectFromBrief(options.brief, lang === "fr" ? "pièces" : "pieces");
    const accentColor = await accentFromSite(site);

    const videos: VideoPlan[] = selected.map((product, index) => {
      const scenes = scenesForProduct(product, site, book, index);

      // Sur une série, la première vidéo annonce le programme.
      if (selected.length > 1 && index === 0) {
        scenes[0] = {
          narration: book.listHook(selected.length, subject),
          onScreenText: `${selected.length} ${subject.toUpperCase()}`.slice(0, 30),
          imageIndex: scenes[0]?.imageIndex ?? -1,
          role: "hook",
        };
      }

      const label = normalizeTypography(product.title);
      return {
        slug: slugify(product.title, `video-${index + 1}`),
        concept: label,
        scenes,
        youtubeTitle: truncate(
          selected.length > 1
            ? book.seriesTitle(index + 1, selected.length, label)
            : book.title(label, site.siteName),
          98,
        ),
        youtubeDescription: book.description(label, site.siteName, site.url),
        hashtags: [slugify(site.siteName, "boutique").replace(/-/g, ""), ...book.defaultTags.slice(0, 2)],
        tags: [label, site.siteName, ...book.defaultTags],
      };
    });

    return {
      language: lang,
      brandName: site.siteName,
      brandSummary: site.description || site.title,
      accentColor,
      backgroundColor: "#101623",
      videos,
    };
  }
}

/** Couleur d'accent tirée de la première image du site, pour ne pas imposer un rose générique. */
async function accentFromSite(site: SiteSnapshot): Promise<string> {
  const first = site.images.find((image) => image.localPath);
  if (!first?.localPath) return "#f43f5e";
  const color = await dominantColor(first.localPath);
  return color ?? "#f43f5e";
}
