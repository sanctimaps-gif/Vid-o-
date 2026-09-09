import { crawlSite, loadImages } from "./scrape.js";
import { writeCampaign, requestedCount } from "./writer.js";
import { isSupported, renderVideo } from "./render.js";

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

let musicBuffer = null;

function say(message, kind = "info") {
  statusLine.textContent = message;
  statusLine.dataset.kind = kind;
}

function warn(message) {
  notice.hidden = false;
  notice.textContent = message;
}

if (!isSupported()) {
  warn(
    "Ce navigateur ne sait pas enregistrer une vidéo depuis une page web. " +
      "Safari 17+, Chrome et Firefox à jour fonctionnent. Vous pouvez aussi utiliser la version ordinateur, plus bas.",
  );
  submit.disabled = true;
}

/* ------------------------------------------------------------------ *
 * Musique de fond, choisie dans les fichiers de l'appareil
 * ------------------------------------------------------------------ */

$("#music").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    musicBuffer = null;
    return;
  }
  try {
    const audioContext = new (window.AudioContext ?? window.webkitAudioContext)();
    musicBuffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    await audioContext.close();
    $("#music-label").textContent = `${file.name} — ajoutée en fond sonore`;
  } catch {
    musicBuffer = null;
    $("#music-label").textContent = "Fichier audio illisible, il sera ignoré.";
  }
});

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
  meta.textContent = `${index} — ${file.durationSeconds}s — ${canvas.width}×${canvas.height}`;

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
  notice.hidden = true;
  panel.hidden = false;
  results.hidden = true;
  grid.replaceChildren();
  stage.hidden = true;
  bar.style.width = "0%";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    say("Lecture du site…");
    const site = await crawlSite(url, { onProgress: (message) => say(`Lecture du site — ${message}`) });
    say(`${site.products.length} fiche(s) trouvée(s), téléchargement des visuels…`);

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
    say(`${plan.videos.length} vidéo(s) à monter pour ${plan.brandName}.`);

    stage.hidden = false;
    for (const [index, video] of plan.videos.entries()) {
      const position = index + 1;
      say(`Montage ${position}/${plan.videos.length} — ${video.concept}`);
      const file = await renderVideo({
        video,
        plan,
        site,
        canvas,
        position,
        total: plan.videos.length,
        music: musicBuffer,
        onProgress: (ratio) => {
          const overall = (index + ratio) / plan.videos.length;
          bar.style.width = `${Math.round(overall * 100)}%`;
        },
      });
      addResult(video, file, position);
    }

    bar.style.width = "100%";
    stage.hidden = true;
    say(`${plan.videos.length} vidéo(s) prête(s). Enregistrez-les puis publiez-les.`, "done");
  } catch (error) {
    stage.hidden = true;
    say("La génération s'est arrêtée.", "error");
    warn(
      `${error.message}\n\nSi le site refuse d'être lu depuis un navigateur, essayez la version ordinateur : elle lit les sites directement.`,
    );
  } finally {
    submit.disabled = false;
  }
});
