/**
 * Rédaction par un modèle de langage, dans le navigateur.
 *
 * Le rédacteur intégré assemble des tournures préécrites : il respecte le sujet et le
 * nombre de vidéos, mais il ne saura jamais suivre une consigne détaillée. Avec une clé
 * d'un palier gratuit — aucune ne demande de carte bancaire — c'est un vrai modèle qui
 * écrit, et la consigne est alors suivie à la lettre.
 */

export const PROVIDERS = [
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    prefix: /^gsk_/,
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "gemini",
    name: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash",
    prefix: /^AIza/,
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    prefix: /^sk-or-/,
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    prefix: null,
    keyUrl: "https://console.mistral.ai",
  },
];

/** Devine le fournisseur d'après la forme de la clé : une seule case à remplir suffit. */
export function providerForKey(key) {
  const clean = (key ?? "").trim();
  if (!clean) return null;
  return PROVIDERS.find((provider) => provider.prefix?.test(clean)) ?? PROVIDERS[3];
}

const SYSTEM_PROMPT = `Tu es directeur de création spécialisé dans les vidéos verticales courtes (YouTube Shorts, TikTok, Reels).

LA CONSIGNE DE L'UTILISATEUR EST LA RÈGLE PRINCIPALE. Elle décide du sujet de chaque vidéo, de leur nombre, de l'angle et du ton. Tout le reste ci-dessous n'est là que pour l'exécuter proprement.

- Format 9:16, 20 à 40 secondes par vidéo, soit 5 à 7 scènes.
- Première scène : role "hook", une accroche concrète. Jamais "Bienvenue" ni "Découvrez notre site".
- Dernière scène : role "cta", un appel à l'action qui nomme le site.
- narration : ce que dit la voix off, 8 à 18 mots, phrases courtes, ton parlé. C'est aussi le texte des sous-titres, mot pour mot.
- onScreenText : 2 à 6 mots, lisible d'un coup d'œil, différent de la narration.
- Aucun emoji ni caractère décoratif dans narration et onScreenText.
- imageIndex : un index de la banque d'images fournie, celui qui illustre vraiment la scène. -1 seulement si aucune image ne convient.
- N'invente jamais un prix, une matière, une promotion, un horaire ou une caractéristique. Utilise uniquement les données extraites du site. Information manquante : parle du bénéfice ressenti, pas d'un fait inventé.
- Écris dans la langue de la consigne.
- youtubeTitle : moins de 90 caractères, se termine par " #Shorts".
- accentColor et backgroundColor : hexadécimal #RRGGBB ; le fond doit rester sombre.

Réponds uniquement par un objet JSON de cette forme, sans texte autour :
{"language":"fr","brandName":"","brandSummary":"","accentColor":"#RRGGBB","backgroundColor":"#RRGGBB","videos":[{"slug":"","concept":"","youtubeTitle":"","youtubeDescription":"","hashtags":[""],"tags":[""],"scenes":[{"narration":"","onScreenText":"","imageIndex":0,"role":"hook"}]}]}`;

function describeSite(site) {
  const lines = [`URL : ${site.url}`, `Nom : ${site.siteName}`, `Titre : ${site.title}`];
  if (site.description) lines.push(`Description : ${site.description}`);
  lines.push("");

  if (site.products.length > 0) {
    lines.push(`PRODUITS / PAGES (${site.products.length}) :`);
    for (const product of site.products.slice(0, 25)) {
      const parts = [`- ${product.title}`];
      if (product.price) parts.push(`prix : ${product.price}`);
      if (product.imageIndexes?.length) parts.push(`images : ${product.imageIndexes.join(", ")}`);
      lines.push(parts.join(" | "));
      if (product.description) lines.push(`  ${product.description.slice(0, 260)}`);
    }
    lines.push("");
  }

  if (site.sections?.length > 0) {
    lines.push(`SECTIONS DE LA PAGE (${site.sections.length}) :`);
    for (const section of site.sections.slice(0, 12)) {
      lines.push(`- ${section.title}`);
      if (section.text) lines.push(`  ${section.text.slice(0, 220)}`);
    }
    lines.push("");
  }

  const usable = site.images.filter((image) => image.bitmap);
  lines.push(`IMAGES UTILISABLES (${usable.length}) :`);
  for (const image of usable) {
    lines.push(`- [${image.index}] ${(image.alt || image.source || "").slice(0, 110)}`);
  }
  lines.push("");

  if (site.pageText) {
    lines.push("TEXTE DE LA PAGE :");
    lines.push(site.pageText.slice(0, 3000));
  }
  return lines.join("\n");
}

/** Les modèles ouverts encadrent souvent leur JSON de texte : on va le rechercher. */
function extractJson(raw) {
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  candidates.push(raw);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* morceau suivant */
    }
  }
  throw new Error("le modèle n'a pas renvoyé de JSON exploitable");
}

