/**
 * Mémoire de Vid-O : les vidéos produites, et la génération en cours.
 *
 * Jusqu'ici tout vivait dans l'onglet. Fermer la page, la recharger, ou
 * simplement manquer de mémoire au milieu d'un montage, et le travail était
 * perdu — y compris les vidéos déjà terminées. Elles sont désormais écrites au
 * fur et à mesure dans IndexedDB, seul stockage du navigateur capable de garder
 * des fichiers vidéo : `localStorage` ne prend que du texte, et quelques dizaines
 * de mégaoctets de vidéo n'y entreraient pas.
 *
 * La génération en cours est notée elle aussi. Si la page disparaît pendant un
 * montage, on sait au retour ce qui tournait, ce qui a été sauvé, et de quoi
 * relancer le reste.
 */

const DB_NAME = "vido";
const DB_VERSION = 1;
const VIDEOS = "videos";
const JOBS = "jobs";

/** Au-delà, les plus anciennes sont effacées : un téléphone n'a pas de place infinie. */
const MAX_VIDEOS = 24;

let database = null;

function openDatabase() {
  if (database) return database;

  database = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Ce navigateur ne sait pas garder de fichiers hors ligne."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VIDEOS)) {
        const store = db.createObjectStore(VIDEOS, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(JOBS)) {
        const store = db.createObjectStore(JOBS, { keyPath: "id" });
        store.createIndex("startedAt", "startedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("stockage indisponible"));
  }).catch((error) => {
    // Une base inaccessible — navigation privée, stockage refusé — ne doit pas
    // empêcher de fabriquer des vidéos. On le retient pour ne pas réessayer sans fin.
    database = null;
    throw error;
  });

  return database;
}

function run(storeName, mode, work) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let result;
        try {
          result = work(store);
        } catch (error) {
          reject(error);
          return;
        }
        transaction.oncomplete = () => resolve(result?.result ?? result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("écriture refusée"));
      }),
  );
}

const request = (store, method, ...args) =>
  new Promise((resolve, reject) => {
    const query = store[method](...args);
    query.onsuccess = () => resolve(query.result);
    query.onerror = () => reject(query.error);
  });

/** La mémoire est-elle utilisable ici ? */
export async function memoryAvailable() {
  try {
    await openDatabase();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Vidéos
 * ------------------------------------------------------------------ */

/**
 * Enregistre une vidéo terminée. Appelée dès qu'une vidéo est prête, jamais à la
 * fin du lot : c'est ce qui fait qu'une interruption au montage de la quatrième
 * laisse les trois premières intactes.
 */
export async function rememberVideo(entry) {
  const record = {
    id: entry.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: entry.createdAt ?? Date.now(),
    jobId: entry.jobId ?? null,
    domain: entry.domain ?? "",
    siteUrl: entry.siteUrl ?? "",
    brief: entry.brief ?? "",
    title: entry.title ?? "",
    description: entry.description ?? "",
    hashtags: entry.hashtags ?? [],
    slug: entry.slug ?? "video",
    position: entry.position ?? 1,
    durationSeconds: entry.durationSeconds ?? 0,
    extension: entry.extension ?? "mp4",
    width: entry.width ?? 0,
    height: entry.height ?? 0,
    spokenScenes: entry.spokenScenes ?? 0,
    totalScenes: entry.totalScenes ?? 0,
    thumbnail: entry.thumbnail ?? "",
    bytes: entry.blob?.size ?? 0,
    blob: entry.blob,
  };

  try {
    await run(VIDEOS, "readwrite", (store) => store.put(record));
  } catch (error) {
    // Plus de place : on fait le ménage et on réessaie une fois. Garder la vidéo
    // la plus récente vaut mieux que garder la plus ancienne.
    if (String(error?.name) === "QuotaExceededError") {
      await forgetOldest(4);
      await run(VIDEOS, "readwrite", (store) => store.put(record));
    } else {
      throw error;
    }
  }

  await forgetOldest(0);
  return record.id;
}

/** Toutes les vidéos en mémoire, de la plus récente à la plus ancienne. */
export async function rememberedVideos() {
  const all = await run(VIDEOS, "readonly", (store) => request(store, "getAll"));
  return (all ?? []).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Ramène la mémoire sous la limite. `extra` efface en plus, pour se faire de la
 * place avant une écriture qui vient d'échouer.
 */
export async function forgetOldest(extra = 0) {
  const all = await rememberedVideos();
  const keep = Math.max(0, MAX_VIDEOS - extra);
  const doomed = all.slice(keep);
  if (doomed.length === 0) return 0;
  await run(VIDEOS, "readwrite", (store) => {
    for (const entry of doomed) store.delete(entry.id);
  });
  return doomed.length;
}

export async function forgetVideo(id) {
  await run(VIDEOS, "readwrite", (store) => store.delete(id));
}

export async function forgetEverything() {
  await run(VIDEOS, "readwrite", (store) => store.clear());
  await run(JOBS, "readwrite", (store) => store.clear());
}

/** Place occupée par la mémoire, et place disponible quand le navigateur la connaît. */
export async function memoryUsage() {
  const all = await rememberedVideos();
  const bytes = all.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  let quota = null;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota) quota = estimate.quota;
  } catch {
    /* le navigateur ne dit pas sa capacité : on s'en passe */
  }
  return { count: all.length, bytes, quota };
}

/* ------------------------------------------------------------------ *
 * Générations
 * ------------------------------------------------------------------ */

/**
 * Ouvre une génération. L'identifiant sert ensuite à rattacher les vidéos
 * produites, et à reconnaître au retour une génération restée en plan.
 */
export async function startJob({ url, brief, total }) {
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    url,
    brief,
    total: total ?? 0,
    done: 0,
    status: "en-cours",
    stage: "démarrage",
    error: "",
  };
  await run(JOBS, "readwrite", (store) => store.put(job)).catch(() => {});
  return job.id;
}

