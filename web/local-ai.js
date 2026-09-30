/**
 * Un vrai modèle de langage, sans clé, sans compte, sans serveur.
 *
 * Il faut le dire d'emblée : **ChatGPT et Gemini ne s'utilisent pas sans clé.**
 * Leurs adresses refusent toute requête non authentifiée, et les passerelles qui
 * prétendent le contraire relaient votre texte chez un tiers inconnu, sans
 * garantie ni lendemain. Vid-O ne s'appuie sur aucune d'elles.
 *
 * La seule façon honnête d'écrire avec un modèle sans rien devoir à personne est
 * de le faire tourner chez vous. C'est ce que fait ce module : il télécharge une
 * fois les poids d'un modèle ouvert — Qwen, Gemma — et le fait travailler sur le
 * processeur graphique de votre appareil, via WebGPU. Rien ne sort du navigateur :
 * ni votre consigne, ni le contenu de votre site.
 *
 * Le prix à payer est honnête lui aussi : environ un gigaoctet au premier usage,
 * gardé ensuite en cache, et un appareil capable de le faire tourner. Quand ce
 * n'est pas le cas, on le dit et on revient au rédacteur intégré.
 */

import { SYSTEM_PROMPT, coercePlan, describeSite, extractJson } from "./prompt.js";

/**
 * Modèles proposés. Deux tailles seulement : au-delà, le téléchargement et la
 * mémoire deviennent déraisonnables sur un téléphone.
 */
export const LOCAL_MODELS = [
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    name: "léger",
    detail: "≈ 1,1 Go — convient à un téléphone récent",
  },
  {
    id: "gemma-2-2b-it-q4f16_1-MLC",
    name: "meilleur",
    detail: "≈ 1,6 Go — français plus sûr, demande un appareil confortable",
  },
];

export const DEFAULT_LOCAL_MODEL = LOCAL_MODELS[0].id;

/** L'adresse du moteur. Un point d'entrée unique, remplaçable pour les essais. */
const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm";

/**
 * WebGPU est la condition : c'est lui qui donne au navigateur l'accès au
 * processeur graphique. Chrome et Edge l'ont, Safari depuis la version 18, donc
 * iOS 18 ; Firefox le garde derrière une option.
 */
