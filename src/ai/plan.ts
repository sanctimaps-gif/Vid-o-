import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../config.js";
import { CampaignPlanSchema, type CampaignPlan, type SiteSnapshot } from "../types.js";
import { slugify, truncate } from "../util/text.js";

const SYSTEM_PROMPT = `Tu es directeur de création spécialisé dans les vidéos verticales courtes (YouTube Shorts, TikTok, Reels) pour des marques.
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

function renderSiteBrief(site: SiteSnapshot): string {
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
    lines.push(`- [${image.index}] ${truncate(image.alt || image.source, 120)} (source : ${truncate(image.source, 60)})`);
  }
  lines.push("");

  if (site.pageText) {
    lines.push("TEXTE DE LA PAGE D'ACCUEIL :");
    lines.push(truncate(site.pageText, 4000));
  }
  return lines.join("\n");
}

export interface PlanOptions {
  site: SiteSnapshot;
  brief: string;
  count?: number;
  onProgress?: (message: string) => void;
}

export async function writeCampaignPlan(options: PlanOptions): Promise<CampaignPlan> {
  if (!config.anthropicApiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      "ANTHROPIC_API_KEY n'est pas défini. Copiez .env.example vers .env et renseignez votre clé " +
        "(https://console.anthropic.com/settings/keys).",
    );
  }

  const client = new Anthropic();
  const countInstruction =
    options.count !== undefined
      ? `Produis exactement ${options.count} vidéos.`
      : "Déduis de la consigne le nombre de vidéos demandé. Si la consigne ne le précise pas, produis 3 vidéos. Maximum 8.";

  const userMessage = [
    "CONSIGNE DE L'UTILISATEUR :",
    options.brief.trim(),
    "",
    countInstruction,
    "",
    "DONNÉES EXTRAITES DU SITE À PROMOUVOIR :",
    renderSiteBrief(options.site),
  ].join("\n");

  options.onProgress?.("écriture des scripts");

  const stream = client.messages.stream({
    model: config.model,
    max_tokens: 32_000,
    system: SYSTEM_PROMPT,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: zodOutputFormat(CampaignPlanSchema),
    },
    messages: [{ role: "user", content: userMessage }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(
      `Le modèle a refusé d'écrire cette campagne${
        message.stop_details?.explanation ? ` : ${message.stop_details.explanation}` : "."
      }`,
    );
  }

  const parsed = message.parsed_output;
  if (!parsed) {
    throw new Error("Le modèle n'a pas renvoyé de plan exploitable. Relancez la génération.");
  }

  return normalizePlan(parsed, options);
}

/** Garde-fous : le rendu doit rester possible même si le modèle sort un peu du cadre. */
function normalizePlan(plan: CampaignPlan, options: PlanOptions): CampaignPlan {
  const usableIndexes = new Set(
    options.site.images.filter((image) => image.localPath).map((image) => image.index),
  );

  const seenSlugs = new Set<string>();
  let videos = plan.videos
    .filter((video) => video.scenes.length > 0)
    .map((video, videoIndex) => {
      let slug = slugify(video.slug || video.concept, `video-${videoIndex + 1}`);
      while (seenSlugs.has(slug)) slug = `${slug}-${videoIndex + 1}`;
      seenSlugs.add(slug);

      const scenes = video.scenes.slice(0, 9).map((scene) => ({
        ...scene,
        // Un index d'image inventé produirait un fond noir : on bascule sur le fond de marque.
        imageIndex: usableIndexes.has(scene.imageIndex) ? scene.imageIndex : -1,
      }));

      return {
        ...video,
        slug,
        scenes,
        youtubeTitle: truncate(
          video.youtubeTitle.includes("#Shorts") ? video.youtubeTitle : `${video.youtubeTitle} #Shorts`,
          100,
        ),
        hashtags: video.hashtags.map((tag) => tag.replace(/^#/, "")).slice(0, 12),
        tags: video.tags.slice(0, 15),
      };
    });

  if (options.count !== undefined && videos.length > options.count) {
    videos = videos.slice(0, options.count);
  }

  const hex = /^#[0-9a-fA-F]{6}$/;
  return {
    ...plan,
    accentColor: hex.test(plan.accentColor) ? plan.accentColor : "#f43f5e",
    backgroundColor: hex.test(plan.backgroundColor) ? plan.backgroundColor : "#0f172a",
    videos,
  };
}
