import {
  ReadFailure,
  crawlSite,
  loadImages,
  preferredSource,
  resetTransport,
  startVisit,
} from "./scrape.js";
import {
  writeCampaign,
  requestedCount,
  illustrateScenes,
  rankSubjects,
  attachSubjectPages,
} from "./writer.js";
import { isSupported, renderVideo } from "./render.js";
import { MOOD_NAMES } from "./audio.js";
import { writeWithFreeModel } from "./free-ai.js";
import {
  DEFAULT_LOCAL_MODEL,
  LOCAL_MODELS,
  localAiProblem,
  localAiSupported,
  localAiUnavailableReason,
  localModelReady,
  writeWithLocalModel,
} from "./local-ai.js";
import { keepScreenAwake, releaseScreen, screenIsAwake } from "./ticker.js";
import {
  closeStaleJobs,
  forgetEverything,
  forgetVideo,
  memoryAvailable,
  memoryUsage,
  rememberVideo,
  holdJob,
  rememberedVideos,
  startJob,
  touchJob,
  updateJob,
} from "./memory.js";

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

/* ------------------------------------------------------------------ *
 * Images fournies par l'utilisateur
 * ------------------------------------------------------------------ */

let ownImages = [];

$("#photos").addEventListener("change", async (event) => {
  const files = [...(event.target.files ?? [])];
  ownImages = [];
  for (const file of files.slice(0, 12)) {
    try {
      ownImages.push({ bitmap: await createImageBitmap(file), name: file.name });
    } catch {
      /* fichier illisible : on l'ignore */
    }
  }
  $("#photos-label").textContent =
    ownImages.length > 0
      ? `${ownImages.length} image(s) ajoutée(s), elles illustreront les vidéos.`
      : "Aucune image exploitable dans cette sélection.";
});

/* ------------------------------------------------------------------ *
 * Qui écrit les scripts
 * ------------------------------------------------------------------ */

const writerChoice = $("#writer");
const writerHint = $("#writer-hint");
const localModel = $("#localmodel");

for (const model of LOCAL_MODELS) {
  const option = document.createElement("option");
  option.value = model.id;
  option.textContent = `${model.name} — ${model.detail}`;
  localModel.append(option);
}
localModel.value = DEFAULT_LOCAL_MODEL;

const WRITER_HINTS = {
  builtin:
    "Le rédacteur intégré assemble des tournures préécrites : il suit le sujet et le nombre de " +
    "vidéos, pas une consigne détaillée.",
  local:
    "Un vrai modèle, téléchargé une fois puis gardé sur l'appareil. Aucune clé, aucun compte, et " +
    "rien ne sort du navigateur. ChatGPT et Gemini, eux, refusent toute requête sans clé : c'est " +
    "pourquoi le modèle tourne chez vous plutôt que chez eux.",
  free:
    "Un grand modèle interrogé en ligne, sans compte ni clé, et sans rien télécharger. En " +
    "contrepartie votre consigne et les données du site partent chez un service tiers, dont ni " +
    "la disponibilité ni les quotas ne sont garantis. En cas d'échec, le rédacteur intégré prend " +
    "le relais.",
};

async function refreshWriterChoice() {
  const mode = writerChoice.value;
  $("#local-field").hidden = mode !== "local";
  writerHint.textContent = WRITER_HINTS[mode] ?? "";
  if (mode !== "local") return;

  if (!localAiSupported()) {
    writerHint.textContent = `IA sur l'appareil indisponible : ${localAiUnavailableReason()} Les scripts seront écrits par le rédacteur intégré.`;
    return;
  }
  // Le vrai verdict demande d'interroger la carte graphique : on le dit ici,
  // avant le lancement, plutôt qu'au milieu d'une génération.
  const problem = await localAiProblem();
  if (problem && writerChoice.value === "local") {
    writerHint.textContent = `IA sur l'appareil indisponible : ${problem} Les scripts seront écrits par le rédacteur intégré.`;
  }
}

