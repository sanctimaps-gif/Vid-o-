import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { writeCampaignPlan } from "./ai/plan.js";
import { crawlSite, downloadImages } from "./scrape/site.js";
import { renderVideo } from "./render/renderShort.js";
import { createSpeaker } from "./tts/index.js";
import { CampaignPlanSchema, type CampaignPlan, type GenerateOptions, type RenderedVideo, type SiteSnapshot } from "./types.js";
import { slugify } from "./util/text.js";

const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i;

export interface CampaignResult {
  outDir: string;
  site: SiteSnapshot;
  plan: CampaignPlan;
  videos: RenderedVideo[];
}

async function listMusic(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((entry) => AUDIO_EXTENSIONS.test(entry))
      .sort()
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

export async function generateCampaign(options: GenerateOptions): Promise<CampaignResult> {
  const progress = options.onProgress ?? (() => {});
  const url = new URL(options.url).toString();

  const campaignDir = path.resolve(
    options.outDir,
    `${slugify(new URL(url).hostname)}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`,
  );
  const cacheDir = path.join(campaignDir, ".cache");
  const workRoot = path.join(campaignDir, ".work");
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(workRoot, { recursive: true });

  /* 1. Lecture du site --------------------------------------------------- */
  progress("scrape", `analyse de ${url}`);
  const site = await crawlSite(url, {
    onProgress: (message) => progress("scrape", message),
  });
  progress(
    "scrape",
    `${site.products.length} produit(s), ${site.images.length} image(s) repérée(s) sur ${site.pagesVisited.length} page(s)`,
  );

  progress("images", "téléchargement des visuels");
  await downloadImages(site, path.join(cacheDir, "images"), {
    onProgress: (message) => progress("images", message),
  });
  const usableImages = site.images.filter((image) => image.localPath).length;
  progress("images", `${usableImages} image(s) exploitable(s)`);
  await fs.writeFile(
    path.join(cacheDir, "site.json"),
    `${JSON.stringify(site, null, 2)}\n`,
    "utf8",
  );

  /* 2. Écriture des scripts ---------------------------------------------- */
  let plan: CampaignPlan;
  if (options.planPath) {
    progress("script", `réutilisation du plan ${options.planPath}`);
    plan = CampaignPlanSchema.parse(JSON.parse(await fs.readFile(options.planPath, "utf8")));
  } else {
    progress("script", "rédaction des scripts par Claude");
    plan = await writeCampaignPlan({
      site,
      brief: options.brief,
      count: options.count,
      onProgress: (message) => progress("script", message),
    });
  }
  await fs.writeFile(path.join(campaignDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  progress("script", `${plan.videos.length} vidéo(s) écrite(s) pour ${plan.brandName}`);

  /* 3. Rendu -------------------------------------------------------------- */
  const speaker = await createSpeaker({ provider: options.tts, voice: options.voice });
  progress("render", `voix off : ${speaker.name}`);

  const musicFiles = await listMusic(options.musicDir ?? config.musicDir);
  if (musicFiles.length === 0) progress("render", "aucune musique de fond trouvée (dossier vide)");

  const videos: RenderedVideo[] = [];
  for (const [index, video] of plan.videos.entries()) {
    const position = index + 1;
    progress("render", `vidéo ${position}/${plan.videos.length} — ${video.concept}`);
    const rendered = await renderVideo(video, {
      plan,
      site,
      speaker,
      musicPath: musicFiles.length > 0 ? (musicFiles[index % musicFiles.length] ?? null) : null,
      outDir: campaignDir,
      workRoot,
      videoIndex: position,
      videoTotal: plan.videos.length,
      onProgress: (message) => progress("render", `vidéo ${position}/${plan.videos.length} — ${message}`),
    });
    videos.push(rendered);
    progress("done-video", JSON.stringify({ ...rendered, position }));
  }

  /* 4. Livrables ---------------------------------------------------------- */
  const summary = {
    generatedAt: new Date().toISOString(),
    brief: options.brief,
    sourceUrl: site.url,
    brand: plan.brandName,
    language: plan.language,
    videos: videos.map((video, index) => ({
      position: index + 1,
      file: path.basename(video.videoPath),
      thumbnail: path.basename(video.thumbnailPath),
      metadata: path.basename(video.metadataPath),
      title: video.youtubeTitle,
      durationSeconds: video.durationSeconds,
    })),
  };
  await fs.writeFile(
    path.join(campaignDir, "campagne.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(campaignDir, "A-POSTER.md"), buildChecklist(summary, videos), "utf8");

  await fs.rm(workRoot, { recursive: true, force: true });

  return { outDir: campaignDir, site, plan, videos };
}

function buildChecklist(
  summary: { brand: string; sourceUrl: string; brief: string },
  videos: RenderedVideo[],
): string {
  const lines: string[] = [
    `# Shorts prêts à poster — ${summary.brand}`,
    "",
    `Source : ${summary.sourceUrl}`,
    `Consigne : ${summary.brief}`,
    "",
    "Chaque vidéo est en 1080x1920, prête pour YouTube Shorts, TikTok et Instagram Reels.",
    "Copiez le titre et la description ci-dessous au moment de la mise en ligne.",
    "",
  ];

  for (const [index, video] of videos.entries()) {
    lines.push(`## ${index + 1}. ${video.concept}`);
    lines.push("");
    lines.push(`- Fichier : \`${path.basename(video.videoPath)}\` (${video.durationSeconds}s)`);
    lines.push(`- Miniature : \`${path.basename(video.thumbnailPath)}\``);
    lines.push("");
    lines.push("**Titre**");
    lines.push("");
    lines.push(`> ${video.youtubeTitle}`);
    lines.push("");
    lines.push("**Description**");
    lines.push("");
    lines.push("```");
    lines.push(video.youtubeDescription);
    lines.push("```");
    lines.push("");
    lines.push(`**Mots-clés** : ${video.tags.join(", ")}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
