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
import { MOOD_NAMES } from "./audio.js";
import { providerForKey, writeWithModel } from "./llm.js";
import { keepScreenAwake, releaseScreen, screenIsAwake } from "./ticker.js";

const $ = (selector) => document.querySelector(selector);

const form = $("#form");
const submit = $("#submit");
const notice = $("#notice");
const panel = $("#panel");
const stageArea = $("#stage");
const canvas = $("#canvas");
const statusLine = $("#status");
const bar = $("#bar");
const results = $("#results");
const grid = $("#grid");

let startedAt = 0;
let elapsedTimer = null;
let stageAt = 0;
const stages = [];

function say(message, kind = "info") {
  statusLine.textContent = message;
  statusLine.dataset.kind = kind;
}

/** Note la durée d'une étape, pour le relevé affiché à la fin. */
function stage(label, detail = "") {
  const now = performance.now();
  stages.push({ label, detail, seconds: (now - stageAt) / 1000 });
  stageAt = now;
}

/**
 * Relevé de la génération. Sans lui, « c'est long » reste invérifiable :
 * on ne sait pas quelle étape traîne, ni sur quel site.
 */
function showReport(site, extra) {
  const total = (performance.now() - startedAt) / 1000;
  const lines = stages.map(
    ({ label, detail, seconds }) => `${seconds.toFixed(1).padStart(5)} s  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  lines.push(`${total.toFixed(1).padStart(5)} s  TOTAL`);
  if (site) {
    lines.push("");
    lines.push(
      `${site.domain} — ${site.products.length} produit(s), ${site.sections?.length ?? 0} section(s), ` +
        `${site.images.filter((image) => image.bitmap).length}/${site.images.length} visuel(s) — lu via ${site.readVia ?? "?"}`,
    );
  }
  if (extra) lines.push(extra);

  $("#report-body").textContent = lines.join("\n");
  $("#report").hidden = false;
}

function warn(message) {
  notice.hidden = false;
  notice.textContent = message;
}

/* ------------------------------------------------------------------ *
 * Musique : aucune par défaut, sur demande seulement
 * ------------------------------------------------------------------ */

let musicBuffer = null;

$("#mood").addEventListener("change", (event) => {
  $("#music-field").hidden = event.target.value !== "file";
});

$("#music").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  musicBuffer = null;
  if (!file) return;
  try {
    const context = new (window.AudioContext ?? window.webkitAudioContext)();
    musicBuffer = await context.decodeAudioData(await file.arrayBuffer());
    await context.close();
    $("#music-label").textContent = `${file.name} — utilisé en fond sonore`;
  } catch {
    $("#music-label").textContent = "Fichier audio illisible, il sera ignoré.";
  }
});

// La clé reste sur l'appareil : elle n'est envoyée qu'au fournisseur choisi.
try {
  const saved = localStorage.getItem("vido.key");
  if (saved) $("#apikey").value = saved;
} catch {
  /* stockage indisponible : on s'en passe */
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
    (file.spoken ? `voix off ${file.spokenScenes}/${file.totalScenes}` : "sous-titres seuls");

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
  startedAt = performance.now();
  stageAt = startedAt;
  stages.length = 0;
  $("#report").hidden = true;
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    const seconds = Math.round((performance.now() - startedAt) / 1000);
    $("#elapsed").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
  const awake = await keepScreenAwake();
  $("#stage-hint").textContent = awake
    ? "L'écran reste allumé jusqu'à la fin. Vous pouvez poser le téléphone, ou changer d'application : le montage continue."
    : "Le montage continue même si vous changez d'onglet. Évitez simplement de fermer la page.";
  notice.hidden = true;
  panel.hidden = false;
  results.hidden = true;
  grid.replaceChildren();
  stageArea.hidden = true;
  bar.style.width = "0%";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    say("Lecture du site…");
    resetTransport();

    // La capture part tout de suite et travaille pendant qu'on lit le site :
    // l'attendre à la fin ajoutait son temps entier à celui de l'analyse.
    const screenshotPromise = siteScreenshot(url, { width: canvas.width >= 1080 ? 900 : 720 }).catch(
      () => null,
    );
    const site = await crawlSite(url, { onProgress: (message) => say(`Lecture du site — ${message}`) });
    stage("lecture du site", `via ${site.readVia ?? "?"}`);
    const found =
      site.products.length > 0
        ? `${site.products.length} fiche(s) produit`
        : `${site.sections?.length ?? 0} section(s) de page`;
    say(`${found} — téléchargement des visuels…`);

    const loaded = await loadImages(site, {
      onProgress: (message) => say(`Visuels — ${message}`),
    });
    stage("téléchargement des visuels", `${loaded} retenu(s)`);
    say(`${loaded} visuel(s) exploitable(s). Écriture des scripts…`);

    const requested = Number(data.get("count"));
    const wanted = Number.isFinite(requested) && requested > 0 ? requested : requestedCount(brief);

    const apiKey = String(data.get("apikey") ?? "").trim();
    try {
      if (apiKey) localStorage.setItem("vido.key", apiKey);
      else localStorage.removeItem("vido.key");
    } catch {
      /* stockage indisponible */
    }

    let plan;
    let writtenBy = "rédacteur intégré";
    if (apiKey) {
      const provider = providerForKey(apiKey);
      try {
        say(`Écriture des scripts par ${provider.name}…`);
        plan = await writeWithModel({ apiKey, site, brief, count: wanted, onProgress: say });
        writtenBy = provider.name;
      } catch (error) {
        // Une clé refusée ou un quota atteint ne doit pas faire échouer la génération.
        warn(`${error.message}\n\nLes scripts ont été écrits par le rédacteur intégré à la place.`);
      }
    }
    if (!plan) plan = writeCampaign(site, brief, wanted);
    stage("écriture des scripts", `${plan.videos.length} vidéo(s), par ${writtenBy}`);
    const via = preferredSource();
    say(`${plan.videos.length} vidéo(s) à monter pour ${plan.brandName}${via ? ` (lu via ${via})` : ""}.`);

    // Si la capture n'est pas encore prête, on ne la fait pas attendre : la première
    // vidéo part sans elle, les suivantes en profiteront.
    let screenshot = await Promise.race([
      screenshotPromise,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 2500)),
    ]);
    if (screenshot === undefined) {
      screenshot = null;
      void screenshotPromise.then((late) => {
        if (late) screenshot = late;
      });
    }

    const audioContext = new (window.AudioContext ?? window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();

    const chosenMood = String(data.get("mood") ?? "none");
    const mood = MOOD_NAMES.includes(chosenMood) ? chosenMood : null;
    const withVoice = data.get("voice") !== "off";

    let voiceFailed = false;
    stageArea.hidden = false;
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
        musicBuffer: chosenMood === "file" ? musicBuffer : null,
        screenshot,
        onStage: (step) => say(`Vidéo ${position}/${plan.videos.length} — ${step}`),
        onProgress: (ratio) => {
          const overall = (index + ratio) / plan.videos.length;
          bar.style.width = `${Math.round(overall * 100)}%`;
        },
      });
      addResult(video, file, position);
      stage(
        `montage vidéo ${position}`,
        `${file.durationSeconds} s — voix ${file.spokenScenes}/${file.totalScenes}`,
      );
      if (withVoice && file.spokenScenes === 0) voiceFailed = true;
    }

    if (voiceFailed) {
      warn(
        "La voix off n'a pas pu être obtenue : les services de synthèse vocale gratuits n'ont pas " +
          "répondu. Les vidéos gardent leurs sous-titres. Réessayez dans quelques minutes, ou " +
          "utilisez la version ordinateur, qui synthétise la voix sur votre machine.",
      );
    }
    await audioContext.close();

    bar.style.width = "100%";
    showReport(
      site,
      [
        `scripts : ${writtenBy}`,
        `musique : ${chosenMood === "none" ? "aucune" : chosenMood === "file" ? "votre fichier" : `composée (${mood})`}`,
        `capture de la page : ${screenshot ? "obtenue" : "indisponible"}`,
      ].join("\n"),
    );
    stageArea.hidden = true;
    say(`${plan.videos.length} vidéo(s) prête(s). Enregistrez-les puis publiez-les.`, "done");
  } catch (error) {
    stageArea.hidden = true;
    say("La génération s'est arrêtée.", "error");
    warn(explain(error, url));
    showReport(null, `arrêt : ${error.message}`);
  } finally {
    clearInterval(elapsedTimer);
    submit.disabled = false;
    running = false;
    await releaseScreen();
  }
});