writerChoice.addEventListener("change", () => void refreshWriterChoice());
try {
  const saved = localStorage.getItem("vido.writer");
  if (saved && [...writerChoice.options].some((option) => option.value === saved)) {
    writerChoice.value = saved;
  }
} catch {
  /* stockage indisponible : on garde le choix par défaut */
}
void refreshWriterChoice();

// Une clé avait pu être enregistrée par une version précédente : on l'efface,
// plus rien ici n'en demande.
try {
  localStorage.removeItem("vido.key");
} catch {
  /* stockage indisponible : rien à nettoyer */
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

$("#forget-all").addEventListener("click", async () => {
  if (!window.confirm("Effacer toutes les vidéos gardées sur cet appareil ?")) return;
  await forgetEverything();
  await refreshLibrary();
});

// Au chargement : on rouvre la mémoire, on signale une génération restée en plan,
// et on réaffiche les vidéos déjà produites.
void (async () => {
  if (!(await memoryAvailable())) {
    libraryNote.textContent = "";
    return;
  }
  await reportInterrupted();
  await refreshLibrary();
})();

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

/* ------------------------------------------------------------------ *
 * Mémoire : ce qui a été produit, et ce qui était en train de l'être
 * ------------------------------------------------------------------ */

const library = $("#library");
const libraryList = $("#library-list");
const libraryNote = $("#library-note");
const libraryFilter = $("#library-filter");
const libraryEmpty = $("#library-empty");

let jobId = null;
let heartbeat = null;
let releaseJob = () => {};
let openEntry = null;

/** Une vidéo de six cents kilooctets ne doit pas s'afficher « 0 Mo ». */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} Go`;
  if (bytes >= 10 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} Mo`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