export function localAiSupported() {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export function localAiUnavailableReason() {
  if (typeof navigator === "undefined") return "ce navigateur n'est pas reconnu";
  if (!("gpu" in navigator)) {
    return (
      "ce navigateur n'a pas WebGPU, indispensable pour faire tourner un modèle sur l'appareil. " +
      "Chrome et Edge l'ont, Safari depuis iOS 18 ; sur Firefox il faut l'activer."
    );
  }
  return "";
}

/**
 * La présence de `navigator.gpu` ne suffit pas : un navigateur peut exposer
 * l'interface sans avoir de carte utilisable — c'est le cas d'un Chrome sans
 * accélération, où le modèle échouerait ensuite sur un message incompréhensible.
 * Seule la demande d'un adaptateur tranche, et elle coûte quelques millisecondes.
 */
async function assertUsableGpu() {
  if (!localAiSupported()) throw new Error(localAiUnavailableReason());
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (error) {
    throw new Error(`le processeur graphique a refusé : ${error.message}`);
  }
  if (!adapter) {
    throw new Error(
      "aucune carte graphique utilisable ici. L'accélération matérielle est peut-être désactivée " +
        "dans les réglages du navigateur, ou l'appareil ne la propose pas.",
    );
  }
}

let engine = null;
let engineModel = null;
let loading = null;

/** Le moteur, chargé au plus tard : rien n'est téléchargé tant qu'on ne demande rien. */
async function getEngine(model, onProgress) {
  if (engine && engineModel === model) return engine;
  if (loading) return loading;

  loading = (async () => {
    // `window.__vidoWebLLM` permet de vérifier tout ce qui entoure le modèle sans
    // télécharger un gigaoctet de poids à chaque essai.
    const stub = globalThis.__vidoWebLLM;
    if (!stub) await assertUsableGpu();
    const webllm = stub ?? (await import(/* @vite-ignore */ WEBLLM_URL));

    if (engine && engineModel !== model) {
      await engine.unload?.().catch(() => {});
      engine = null;
    }

    let announced = -1;
    engine = await webllm.CreateMLCEngine(model, {
      initProgressCallback: (report) => {
        const percent = Math.round((report?.progress ?? 0) * 100);
        // Un message par pourcent entier : le rapport en produit plusieurs par
        // seconde, et réécrire la ligne d'état aussi souvent ne sert à rien.
        if (percent === announced) return;
        announced = percent;
        onProgress?.(
          percent > 0 && percent < 100
            ? `téléchargement du modèle — ${percent} %`
            : (report?.text ?? "préparation du modèle"),
        );
      },
    });
    engineModel = model;
    return engine;
  })();

  try {
    return await loading;
  } catch (error) {
    engine = null;
    engineModel = null;
    throw error;
  } finally {
    loading = null;
  }
}

/**
 * Vérification complète, à faire avant de promettre quoi que ce soit à
 * l'utilisateur : rend la raison de l'indisponibilité, ou une chaîne vide.
 */
export async function localAiProblem() {
  try {
    await assertUsableGpu();
    return "";
  } catch (error) {
    return error.message;
  }
}

/** Le modèle est-il déjà chargé ? Utile pour annoncer une attente, ou son absence. */
export function localModelReady(model = DEFAULT_LOCAL_MODEL) {
  return Boolean(engine) && engineModel === model;
}

/** Rend la mémoire prise par le modèle. Les poids restent en cache sur l'appareil. */
export async function releaseLocalModel() {
  if (!engine) return;
  await engine.unload?.().catch(() => {});
  engine = null;
  engineModel = null;
}

/**
 * Ce que la vidéo pourra réellement montrer.
 *
 * Sans cela, le modèle écrit à l'aveugle : il annonce une photo qui n'existe pas,
 * ou décrit une page qui ne sera jamais à l'écran. En lui disant quelles pages ont
 * été filmées et quelles images sont exploitables, le texte et l'image parlent de
 * la même chose.
 */
function describeFootage(site, tour) {
  const lines = [];
  const pages = (tour ?? []).filter((shot) => shot?.bitmap);

  if (pages.length > 0) {
    lines.push(`PAGES DU SITE QUI SERONT À L'ÉCRAN (${pages.length}) :`);
    for (const shot of pages) {
      lines.push(`- ${site.domain}${shot.path || "/"} (${shot.label})`);
    }
    lines.push(
      "Chaque vidéo s'ouvre sur l'une de ces pages, qui défile à l'écran. Une vidéo " +
        "consacrée à un sujet reste sur la page de ce sujet du début à la fin.",
    );
    lines.push("");
  }

  const usable = site.images.filter((image) => image.bitmap);
  const own = usable.filter((image) => image.fromUser).length;
  if (usable.length > 0) {
    lines.push(
      `IMAGES DISPONIBLES : ${usable.length}${own > 0 ? `, dont ${own} fournies par l'utilisateur` : ""}.`,
    );
  } else {
    lines.push(
      "AUCUNE PHOTO n'a pu être récupérée : les scènes montreront les pages du site elles-mêmes. " +
        "N'évoque donc aucune photo de produit, et mets imageIndex à -1 partout.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Écrit la campagne avec le modèle local. Lève une erreur explicite : l'appelant
 * décide alors de revenir au rédacteur intégré.
 */
export async function writeWithLocalModel({
  site,
  brief,
  count,
  tour = [],
  model = DEFAULT_LOCAL_MODEL,
  onProgress,
}) {
  if (!localAiSupported()) throw new Error(localAiUnavailableReason());

  const client = await getEngine(model, onProgress);

  const countLine =
    count !== undefined
      ? `Produis exactement ${count} vidéos.`
      : "Déduis de la consigne le nombre de vidéos demandé ; à défaut, produis 3 vidéos. Maximum 8.";

  onProgress?.("le modèle écrit les scripts…");

  const reply = await client.chat.completions.create({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "CONSIGNE À SUIVRE :",
          brief.trim(),
          "",
          countLine,
          "",
          describeFootage(site, tour),
          "DONNÉES EXTRAITES DU SITE :",
          describeSite(site),
        ].join("\n"),
      },
    ],
    // Un petit modèle part vite en digression ; on le tient court et peu créatif
    // sur la forme, la créativité devant porter sur le texte, pas sur le format.
    temperature: 0.6,
    max_tokens: 2048,
    response_format: { type: "json_object" },
  });

  const answer = reply?.choices?.[0]?.message?.content ?? "";
  if (!answer.trim()) throw new Error("le modèle local n'a rien répondu");

  return coercePlan(extractJson(answer), site, count);
}