export async function updateJob(id, patch) {
  if (!id) return;
  try {
    const existing = await run(JOBS, "readonly", (store) => request(store, "get", id));
    if (!existing) return;
    await run(JOBS, "readwrite", (store) => store.put({ ...existing, ...patch, updatedAt: Date.now() }));
  } catch {
    /* la mémoire n'est pas indispensable au montage en cours */
  }
}

export async function jobs() {
  const all = await run(JOBS, "readonly", (store) => request(store, "getAll")).catch(() => []);
  return (all ?? []).sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Une génération vivante donne signe de vie régulièrement. Ce délai ne sert que
 * lorsque les verrous ne sont pas disponibles ; il est long, parce qu'un signe de
 * vie peut tarder sur un appareil chargé.
 */
const HEARTBEAT_TIMEOUT = 45_000;

/** Signale qu'une génération est toujours en cours. */
export async function touchJob(id) {
  await updateJob(id, {});
}

const lockName = (id) => `vido.job.${id}`;

/**
 * Prend un verrou pour toute la durée d'une génération, et rend de quoi le
 * relâcher. Le navigateur le libère tout seul quand l'onglet disparaît : c'est ce
 * qui permet de distinguer, sans attendre, une génération qui tourne ailleurs
 * d'une génération dont l'onglet a été fermé.
 */
export function holdJob(id) {
  if (!id || !navigator.locks?.request) return () => {};
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  navigator.locks.request(lockName(id), () => held).catch(() => {});
  return release;
}

/** Cette génération tourne-t-elle encore quelque part ? */
async function jobIsAlive(id) {
  try {
    const state = await navigator.locks.query();
    return [...(state.held ?? []), ...(state.pending ?? [])].some((lock) => lock.name === lockName(id));
  } catch {
    return false;
  }
}

/**
 * Générations restées « en cours » alors que plus rien ne tourne : la page a été
 * fermée ou rechargée au milieu. On les marque interrompues au retour, une fois,
 * pour pouvoir le dire à l'utilisateur au lieu de laisser un état faux en mémoire.
 *
 * Savoir si elle tourne encore est indispensable : sans cela, ouvrir un second
 * onglet aurait déclaré interrompue une génération en train de tourner dans le
 * premier, puisque les deux onglets partagent la même mémoire. Le verrou répond
 * tout de suite ; à défaut, on se rabat sur l'ancienneté du dernier signe de vie.
 */
export async function closeStaleJobs(exceptId = null) {
  const all = await jobs();
  const locks = Boolean(navigator.locks?.query);
  const stale = [];

  for (const job of all) {
    if (job.status !== "en-cours" || job.id === exceptId) continue;
    const alive = locks
      ? await jobIsAlive(job.id)
      : Date.now() - (job.updatedAt ?? job.startedAt) <= HEARTBEAT_TIMEOUT;
    if (alive) continue;
    await updateJob(job.id, { status: "interrompu", stage: "interrompu" });
    stale.push(job);
  }
  return stale;
}