function formatDate(stamp) {
  try {
    return new Date(stamp).toLocaleString("fr-FR", {
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Le jour d'une vidéo, dit comme on le dirait : « Aujourd'hui », « Hier ». */
function periodOf(stamp) {
  const day = 86_400_000;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (stamp >= today) return "Aujourd'hui";
  if (stamp >= today - day) return "Hier";
  if (stamp >= today - 7 * day) return "7 derniers jours";
  if (stamp >= today - 30 * day) return "30 derniers jours";
  return "Plus ancien";
}

/**
 * Le panneau qui s'ouvre sous une ligne : le lecteur, le texte à publier, et de
 * quoi enregistrer ou retirer. Un seul ouvert à la fois, comme une liste de
 * conversations : la bibliothèque reste lisible même avec vingt vidéos.
 */
function libraryDetail(entry, onChange) {
  const panel = document.createElement("div");
  panel.className = "library-detail";

  const player = document.createElement("video");
  player.src = URL.createObjectURL(entry.blob);
  player.poster = entry.thumbnail;
  player.controls = true;
  player.playsInline = true;
  player.preload = "metadata";

  const description = document.createElement("pre");
  description.className = "desc";
  description.textContent = `${entry.description}\n\n${(entry.hashtags ?? [])
    .map((tag) => `#${tag}`)
    .join(" ")}`;

  const actions = document.createElement("div");
  actions.className = "actions";

  const download = document.createElement("a");
  download.href = player.src;
  download.download = `${String(entry.position).padStart(2, "0")}-${entry.slug}.${entry.extension}`;
  download.textContent = "Enregistrer la vidéo";
  download.className = "primary";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copier titre + description";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`${entry.title}\n\n${description.textContent}`);
      copy.textContent = "Copié";
    } catch {
      copy.textContent = "Copie refusée";
    }
    setTimeout(() => {
      copy.textContent = "Copier titre + description";
    }, 1800);
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Retirer de la bibliothèque";
  remove.addEventListener("click", async () => {
    await forgetVideo(entry.id);
    URL.revokeObjectURL(player.src);
    openEntry = null;
    await onChange();
  });

  actions.append(download, copy, remove);
  panel.append(player, description, actions);
  return panel;
}

/** Une ligne de la bibliothèque : vignette, titre, et de quoi s'y retrouver. */
function libraryRow(entry, onChange) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "library-row";
  row.setAttribute("aria-expanded", String(openEntry === entry.id));

  const vignette = document.createElement("span");
  vignette.className = "vignette";
  if (entry.thumbnail) vignette.style.backgroundImage = `url("${entry.thumbnail}")`;

  const label = document.createElement("span");
  label.className = "label";

  const name = document.createElement("strong");
  name.className = "name";
  name.textContent = entry.title || entry.slug;

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${entry.domain} · ${Math.round(entry.durationSeconds)} s · ${formatDate(entry.createdAt)}`;

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = "›";

  label.append(name, meta);
  row.append(vignette, label, chevron);

  row.addEventListener("click", async () => {
    openEntry = openEntry === entry.id ? null : entry.id;
    await onChange();
  });

  return row;
}

async function refreshLibrary() {
  let entries = [];
  try {
    entries = await rememberedVideos();
  } catch {
    library.hidden = true;
    return;
  }

  library.hidden = entries.length === 0;
  if (entries.length === 0) {
    libraryList.replaceChildren();
    return;
  }

  const needle = libraryFilter.value.trim().toLowerCase();
  const shown = needle
    ? entries.filter((entry) =>
        `${entry.title} ${entry.domain} ${entry.brief}`.toLowerCase().includes(needle),
      )
    : entries;

  libraryEmpty.hidden = shown.length > 0;

  // Regroupées par période, du plus récent au plus ancien.
  const nodes = [];
  let period = "";
  for (const entry of shown) {
    const current = periodOf(entry.createdAt);
    if (current !== period) {
      period = current;
      const heading = document.createElement("p");
      heading.className = "library-group";
      heading.textContent = period;
      nodes.push(heading);
    }
    nodes.push(libraryRow(entry, refreshLibrary));
    if (openEntry === entry.id) nodes.push(libraryDetail(entry, refreshLibrary));
  }
  libraryList.replaceChildren(...nodes);

  const { bytes, quota } = await memoryUsage();
  libraryNote.textContent =
    `${entries.length} vidéo(s) gardée(s) sur cet appareil, ${formatBytes(bytes)}` +
    `${quota ? ` sur ${formatBytes(quota)} disponibles` : ""}. ` +
    "Elles restent après un rechargement, et ne quittent jamais votre navigateur.";
}

libraryFilter.addEventListener("input", () => void refreshLibrary());

/**
 * Au retour, une génération encore marquée « en cours » n'a pas survécu à la
 * fermeture de la page. On le dit, on rappelle ce qui a été sauvé, et on propose
 * de reprendre là où on en était plutôt que de laisser l'utilisateur deviner.
 */
async function reportInterrupted() {
  let stale = [];
  try {
    stale = await closeStaleJobs();
  } catch {
    return;
  }
  const last = stale[0];
  if (!last) return;

  const box = document.createElement("div");
  box.className = "resume";
  box.textContent =
    `Une génération a été interrompue le ${formatDate(last.startedAt)} : ` +
    `${last.done} vidéo(s) sur ${last.total || "?"} avaient été montées, et elles sont ` +
    "gardées ci-dessous. Le reste n'a pas pu être fabriqué.";

  const again = document.createElement("button");
  again.type = "button";
  again.textContent = "Reprendre cette génération";
  again.addEventListener("click", () => {
    $("#url").value = last.url ?? "";
    $("#brief").value = last.brief ?? "";
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  box.append(again);
  form.before(box);
}

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

    // La visite du site travaille pendant tout le reste : elle photographie la page
    // d'accueil, puis deux autres pages. Ses messages ne s'affichent que lorsqu'on
    // l'attend vraiment, pour ne pas écraser l'avancement du montage.
    let visitNote = "";
    let awaitingVisit = false;
    const visit = startVisit(url, {
      width: canvas.width >= 1080 ? 900 : 720,
      onProgress: (message) => {
        visitNote = message;
        if (awaitingVisit) say(`Visite du site — ${message}`);
      },
    });

    const site = await crawlSite(url, { onProgress: (message) => say(`Lecture du site — ${message}`) });
    // La lecture dit ce qu'est cette page : une carte interactive ne se photographie
    // pas comme une page statique. Elle dit aussi où aller ensuite — et en premier
    // lieu les pages des sujets que la consigne met en avant, pour que la vidéo qui
    // présente un sujet ouvre sur la page de ce sujet.
    visit.explore(
      site,
      rankSubjects(site, brief)
        .slice(0, 3)
        .map((subject) => subject.url)
        .filter(Boolean),
    );
    stage(
      "lecture du site",
      `via ${site.readVia ?? "?"}${site.interactive ? ` — ${site.interactive} détectée` : ""}`,
    );
    const found =
      site.products.length > 0
        ? `${site.products.length} fiche(s)`
        : `${site.sections?.length ?? 0} section(s) de page`;
    say(`${found} — téléchargement des visuels…`);

    const loaded = await loadImages(site, {
      onProgress: (message) => say(`Visuels — ${message}`),
    });
    // Les images fournies rejoignent la banque, à la suite de celles du site :
    // les index déjà associés aux produits restent valables.
    for (const own of ownImages) {
      site.images.push({
        index: site.images.length,
        url: own.name,
        alt: own.name,
        source: "vos images",
        bitmap: own.bitmap,
        fromUser: true,
      });
    }

    const photos = loaded + ownImages.length;
    stage(
      "téléchargement des visuels",
      `${loaded} du site${ownImages.length > 0 ? ` + ${ownImages.length} fournie(s)` : ""}`,
    );

    // La visite est attendue ici, avant l'écriture : ses pages comptent parmi les
    // visuels, et un site qui n'expose aucune photo — une carte, une application —
    // n'a qu'elles à montrer.
    //
    // On n'attend que la *première* page, jamais la visite entière. Les suivantes
    // continuent d'arriver pendant le montage et rejoignent les vidéos d'après :
    // les attendre toutes laissait l'écran figé une minute avant la première
    // vidéo, ce qui ne se distingue pas d'une panne.
    awaitingVisit = true;
    if (site.interactive) {
      say(
        site.interactive === "carte"
          ? "Le site contient une carte interactive : on attend qu'elle soit chargée avant de le filmer…"
          : "Le site se construit tout seul : on attend qu'il soit affiché avant de le filmer…",
      );
      if (visitNote) say(`Visite du site — ${visitNote}`);
    }
    await visit.ready(site.interactive ? 30000 : 2500);
    awaitingVisit = false;
    stage(
      "visite du site",
      visit.shots.length > 0
        ? `${visit.shots.length} page(s) — ${visit.shots.map((shot) => shot.label).join(", ")}`
        : "aucune capture",
    );

    // Un site sans photos n'est pas un site sans images : ses propres pages en sont.
    // Elles rejoignent la banque de visuels, en dernier, pour que les sites qui ont
    // de vraies photos gardent les leurs.
    let fromVisit = 0;
    if (photos < 3) {
      for (const shot of visit.shots) {
        site.images.push({
          index: site.images.length,
          url: shot.url,
          alt: `${site.domain}${shot.path}`,
          source: "page du site",
          bitmap: shot.bitmap,
          fromVisit: true,
          shot,
        });
        fromVisit += 1;
      }
    }

    const total = photos + fromVisit;
    say(`${total} visuel(s) exploitable(s). Écriture des scripts…`);

    if (total === 0) {
      warn(
        "Aucun visuel n'a pu être récupéré sur ce site, et aucune capture de vos pages n'a abouti : " +
          "les vidéos seront illustrées par vos couleurs seules. Ajoutez vos propres images dans le " +
          "formulaire pour un rendu nettement plus riche.",
      );
    } else if (photos === 0) {
      warn(
        `Ce site n'expose aucune photo réutilisable — c'est courant quand la page se construit ` +
          `toute seule. Les vidéos sont donc illustrées par ${fromVisit} vue(s) réelle(s) de votre ` +
          "site, prises une fois la page chargée. Ajoutez vos propres images dans le formulaire " +
          "pour les compléter.",
      );
    }

    const requested = Number(data.get("count"));
    const wanted = Number.isFinite(requested) && requested > 0 ? requested : requestedCount(brief);

    const mode = String(data.get("writer") ?? "builtin");
    try {
      localStorage.setItem("vido.writer", mode);
    } catch {
      /* stockage indisponible */
    }

    let plan;
    let writtenBy = "rédacteur intégré";

    // L'IA sur l'appareil : aucune clé, aucun compte, et la visite déjà faite lui
    // est décrite, pour qu'elle écrive en fonction de ce que la vidéo montrera.
    if (mode === "local") {
      const chosen = String(data.get("localmodel") ?? "");
      try {
        say(
          localModelReady(chosen)
            ? "Écriture des scripts par l'IA de votre appareil…"
            : "Préparation du modèle sur votre appareil — le premier chargement est long…",
        );
        plan = await writeWithLocalModel({
          site,
          brief,
          count: wanted,
          tour: visit.shots,
          model: chosen,
          onProgress: (message) => say(`IA locale — ${message}`),
        });
        writtenBy = "IA locale";
      } catch (error) {
        warn(
          `L'IA de votre appareil n'a pas pu écrire les scripts : ${error.message}\n\n` +
            "Le rédacteur intégré a pris le relais. Une clé gratuite, plus bas, donne un meilleur " +
            "résultat sans rien télécharger.",
        );
      }
    }

    // Service en ligne gratuit : rien à installer, mais la demande sort du
    // navigateur, et rien ne garantit qu'il réponde.
    if (!plan && mode === "free") {
      try {
        say("Écriture des scripts par une IA en ligne…");
        plan = await writeWithFreeModel({
          site,
          brief,
          count: wanted,
          tour: visit.shots,
          onProgress: (message) => say(`IA en ligne — ${message}`),
        });
        writtenBy = "IA en ligne gratuite";
      } catch (error) {
        warn(
          `${error.message}\n\nLes scripts ont été écrits par le rédacteur intégré à la place. ` +
            "L'IA sur votre appareil, dans le sélecteur, ne dépend d'aucun service extérieur.",
        );
      }
    }
    if (!plan) plan = writeCampaign(site, brief, wanted);
    // Le rattachement vient d'abord : le rédacteur intégré sait de quelle page
    // vient son sujet, un modèle non — et c'est cette page qui illustre la vidéo.
    attachSubjectPages(plan, site);
    illustrateScenes(plan, site);

    // Un plan sans vidéo finirait en silence sur « 0 vidéo prête », ce qui ne se
    // distingue pas d'une panne. Mieux vaut le dire, et dire quoi faire.
    if (!plan.videos || plan.videos.length === 0) {
      throw new Error(
        `Aucun script n'a pu être écrit à partir de ${site.domain}. La page a bien été lue, mais ` +
          "elle n'a donné ni fiche, ni section, ni texte exploitable. Essayez l'adresse d'une page " +
          "de contenu du site plutôt que sa page d'accueil.",
      );
    }
    stage("écriture des scripts", `${plan.videos.length} vidéo(s), par ${writtenBy}`);
    const via = preferredSource();
    say(`${plan.videos.length} vidéo(s) à monter pour ${plan.brandName}${via ? ` (lu via ${via})` : ""}.`);

    const audioContext = new (window.AudioContext ?? window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();

    const chosenMood = String(data.get("mood") ?? "none");
    const mood = MOOD_NAMES.includes(chosenMood) ? chosenMood : null;
    const withVoice = data.get("voice") !== "off";

    let voiceFailed = false;
    stageArea.hidden = false;
    jobId = await startJob({ url, brief, total: plan.videos.length }).catch(() => null);
    // Signe de vie régulier : c'est lui qui distingue une génération en cours
    // d'une génération abandonnée, y compris vue depuis un autre onglet.
    clearInterval(heartbeat);
    heartbeat = setInterval(() => void touchJob(jobId), 15000);
    // Le verrou meurt avec l'onglet : c'est lui qui dira, au retour, que cette
    // génération a été interrompue plutôt qu'elle tourne encore ailleurs.
    releaseJob = holdJob(jobId);
    for (const [index, video] of plan.videos.entries()) {
      const position = index + 1;

      // La page du sujet est peut-être encore en cours de capture : on lui laisse
      // un court délai. Sans cela, une vidéo sur un saint s'ouvrait sur l'accueil
      // du site simplement parce que sa page n'était pas arrivée à temps.
      if (video.pageUrl) {
        say(`Vidéo ${position}/${plan.videos.length} — on attend la page du sujet…`);
        await visit.waitFor(video.pageUrl, 12000);
      }

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
        // Les pages photographiées depuis le début de la visite : chaque vidéo montée
        // profite de celles qui sont arrivées entre-temps.
        tour: visit.shots,
        onStage: (step) => say(`Vidéo ${position}/${plan.videos.length} — ${step}`),
        onProgress: (ratio) => {
          const overall = (index + ratio) / plan.videos.length;
          bar.style.width = `${Math.round(overall * 100)}%`;
        },
      });
      addResult(video, file, position);

      // Écrite tout de suite, pas à la fin du lot : une interruption au montage de
      // la suivante laisse celle-ci intacte.
      try {
        await rememberVideo({
          jobId,
          domain: site.domain,
          siteUrl: site.url,
          brief,
          title: video.youtubeTitle,
          description: video.youtubeDescription,
          hashtags: video.hashtags,
          slug: video.slug,
          position,
          durationSeconds: file.durationSeconds,
          extension: file.extension,
          width: canvas.width,
          height: canvas.height,
          spokenScenes: file.spokenScenes,
          totalScenes: file.totalScenes,
          thumbnail: file.thumbnail,
          blob: file.blob,
        });
        await updateJob(jobId, { done: position, stage: `vidéo ${position} montée` });
      } catch (error) {
        warn(
          `La vidéo ${position} n'a pas pu être gardée en mémoire (${error.message}). ` +
            "Elle reste téléchargeable ci-dessus, mais elle disparaîtra si vous rechargez la page.",
        );
      }

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
        `visuels : ${loaded} photo(s) du site` +
          `${ownImages.length > 0 ? `, ${ownImages.length} fournie(s) par vous` : ""}` +
          `${fromVisit > 0 ? `, ${fromVisit} vue(s) de vos pages` : ""}`,
        `scripts : ${writtenBy}`,
        `musique : ${chosenMood === "none" ? "aucune" : chosenMood === "file" ? "votre fichier" : `composée (${mood})`}`,
        `visite : ${
          visit.shots.length > 0
            ? visit.shots
                .map((shot) => `${shot.label} (${shot.via}, détail ${shot.detail.toFixed(2)})`)
                .join(" · ")
            : "aucune page photographiée"
        }`,
        site.interactive ? `chargement attendu : ${site.interactive}` : "page statique, capture immédiate",
      ].join("\n"),
    );
    stageArea.hidden = true;
    await updateJob(jobId, { status: "terminé", stage: "terminé" });
    say(`${plan.videos.length} vidéo(s) prête(s). Enregistrez-les puis publiez-les.`, "done");
  } catch (error) {
    stageArea.hidden = true;
    // La génération s'arrête, mais ce qui a déjà été monté reste en mémoire :
    // l'état enregistré doit le dire, sinon le relevé au retour serait faux.
    await updateJob(jobId, { status: "arrêté", stage: "arrêté", error: String(error.message) });
    say("La génération s'est arrêtée.", "error");
    warn(explain(error, url));
    showReport(null, `arrêt : ${error.message}`);
  } finally {
    clearInterval(elapsedTimer);
    clearInterval(heartbeat);
    releaseJob();
    releaseJob = () => {};
    submit.disabled = false;
    running = false;
    jobId = null;
    await releaseScreen();
    await refreshLibrary();
  }
});
