import {
  ReadFailure,
  crawlSite,
  loadImages,
  preferredSource,
  resetTransport,
  siteScreenshot,
} from "./scrape.js";
import { writeCampaign, requestedCount } from "./writer.js";
import { isSupported, renderVideo } from "./render.js";
import { MOOD_NAMES, pickMood } from "./audio.js";
import { keepScreenAwake, releaseScreen, screenIsAwake } from "./ticker.js";

const $ = (selector) => document.querySelector(selector);

const form = $("#form");
const submit = $("#submit");
const notice = $("#notice");
const panel = $("#panel");
const stage = $("#stage");
const canvas = $("#canvas");
const statusLine = $("#status");
const bar = $("#bar");
const results = $("#results");
const grid = $("#grid");

function say(message, kind = "info") {
  statusLine.textContent = message;
  statusLine.dataset.kind = kind;
}

function warn(message) {
  notice.hidden = false;
  notice.textContent = message;
}

/* ------------------------------------------------------------------ *
 * Rester en vie pendant le montage
 * ------------------------------------------------------------------ */

let running = false;

// Le verrou d'écran est relâché par le navigateur à chaque passage en arrière-plan :
// on le reprend dès le retour, tant qu'un montage est en cours.
document.addEventListener("visibilitychange", () => {
  if (running && document.visibilityState === "visible" && !screenIsAwake()) void keepScreenAwake();
});

// Fermer l'onglet perdrait les vidéos en cours : le navigateur demande confirmation.
window.addEventListener("beforeunload", (event) => {
  if (!running) return;
  event.preventDefault();
  event.returnValue = "";
});

if (!isSupported()) {
  warn(
    "Ce navigateur ne sait pas enregistrer une vidéo depuis une page web. " +
      "Safari 17+, Chrome et Firefox à jour fonctionnent. Vous pouvez aussi utiliser la version ordinateur, plus bas.",
  );
  submit.disabled = true;
}

/* ------------------------------------------------------------------ *
 * Résultats
 * ------------------------------------------------------------------ */

