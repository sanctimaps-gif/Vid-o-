/**
 * Un modèle en ligne, sans clé et sans compte.
 *
 * Ce que cela suppose, dit franchement : la consigne et les données extraites du
 * site partent chez un service tiers. C'est la différence avec le modèle qui
 * tourne sur l'appareil, où rien ne quitte le navigateur. En échange, il n'y a
 * rien à télécharger, rien à installer, et le modèle est bien plus gros.
 *
 * Un tel service est gratuit parce que quelqu'un d'autre paie : ni sa
 * disponibilité, ni ses quotas, ni sa durée de vie ne sont garantis. Vid-O le
 * traite donc comme ce qu'il est — une commodité, jamais une dépendance. Chaque
 * échec retombe sans bruit sur le rédacteur intégré, et la vidéo sort quand même.
 */

import { SYSTEM_PROMPT, coercePlan, describeSite, extractJson } from "./prompt.js";
import { fetchRemote } from "./scrape.js";

/**
 * Services interrogeables sans compte. Deux façons de demander, parce qu'elles ne
 * se valent pas : la forme « discussion » accepte un long contexte et rend du
 * JSON propre ; la forme « adresse » fait tenir toute la demande dans l'URL, ce
 * qui la rend relayable quand l'accès direct est refusé par le navigateur.
 */
export const FREE_SERVICES = [
  {
    id: "pollinations-chat",
    name: "Pollinations",
    kind: "chat",
    url: "https://text.pollinations.ai/openai",
    model: "openai",
  },
  {
    id: "pollinations-chat-mistral",
    name: "Pollinations (Mistral)",
    kind: "chat",
    url: "https://text.pollinations.ai/openai",
    model: "mistral",
  },
  {
    id: "pollinations-url",
    name: "Pollinations (adresse)",
    kind: "url",
    url: "https://text.pollinations.ai/",
    model: "openai",
  },
];

/** Vid-O s'annonce : ces services demandent de savoir qui les appelle. */
const REFERRER = "vid-o";

function buildMessages(site, brief, count, tour, compact) {
  const countLine =
    count !== undefined
      ? `Produis exactement ${count} vidéos.`
      : "Déduis de la consigne le nombre de vidéos demandé ; à défaut, produis 3 vidéos. Maximum 8.";

  const footage = [];
  const pages = (tour ?? []).filter((shot) => shot?.bitmap);
  if (pages.length > 0) {
    footage.push(`PAGES DU SITE QUI SERONT À L'ÉCRAN (${pages.length}) :`);
    for (const shot of pages) footage.push(`- ${site.domain}${shot.path || "/"} (${shot.label})`);
    footage.push("");
  }
  const usable = site.images.filter((image) => image.bitmap);
  footage.push(
    usable.length > 0
      ? `IMAGES DISPONIBLES : ${usable.length}.`
      : "AUCUNE PHOTO disponible : les scènes montreront les pages du site. Mets imageIndex à -1 partout.",
  );
  footage.push("");

  // La forme « adresse » doit tenir dans une URL : on lui donne le site en bref.
  const description = compact ? describeSite(site).slice(0, 1400) : describeSite(site);

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "CONSIGNE À SUIVRE :",
        brief.trim(),
        "",
        countLine,
        "",
        footage.join("\n"),
        "DONNÉES EXTRAITES DU SITE :",
        description,
      ].join("\n"),
    },
  ];
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} : délai dépassé`)), ms);
    }),
  ]);
}

async function askChat(service, messages, timeout) {
  const response = await withTimeout(
    fetch(service.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: service.model,
        messages,
        temperature: 0.7,
        referrer: REFERRER,
        response_format: { type: "json_object" },
      }),
    }),
    timeout,
    // Le nom du service est ajouté par l'appelant : le répéter ici donnait des
    // messages en bégaiement, « Pollinations : Pollinations : réponse 500 ».
    "requête",
  );
  if (!response.ok) throw new Error(`réponse ${response.status}`);

  const text = await response.text();
  // Selon le service, la réponse est une enveloppe de discussion ou le texte brut.
  try {
    const data = JSON.parse(text);
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer === "string" && answer.trim()) return answer;
    // Pas d'enveloppe : le JSON reçu est peut-être déjà le plan.
    if (data && typeof data === "object" && Array.isArray(data.videos)) return text;
  } catch {
    /* ce n'était pas du JSON : c'est le texte du modèle */
  }
  if (!text.trim()) throw new Error("réponse vide");
  return text;
}

/**
 * Tout dans l'adresse. Moins confortable, mais c'est la seule forme qui passe par
 * les relais publics quand le navigateur refuse l'appel direct — un POST ne se
 * relaie pas.
 */
async function askUrl(service, messages, timeout) {
  const prompt = messages.map((message) => message.content).join("\n\n");
  const address =
    `${service.url}${encodeURIComponent(prompt)}` +
    `?model=${encodeURIComponent(service.model)}&referrer=${REFERRER}&json=true`;

  // `fetchRemote` essaie l'accès direct puis les relais, exactement comme pour la
  // lecture d'un site.
  const text = await fetchRemote(address, { timeout, sticky: false });
  if (!text?.trim()) throw new Error("réponse vide");
  return text;
}

/**
 * Écrit la campagne avec un service en ligne gratuit. Les services sont essayés
 * l'un après l'autre ; la première réponse exploitable gagne. Lève une erreur
 * explicite quand aucun n'aboutit : l'appelant revient alors au rédacteur intégré.
 */
export async function writeWithFreeModel({ site, brief, count, tour = [], onProgress, timeout = 60000 }) {
  const reasons = [];

  for (const service of FREE_SERVICES) {
    try {
      onProgress?.(`rédaction par ${service.name}`);
      const messages = buildMessages(site, brief, count, tour, service.kind === "url");
      const answer =
        service.kind === "chat"
          ? await askChat(service, messages, timeout)
          : await askUrl(service, messages, timeout);
      return coercePlan(extractJson(answer), site, count);
    } catch (error) {
      reasons.push(`${service.name} : ${error.message}`);
    }
  }

  throw new Error(
    `aucun service gratuit n'a pu écrire les scripts (${reasons.slice(0, 3).join(" · ")})`,
  );
}
