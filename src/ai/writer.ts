import { config } from "../config.js";
import type { CampaignPlan } from "../types.js";
import { slugify, truncate } from "../util/text.js";
import type { PlanOptions, Writer } from "./prompt.js";
import { OpenAiCompatibleWriter } from "./providers/openai.js";
import { TemplateWriter } from "./providers/template.js";

export type { PlanOptions, Writer } from "./prompt.js";

export type WriterId = "auto" | "template" | "ollama" | "groq" | "openrouter" | "gemini" | "mistral" | "custom" | "anthropic";

/* ------------------------------------------------------------------ *
 * Fournisseurs gratuits en ligne, compatibles OpenAI
 * ------------------------------------------------------------------ */

interface HostedProvider {
  id: WriterId;
  name: string;
  baseUrl: string;
  envKey: string;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
}

/**
 * Ces quatre plateformes proposent un palier gratuit sans carte bancaire.
 * Vid-O ne fait qu'appeler leur API : aucune n'est facturée dans cette formule.
 */
const HOSTED: HostedProvider[] = [
  {
    id: "groq",
    name: "Groq (palier gratuit)",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
  },
  {
    id: "gemini",
    name: "Google AI Studio (palier gratuit)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.0-flash",
  },
  {
    id: "openrouter",
    name: "OpenRouter (modèles gratuits)",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    extraHeaders: { "x-title": "Vid-O" },
  },
  {
    id: "mistral",
    name: "Mistral (palier gratuit)",
    baseUrl: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    defaultModel: "mistral-small-latest",
  },
];

function hostedWriter(provider: HostedProvider): Writer {
  return new OpenAiCompatibleWriter({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: process.env.VIDO_LLM_MODEL || provider.defaultModel,
    apiKey: process.env[provider.envKey],
    extraHeaders: provider.extraHeaders,
  });
}

function ollamaWriter(): Writer {
  return new OpenAiCompatibleWriter({
    id: "ollama",
    name: `Ollama en local (${config.ollamaModel})`,
    baseUrl: `${config.ollamaUrl.replace(/\/$/, "")}/v1`,
    model: config.ollamaModel,
    // Un modèle ouvert sur un poste modeste peut être lent : on laisse du temps.
    timeoutMs: 900_000,
  });
}

function customWriter(): Writer {
  return new OpenAiCompatibleWriter({
    id: "custom",
    name: `serveur compatible OpenAI (${config.llmBaseUrl})`,
    baseUrl: config.llmBaseUrl,
    model: process.env.VIDO_LLM_MODEL || "local-model",
    apiKey: process.env.VIDO_LLM_API_KEY,
  });
}

/** Ollama tourne-t-il vraiment sur cette machine ? */
export async function ollamaAvailable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${config.ollamaUrl.replace(/\/$/, "")}/api/tags`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function availableHostedProvider(): HostedProvider | null {
  return HOSTED.find((provider) => Boolean(process.env[provider.envKey])) ?? null;
}

/* ------------------------------------------------------------------ *
 * Sélection
 * ------------------------------------------------------------------ */

/**
 * Ordre de préférence en mode automatique, du plus gratuit au moins gratuit :
 * un serveur local, puis un palier gratuit en ligne, puis le rédacteur intégré.
 * Anthropic n'est utilisé que si on le demande explicitement — c'est le seul qui se facture.
 */
export async function selectWriter(requested?: WriterId): Promise<Writer> {
  const choice = requested ?? (process.env.VIDO_WRITER as WriterId | undefined) ?? "auto";

  if (choice === "anthropic") {
    const { AnthropicWriter } = await import("./providers/anthropic.js");
    return new AnthropicWriter();
  }
  if (choice === "template") return new TemplateWriter();
  if (choice === "ollama") return ollamaWriter();
  if (choice === "custom") return customWriter();

  const named = HOSTED.find((provider) => provider.id === choice);
  if (named) return hostedWriter(named);

  // Mode automatique.
  if (config.llmBaseUrl) return customWriter();
  if (await ollamaAvailable()) return ollamaWriter();

  const hosted = availableHostedProvider();
  if (hosted) return hostedWriter(hosted);

  return new TemplateWriter();
}

/* ------------------------------------------------------------------ *
 * Écriture + garde-fous
 * ------------------------------------------------------------------ */

export async function writeCampaignPlan(options: PlanOptions & { writer?: Writer }): Promise<CampaignPlan> {
  const writer = options.writer ?? (await selectWriter());
  const plan = await writer.write(options);
  return normalizePlan(plan, options);
}

/** Le rendu doit rester possible même si le rédacteur sort un peu du cadre. */
export function normalizePlan(plan: CampaignPlan, options: PlanOptions): CampaignPlan {
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

/** Décrit, pour `doctor` et pour l'interface, quels rédacteurs sont utilisables ici. */
export async function writerStatus(): Promise<Array<{ id: string; name: string; ready: boolean; detail: string }>> {
  const rows: Array<{ id: string; name: string; ready: boolean; detail: string }> = [];

  const ollama = await ollamaAvailable();
  rows.push({
    id: "ollama",
    name: "Ollama (local, gratuit)",
    ready: ollama,
    detail: ollama
      ? `disponible sur ${config.ollamaUrl}, modèle ${config.ollamaModel}`
      : `absent — installez ollama.com puis « ollama pull ${config.ollamaModel} »`,
  });

  for (const provider of HOSTED) {
    const ready = Boolean(process.env[provider.envKey]);
    rows.push({
      id: provider.id,
      name: provider.name,
      ready,
      detail: ready ? `clé ${provider.envKey} définie` : `définissez ${provider.envKey} (gratuit, sans carte)`,
    });
  }

  rows.push({
    id: "template",
    name: "Rédacteur intégré (hors ligne)",
    ready: true,
    detail: "toujours disponible, aucun compte requis",
  });

  const anthropic = Boolean(config.anthropicApiKey || process.env.ANTHROPIC_AUTH_TOKEN);
  rows.push({
    id: "anthropic",
    name: "Claude (payant, facultatif)",
    ready: anthropic,
    detail: anthropic ? `clé définie, modèle ${config.model}` : "non configuré",
  });

  return rows;
}