function addResult(video, file, index) {
  const card = document.createElement("article");
  card.className = "video-card";

  const player = document.createElement("video");
  player.src = URL.createObjectURL(file.blob);
  player.poster = file.thumbnail;
  player.controls = true;
  player.playsInline = true;
  player.preload = "metadata";

  const body = document.createElement("div");
  body.className = "video-body";

  const title = document.createElement("h3");
  title.textContent = video.youtubeTitle;

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent =
    `${index} — ${file.durationSeconds}s — ${canvas.width}×${canvas.height} — ` +
    (file.spoken ? "voix off + musique" : "musique et sous-titres");

  const description = document.createElement("pre");
  description.className = "desc";
  const fullDescription = `${video.youtubeDescription}\n\n${video.hashtags
    .map((tag) => `#${tag}`)
    .join(" ")}`;
  description.textContent = fullDescription;

  const actions = document.createElement("div");
  actions.className = "actions";

  const download = document.createElement("a");
  download.href = player.src;
  download.download = `${String(index).padStart(2, "0")}-${video.slug}.${file.extension}`;
  download.textContent = "Enregistrer la vidéo";
  download.className = "primary";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copier titre + description";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`${video.youtubeTitle}\n\n${fullDescription}`);
      copy.textContent = "Copié";
    } catch {
      copy.textContent = "Copie refusée";
    }
    setTimeout(() => {
      copy.textContent = "Copier titre + description";
    }, 1800);
  });

  actions.append(download, copy);
  body.append(title, meta, description, actions);
  card.append(player, body);
  grid.append(card);
  results.hidden = false;
}

/**
 * Dire ce qui a échoué, et quoi faire ensuite. « Failed to fetch » tout seul
 * n'aide personne : on distingue le site injoignable du site lu mais vide.
 */
function explain(error, url) {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* adresse déjà validée en amont */
  }

  if (error instanceof ReadFailure) {
    return [
      `Impossible de lire ${host} depuis le navigateur.`,
      "",
      "Trois causes possibles :",
      "• l'adresse est erronée, ou la page demande une connexion ;",
      "• le site bloque la lecture par un service tiers ;",
      "• les relais publics sont momentanément saturés — réessayez dans une minute.",
      "",
      "La version ordinateur, plus bas, lit les sites directement et n'a pas cette limite.",
      "",
      `Détail technique : ${error.reasons.slice(0, 4).join(" · ")}`,
    ].join("\n");
  }

  return `${error.message}\n\nLa version ordinateur, plus bas, lit les sites directement.`;
}

/* ------------------------------------------------------------------ *
 * Génération
 * ------------------------------------------------------------------ */

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const url = String(data.get("url") ?? "").trim();
  const brief = String(data.get("brief") ?? "").trim();

  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocole");
  } catch {
    warn("Adresse invalide. Exemple : https://ma-boutique.fr");
    return;
  }

  const [width, height] = String(data.get("size") ?? "1080x1920").split("x").map(Number);
  canvas.width = width;
  canvas.height = height;

  submit.disabled = true;
  running = true;
  const awake = await keepScreenAwake();
  $("#stage-hint").textContent = awake
    ? "L'écran reste allumé jusqu'à la fin. Vous pouvez poser le téléphone, ou changer d'application : le montage continue."
    : "Le montage continue même si vous changez d'onglet. Évitez simplement de fermer la page.";
  notice.hidden = true;
  panel.hidden = false;
  results.hidden = true;
  grid.replaceChildren();
  stage.hidden = true;
  bar.style.width = "0%";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    say("Lecture du site…");
    resetTransport();
    const site = await crawlSite(url, { onProgress: (message) => say(`Lecture du site — ${message}`) });
    const found =
      site.products.length > 0
        ? `${site.products.length} fiche(s) produit`
        : `${site.sections?.length ?? 0} section(s) de page`;
    say(`${found} — téléchargement des visuels…`);

    const loaded = await loadImages(site, {
      onProgress: (message) => say(`Visuels — ${message}`),
    });
    say(`${loaded} visuel(s) exploitable(s). Écriture des scripts…`);

    const requested = Number(data.get("count"));
    const plan = writeCampaign(
      site,
      brief,
      Number.isFinite(requested) && requested > 0 ? requested : requestedCount(brief),
    );
    const via = preferredSource();
    say(`${plan.videos.length} vidéo(s) à monter pour ${plan.brandName}${via ? ` (lu via ${via})` : ""}.`);

    // Capture de la vraie page : c'est elle qu'on voit à l'ouverture et à la fin.
    say("Capture de la page…");
    const screenshot = await siteScreenshot(site.url, { width: canvas.width >= 1080 ? 900 : 720 });

    const audioContext = new (window.AudioContext ?? window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();

    const chosenMood = String(data.get("mood") ?? "");
    const mood = MOOD_NAMES.includes(chosenMood) ? chosenMood : pickMood(plan.brandName);
    const withVoice = data.get("voice") !== "off";

    stage.hidden = false;
    for (const [index, video] of plan.videos.entries()) {
      const position = index + 1;
      const file = await renderVideo({
        video,
        plan,
        site,
        canvas,
        position,
        total: plan.videos.length,
        audioContext,
        withVoice,
        mood,
        screenshot,
        onStage: (step) => say(`Vidéo ${position}/${plan.videos.length} — ${step}`),
        onProgress: (ratio) => {
          const overall = (index + ratio) / plan.videos.length;
          bar.style.width = `${Math.round(overall * 100)}%`;
        },
      });
      addResult(video, file, position);
    }
    await audioContext.close();

    bar.style.width = "100%";
    stage.hidden = true;
    say(`${plan.videos.length} vidéo(s) prête(s). Enregistrez-les puis publiez-les.`, "done");
  } catch (error) {
    stage.hidden = true;
    say("La génération s'est arrêtée.", "error");
    warn(explain(error, url));
  } finally {
    submit.disabled = false;
    running = false;
    await releaseScreen();
  }
});
