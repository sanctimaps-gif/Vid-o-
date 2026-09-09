const form = document.querySelector("#form");
const submit = document.querySelector("#submit");
const warning = document.querySelector("#warning");
const progress = document.querySelector("#progress");
const progressTitle = document.querySelector("#progress-title");
const spinner = document.querySelector(".spinner");
const logList = document.querySelector("#log");
const results = document.querySelector("#results");
const grid = document.querySelector("#grid");

const STEP_LABELS = {
  start: "départ",
  scrape: "site",
  images: "visuels",
  script: "script",
  render: "montage",
  done: "terminé",
  error: "erreur",
};

fetch("/api/config")
  .then((response) => response.json())
  .then((config) => {
    document.querySelector("#outdir").textContent = config.outDir;
    if (!config.hasApiKey) {
      warning.hidden = false;
      warning.textContent =
        "ANTHROPIC_API_KEY n'est pas défini côté serveur : la rédaction des scripts échouera. " +
        "Renseignez la clé dans le fichier .env puis relancez le serveur.";
    }
  })
  .catch(() => {
    /* l'interface reste utilisable même si la config n'est pas lisible */
  });

function addLogLine(step, detail, isError) {
  const item = document.createElement("li");
  if (isError) item.classList.add("is-error");

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = STEP_LABELS[step] ?? step;

  const text = document.createElement("span");
  text.textContent = detail || "…";

  item.append(tag, text);
  logList.append(item);
  logList.scrollTop = logList.scrollHeight;
}

function renderVideos(videos) {
  grid.replaceChildren();
  for (const video of videos) {
    const card = document.createElement("article");
    card.className = "video-card";

    const player = document.createElement("video");
    player.src = video.videoUrl;
    player.poster = video.thumbnailUrl;
    player.controls = true;
    player.preload = "none";
    player.playsInline = true;

    const body = document.createElement("div");
    body.className = "video-body";

    const title = document.createElement("h3");
    title.textContent = video.title;

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${video.position} — ${video.durationSeconds}s — ${video.concept}`;

    const description = document.createElement("pre");
    description.className = "desc";
    description.textContent = video.description;

    const actions = document.createElement("div");
    actions.className = "actions";

    const download = document.createElement("a");
    download.href = video.videoUrl;
    download.download = "";
    download.textContent = "Télécharger";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copier le texte";
    copy.addEventListener("click", async () => {
      const payload = `${video.title}\n\n${video.description}`;
      try {
        await navigator.clipboard.writeText(payload);
        copy.textContent = "Copié";
      } catch {
        copy.textContent = "Copie refusée";
      }
      setTimeout(() => {
        copy.textContent = "Copier le texte";
      }, 1800);
    });

    actions.append(download, copy);
    body.append(title, meta, description, actions);
    card.append(player, body);
    grid.append(card);
  }
  results.hidden = videos.length === 0;
}

function follow(jobId) {
  const source = new EventSource(`/api/jobs/${jobId}/events`);

  source.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.step === "final") {
      source.close();
      const job = payload.job;
      spinner.classList.add("stopped");
      submit.disabled = false;

      if (job.status === "error") {
        progressTitle.textContent = "La génération a échoué";
        warning.hidden = false;
        warning.textContent = job.error ?? "Erreur inconnue.";
      } else {
        progressTitle.textContent = `${job.videos.length} vidéo(s) prête(s)`;
        renderVideos(job.videos);
      }
      return;
    }

    if (payload.step === "done-video") return;
    addLogLine(payload.step, payload.detail, payload.step === "error");
  });

  source.addEventListener("error", () => {
    // Le flux se ferme normalement à la fin ; on ne prévient que si le travail est encore en cours.
    if (source.readyState === EventSource.CLOSED && submit.disabled) {
      source.close();
      submit.disabled = false;
      spinner.classList.add("stopped");
      progressTitle.textContent = "Connexion au serveur interrompue";
    }
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);

  submit.disabled = true;
  warning.hidden = true;
  progress.hidden = false;
  spinner.classList.remove("stopped");
  progressTitle.textContent = "Génération en cours…";
  logList.replaceChildren();
  results.hidden = true;
  grid.replaceChildren();

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: data.get("url"),
        brief: data.get("brief"),
        count: data.get("count") || undefined,
        tts: data.get("tts") || undefined,
        voice: data.get("voice") || undefined,
      }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Requête refusée.");
    follow(payload.id);
  } catch (error) {
    submit.disabled = false;
    spinner.classList.add("stopped");
    progressTitle.textContent = "La génération n'a pas démarré";
    warning.hidden = false;
    warning.textContent = error.message;
  }
});
