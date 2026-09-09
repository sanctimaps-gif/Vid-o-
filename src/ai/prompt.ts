import type { CampaignPlan, SiteSnapshot } from "../types.js";
import { truncate } from "../util/text.js";

export interface PlanOptions {
  site: SiteSnapshot;
  brief: string;
  count?: number;
  onProgress?: (message: string) => void;
}

/** Un rédacteur transforme une consigne et un site en campagne de Shorts. */
export interface Writer {
  readonly id: string;
  /** Nom affiché dans les journaux et l'interface. */
  readonly name: string;
  /** `false` seulement pour les fournisseurs facturés à l'usage. */
  readonly free: boolean;
  write(options: PlanOptions): Promise<CampaignPlan>;
}

export const SYSTEM_PROMPT = `Tu es directeur de création spécialisé dans les vidéos verticales courtes (YouTube Shorts, TikTok, Reels) pour des marques.
Tu écris des scripts qui retiennent l'attention dès la première seconde et qui donnent envie de visiter le site.

Règles de fabrication, toutes obligatoires :
- Format 9:16, entre 20 et 45 secondes par vidéo, soit 5 à 7 scènes.
- Scène 1 : une accroche (role "hook") qui pose une tension ou une promesse concrète. Jamais "Bienvenue" ni "Découvrez notre boutique".
- Dernière scène : un appel à l'action (role "cta") qui nomme le site.
- narration : ce que dit la voix off, 8 à 18 mots, phrases courtes, ton parlé, présent. C'est aussi le texte des sous-titres.
- onScreenText : 2 à 6 mots maximum, en majuscules ou en titre, lisible d'un coup d'œil. Jamais identique mot pour mot à la narration.
- Aucun emoji, aucun caractère spécial décoratif dans narration ni dans onScreenText : ces textes sont incrustés avec une police système qui ne les affiche pas.
- imageIndex : choisis un index de la banque d'images fournie, celui qui montre vraiment ce dont parle la scène. Utilise -1 seulement quand aucune image ne convient.
- N'invente jamais un prix, une matière, une promotion ou une caractéristique produit. N'utilise que ce que contiennent les données extraites du site. Si une information manque, parle du bénéfice ressenti plutôt que d'un fait inventé.
- Écris dans la langue de la consigne de l'utilisateur.
- Chaque vidéo de la série doit traiter un sujet distinct et avoir un angle différent des autres.
- youtubeTitle : moins de 90 caractères, se termine par " #Shorts".
- accentColor et backgroundColor : hexadécimal #RRGGBB, cohérents avec l'univers de la marque, le fond doit rester sombre pour que le texte blanc ressorte.`;

export function renderSiteBrief(site: SiteSnapshot): string {
  const lines: string[] = [];
  lines.push(`URL : ${site.url}`);
  lines.push(`Nom du site : ${site.siteName}`);
  lines.push(`Titre : ${site.title}`);
  if (site.description) lines.push(`Description : ${site.description}`);
  lines.push("");

  if (site.products.length > 0) {
    lines.push(`PRODUITS / PAGES (${site.products.length}) :`);
    for (const product of site.products.slice(0, 30)) {
      const parts = [`- ${product.title}`];
      if (product.price) parts.push(`prix : ${product.price}`);
      if (product.imageIndexes.length > 0) parts.push(`images : ${product.imageIndexes.join(", ")}`);
      lines.push(parts.join(" | "));
      if (product.description) lines.push(`  ${truncate(product.description, 320)}`);
    }
    lines.push("");
  }

  const usable = site.images.filter((image) => image.localPath);
  lines.push(`BANQUE D'IMAGES UTILISABLES (${usable.length}) :`);
  for (const image of usable) {
    lines.push(
      `- [${image.index}] ${truncate(image.alt || image.source, 120)} (source : ${truncate(image.source, 60)})`,
    );
  }
  lines.push("");

  if (site.pageText) {
    lines.push("TEXTE DE LA PAGE D'ACCUEIL :");
    lines.push(truncate(site.pageText, 4000));
  }
  return lines.join("\n");
}

export function buildUserMessage(options: PlanOptions): string {
  const countInstruction =
    options.count !== undefined
      ? `Produis exactement ${options.count} vidéos.`
      : "Déduis de la consigne le nombre de vidéos demandé. Si la consigne ne le précise pas, produis 3 vidéos. Maximum 8.";

  return [
    "CONSIGNE DE L'UTILISATEUR :",
    options.brief.trim(),
    "",
    countInstruction,
    "",
    "DONNÉES EXTRAITES DU SITE À PROMOUVOIR :",
    renderSiteBrief(options.site),
  ].join("\n");
}