/** Remet la réponse du modèle dans les rails : rien de ce qui suit ne doit casser le rendu. */
function coercePlan(raw, site, count) {
  const usable = new Set(site.images.filter((image) => image.bitmap).map((image) => image.index));
  const hex = /^#[0-9a-fA-F]{6}$/;
  const text = (value, fallback = "") => (typeof value === "string" ? value.trim() : fallback);

  const videos = (Array.isArray(raw.videos) ? raw.videos : [])
    .map((video, videoIndex) => {
      const scenes = (Array.isArray(video.scenes) ? video.scenes : [])
        .filter((scene) => text(scene?.narration))
        .slice(0, 9)
        .map((scene, sceneIndex, all) => ({
          narration: text(scene.narration),
          onScreenText: text(scene.onScreenText).slice(0, 60),
          // Un index inventé donnerait un fond vide : on le neutralise.
          imageIndex: usable.has(Number(scene.imageIndex)) ? Number(scene.imageIndex) : -1,
          role:
            scene.role === "hook" || scene.role === "cta"
              ? scene.role
              : sceneIndex === 0
                ? "hook"
                : sceneIndex === all.length - 1
                  ? "cta"
                  : "body",
        }));
      if (scenes.length === 0) return null;

      const concept = text(video.concept, text(video.youtubeTitle, `Vidéo ${videoIndex + 1}`));
      const title = text(video.youtubeTitle, concept);
      return {
        slug:
          text(video.slug)
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48) || `video-${videoIndex + 1}`,
        concept,
        scenes,
        youtubeTitle: (title.includes("#Shorts") ? title : `${title} #Shorts`).slice(0, 98),
        youtubeDescription: text(video.youtubeDescription, `${concept}\n\n${site.url}`),
        hashtags: (Array.isArray(video.hashtags) ? video.hashtags : [])
          .map((tag) => text(tag).replace(/^#/, ""))
          .filter(Boolean)
          .slice(0, 12),
        tags: (Array.isArray(video.tags) ? video.tags : []).map((tag) => text(tag)).filter(Boolean).slice(0, 15),
      };
    })
    .filter(Boolean);

  if (videos.length === 0) throw new Error("le modèle n'a produit aucune scène exploitable");

  return {
    language: text(raw.language, "fr").slice(0, 5),
    brandName: text(raw.brandName, site.siteName),
    brandSummary: text(raw.brandSummary, site.description),
    accentColor: hex.test(text(raw.accentColor)) ? raw.accentColor : "#f43f5e",
    backgroundColor: hex.test(text(raw.backgroundColor)) ? raw.backgroundColor : "#101623",
    videos: count ? videos.slice(0, count) : videos,
  };
}

async function callModel(provider, apiKey, messages, mode, signal) {
  const body = {
    model: provider.model,
    messages,
    temperature: 0.75,
    max_tokens: 6000,
    stream: false,
  };
  if (mode === "json") body.response_format = { type: "json_object" };

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // Un 400 sur le format demandé signifie que ce serveur ne le gère pas.
    if (response.status === 400 && mode === "json") throw new UnsupportedMode(detail.slice(0, 160));
    if (response.status === 401 || response.status === 403) {
      throw new Error(`clé refusée par ${provider.name}. Vérifiez qu'elle est bien active.`);
    }
    if (response.status === 429) {
      throw new Error(`quota gratuit atteint chez ${provider.name}. Réessayez plus tard.`);
    }
    throw new Error(`${provider.name} a répondu ${response.status} : ${detail.slice(0, 160)}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${provider.name} a renvoyé une réponse vide`);
  return content;
}

class UnsupportedMode extends Error {}

/**
 * Écrit la campagne avec un modèle. Lève une erreur explicite si la clé ou le
 * service pose problème : l'appelant décide alors de revenir au rédacteur intégré.
 */
export async function writeWithModel({ apiKey, site, brief, count, onProgress, timeout = 90000 }) {
  const provider = providerForKey(apiKey);
  if (!provider) throw new Error("aucune clé fournie");

  const countLine =
    count !== undefined
      ? `Produis exactement ${count} vidéos.`
      : "Déduis de la consigne le nombre de vidéos demandé ; à défaut, produis 3 vidéos. Maximum 8.";

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "CONSIGNE À SUIVRE :",
        brief.trim(),
        "",
        countLine,
        "",
        "DONNÉES EXTRAITES DU SITE :",
        describeSite(site),
      ].join("\n"),
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    onProgress?.(`rédaction par ${provider.name}`);
    for (const mode of ["json", "prompt"]) {
      try {
        const answer = await callModel(provider, apiKey, messages, mode, controller.signal);
        return coercePlan(extractJson(answer), site, count);
      } catch (error) {
        if (error instanceof UnsupportedMode) continue;
        throw error;
      }
    }
    throw new Error(`${provider.name} n'a pas produit de plan exploitable`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${provider.name} n'a pas répondu à temps`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
