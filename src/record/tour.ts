/**
 * Visite filmée d'un site, dans un vrai navigateur.
 *
 * Les autres modes de Vid-O fabriquent une vidéo *à partir* d'un site : ils en
 * tirent des textes et des images, puis composent des plans. Celui-ci filme le
 * site lui-même pendant qu'on s'en sert — la carte qu'on déplace, le repère qu'on
 * ouvre, la recherche qu'on saisit. C'est la seule façon de montrer une interface
 * en fonctionnement, et aucune capture d'écran fixe ne la remplace.
 *
 * Cela demande un navigateur que l'on pilote, donc Playwright. La page
 * navigateur de Vid-O ne peut pas le faire : le JavaScript d'un site n'a pas le
 * droit de lire les pixels d'un autre site, quelle que soit la méthode.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../util/log.js";

export interface TourOptions {
  url: string;
  /** Dossier où déposer l'enregistrement brut. */
  outDir: string;
  /** Durée visée de la visite, en secondes. */
  seconds?: number;
  /** Largeur du viewport, en pixels CSS. La hauteur suit le format 9/16. */
  width?: number;
  /** Secondes laissées à la page avant de commencer à filmer. */
  settle?: number;
  /** Ce qu'on tape dans la recherche. Sans valeur, un mot du site est déduit. */
  search?: string;
  onProgress?: (message: string) => void;
}

export interface TourResult {
  /** Fichier WebM produit par le navigateur. */
  video: string;
  /** Ce qu'on a effectivement fait devant la caméra. */
  steps: string[];
  siteName: string;
  description: string;
  /** Adresse d'un logo utilisable pour la carte de fin, si le site en déclare un. */
  logo: string | null;
  seconds: number;
}

/** Playwright n'est pas obligatoire pour le reste de Vid-O : on le charge à la demande. */
async function loadPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "La visite filmée a besoin de Playwright et d'un navigateur.\n\n" +
        "  npm install playwright\n" +
        "  npx playwright install chromium\n\n" +
        "C'est le seul moyen de filmer un site en fonctionnement : un navigateur doit " +
        "réellement l'ouvrir et s'en servir.",
    );
  }
}

/**
 * Conteneurs de carte les plus répandus. Leur présence change la façon de filmer :
 * on déplace et on zoome au lieu de faire défiler la page.
 */
const MAP_SELECTORS = [
  ".leaflet-container",
  ".mapboxgl-map",
  ".maplibregl-map",
  ".ol-viewport",
  "[class*='mapbox']",
  "#map",
  "[id*='map'][class*='container']",
  "canvas",
];

/** Ce qui ressemble à un repère cliquable sur une carte. */
const MARKER_SELECTORS = [
  ".leaflet-marker-icon",
  ".mapboxgl-marker",
  ".maplibregl-marker",
  "[class*='marker']",
  "[class*='pin']",
];

/** Champs de recherche, du plus explicite au plus approximatif. */
const SEARCH_INPUTS = [
  "input[type='search']",
  "input[name*='search' i]",
  "input[name*='recherche' i]",
  "input[placeholder*='recherch' i]",
  "input[placeholder*='search' i]",
  "[role='searchbox']",
  "[class*='search'] input",
  "#search input, input#search, input#q",
];

/** Ce qui ouvre une recherche quand le champ n'est pas déjà à l'écran. */
const SEARCH_TRIGGERS = [
  "[aria-label*='recherch' i]",
  "[aria-label*='search' i]",
  "button[class*='search' i]",
  "[class*='search-button' i]",
  "[class*='searchButton' i]",
];

/** Ce qui ouvre un menu, quand la recherche y est rangée. */
const MENU_TRIGGERS = [
  "[aria-label*='menu' i]",
  "button[class*='burger' i]",
  "button[class*='hamburger' i]",
  "[class*='menu-toggle' i]",
  "header button",
];

/** Ce qui ressemble à un résultat de recherche cliquable. */
const RESULT_SELECTORS = [
  "[class*='result'] a",
  "[class*='result'] li",
  "[class*='resultat'] a",
  "[role='option']",
  "[class*='suggestion'] a, [class*='suggestion'] li",
  "ul li a",
];

/**
 * Premier élément visible et cliquable parmi une liste de sélecteurs.
 *
 * La largeur et la hauteur ont des exigences distinctes : un champ de recherche
 * est large et plat, et un seuil unique de 60 px le rejetait sur sa hauteur.
 */
async function firstVisible(
  page: any,
  selectors: string[],
  minWidth = 8,
  minHeight = 8,
): Promise<any | null> {
  const view = page.viewportSize() ?? { width: 540, height: 960 };

  for (const selector of selectors) {
    const found = page.locator(selector).first();
    const visible = await found.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await found.boundingBox().catch(() => null);
    if (!box || box.width < minWidth || box.height < minHeight) continue;
    // `isVisible` se contente d'un élément dessiné : un panneau simplement décalé
    // hors du cadre le satisfait encore. On exige donc qu'il soit dans la fenêtre,
    // sans quoi on croyait tenir un champ de recherche invisible à l'écran.
    const inside =
      box.x + box.width > 4 && box.x < view.width - 4 && box.y + box.height > 4 && box.y < view.height - 4;
    if (inside) return found;
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Déplace la carte comme un doigt le ferait : appui, glissement progressif, relâché.
 * Un saut d'un point à l'autre ne déclenche pas les gestionnaires de déplacement,
 * et à l'image cela ne ressemblerait à rien.
 */
async function swipe(page: any, from: [number, number], by: [number, number], steps = 18): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    const eased = 1 - Math.pow(1 - step / steps, 3); // départ franc, arrivée douce
    await page.mouse.move(from[0] + by[0] * eased, from[1] + by[1] * eased);
    await sleep(16);
  }
  await page.mouse.up();
}

/** Zoom à la molette, par petits crans : d'un coup, le rendu saute. */
async function zoom(page: any, at: [number, number], direction: 1 | -1, notches = 4): Promise<void> {
  await page.mouse.move(at[0], at[1]);
  for (let notch = 0; notch < notches; notch += 1) {
    await page.mouse.wheel(0, direction * -120);
    await sleep(220);
  }
}

/**
 * Un mot à taper dans la recherche, déduit du site lui-même.
 *
 * Une requête inventée ne donne aucun résultat, et une démonstration qui affiche
 * « aucun résultat » dessert le site. On prend donc le mot qui revient le plus en
 * tête des intitulés de la page — « Saint » sur un site de saints — puisque c'est
 * celui qui a le plus de chances de ramener plusieurs entrées.
 */
async function deriveQuery(page: any): Promise<string | null> {
  // Les intitulés ne sont pas toujours du texte : un repère de carte porte souvent
  // son nom en `title`, `aria-label` ou `alt`, et son contenu visible n'est qu'un
  // pictogramme. On ramasse les deux.
  const texts: string[] = await page
    .$$eval("a, [class*='marker'], [class*='pin'], [class*='item'], li, [title], [aria-label], img[alt]", (
      nodes: Element[],
    ) =>
      nodes
        .flatMap((node) => [
          (node.textContent || "").replace(/\s+/g, " ").trim(),
          (node.getAttribute("title") || "").trim(),
          (node.getAttribute("aria-label") || "").trim(),
          (node.getAttribute("alt") || "").trim(),
        ])
        .filter((text) => text.length > 3 && text.length < 60)
        .slice(0, 400),
    )
    .catch(() => [] as string[]);

  const counts = new Map<string, number>();
  for (const text of texts) {
    const word = text.split(" ")[0]?.replace(/[^\p{L}\p{N}'-]/gu, "") ?? "";
    if (word.length < 4) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  // Un mot qui n'apparaît qu'une fois ne prouve rien : mieux vaut ne pas chercher.
  if (best && best[1] >= 2) return best[0];

  // Rien de répété dans les intitulés : on se rabat sur le mot propre le plus
  // fréquent du texte de la page, qui reste un terme que le site connaît.
  const words: string[] = await page
    .evaluate(() => (document.body.innerText || "").split(/\s+/).slice(0, 4000))
    .catch(() => [] as string[]);

  const proper = new Map<string, number>();
  for (const raw of words) {
    const word = raw.replace(/[^\p{L}\p{N}'-]/gu, "");
    if (word.length < 4 || word.length > 20) continue;
    if (!/^\p{Lu}/u.test(word)) continue;
    proper.set(word, (proper.get(word) ?? 0) + 1);
  }
  const bestProper = [...proper.entries()].sort((a, b) => b[1] - a[1])[0];
  return bestProper && bestProper[1] >= 2 ? bestProper[0] : null;
}

/**
 * Saisit la requête lettre par lettre. Coller le texte d'un coup ne déclenche pas
 * toujours les gestionnaires de saisie, et à l'image la recherche n'aurait l'air
 * de rien : c'est la liste qui se resserre au fil des lettres qui fait la
 * démonstration.
 */
async function typeQuery(input: any, text: string): Promise<void> {
  await input.click({ timeout: 4000 });
  await sleep(500);
  if (typeof input.pressSequentially === "function") {
    await input.pressSequentially(text, { delay: 140 });
  } else {
    await input.type(text, { delay: 140 });
  }
}

/**
 * Démonstration de la recherche : on ouvre le champ — en passant par le menu s'il
 * y est rangé —, on tape, on laisse la liste se remplir, puis on ouvre un
 * résultat. Chaque étape peut manquer sans faire échouer la visite : un site sans
 * recherche est filmé autrement, ce n'est pas une panne.
 */
async function demoSearch(
  page: any,
  options: { query?: string; steps: string[]; onProgress?: (message: string) => void },
): Promise<boolean> {
  const { steps, onProgress } = options;

  let input = await firstVisible(page, SEARCH_INPUTS, 120, 24);

  // Champ absent de l'écran : il est peut-être derrière une loupe, ou dans le menu.
  if (!input) {
    for (const triggers of [SEARCH_TRIGGERS, MENU_TRIGGERS]) {
      const trigger = await firstVisible(page, triggers);
      if (!trigger) continue;
      await trigger.click({ timeout: 3000 }).catch(() => {});
      steps.push(triggers === MENU_TRIGGERS ? "ouverture du menu" : "ouverture de la recherche");
      await sleep(1100);
      input = await firstVisible(page, SEARCH_INPUTS, 120, 24);
      if (input) break;
    }
  }
  if (!input) return false;

  const query = options.query || (await deriveQuery(page));
  if (!query) return false;

  // Ce qui est déjà à l'écran avant la frappe : tout le reste sera du résultat.
  const before = new Set<string>(
    await page
      .$$eval("a, li, [role='option'], [class*='item'], [class*='res'] *", (nodes: Element[]) =>
        nodes.map((node) =>
          ((node as HTMLElement).innerText || node.textContent || "").replace(/\s+/g, " ").trim(),
        ),
      )
      .catch(() => [] as string[]),
  );

  onProgress?.(`recherche « ${query} »`);
  await typeQuery(input, query).catch(() => {});
  steps.push(`recherche « ${query} »`);
  // La liste met un instant à se remplir, et il faut la laisser se lire.
  await sleep(1800);

  const result = await firstVisible(page, RESULT_SELECTORS, 60, 18);
  if (result) {
    await result.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(400);
    await result.click({ timeout: 3000 }).catch(() => {});
    steps.push("ouverture d'un résultat");
    await sleep(2200);
    return true;
  }

  // Les classes des listes de résultats n'ont aucune convention : plutôt que de
  // deviner des noms, on retient ce qui est apparu pendant la frappe. Un intitulé
  // qui n'existait pas avant la saisie et qui s'affiche sous le champ est un
  // résultat, quel que soit le nom que le site lui donne.
  const opened = await clickNewResult(page, input, before, steps);
  if (opened) await sleep(2200);
  return true;
}

async function clickNewResult(
  page: any,
  input: any,
  before: Set<string>,
  steps: string[],
): Promise<boolean> {
  const view = page.viewportSize() ?? { width: 540, height: 960 };
  const inputBox = await input.boundingBox().catch(() => null);
  const candidates = page.locator("a, li, [role='option'], [class*='item'], [class*='res'] *");
  const total = Math.min(await candidates.count().catch(() => 0), 80);

  for (let index = 0; index < total; index += 1) {
    const node = candidates.nth(index);
    if (!(await node.isVisible().catch(() => false))) continue;

    const text = (await node.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 120 || before.has(text)) continue;

    const box = await node.boundingBox().catch(() => null);
    if (!box || box.width < 40 || box.height < 14) continue;
    if (box.x > view.width - 4 || box.y > view.height - 4 || box.x + box.width < 4) continue;
    // Une liste de résultats s'affiche sous son champ, jamais au-dessus.
    if (inputBox && box.y + box.height < inputBox.y) continue;

    await node.click({ timeout: 3000 }).catch(() => {});
    steps.push(`ouverture du résultat « ${text.split("\n")[0]!.slice(0, 40)} »`);
    return true;
  }
  return false;
}

/** Attend que la page cesse de bouger : c'est le signe que la carte a fini de se dessiner. */
async function waitUntilStill(page: any, limitMs: number): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  let previous = "";
  let stable = 0;

  while (Date.now() < deadline) {
    const shot = await page.screenshot({ type: "jpeg", quality: 30 }).catch(() => null);
    const signature = shot ? `${shot.length}` : "";
    if (signature && signature === previous) {
      stable += 1;
      if (stable >= 2) return true;
    } else {
      stable = 0;
    }
    previous = signature;
    await sleep(600);
  }
  return false;
}

export async function recordTour(options: TourOptions): Promise<TourResult> {
  const { url, outDir, seconds = 22, width = 540, settle = 2.5, search, onProgress } = options;
  const height = Math.round((width * 16) / 9);
  const rawDir = path.join(outDir, "raw");
  await fs.mkdir(rawDir, { recursive: true });

  const { chromium } = await loadPlaywright();
  const executablePath = process.env.VIDO_CHROMIUM || undefined;

  const browser = await chromium.launch({
    executablePath,
    args: ["--hide-scrollbars", "--autoplay-policy=no-user-gesture-required"],
  });

  // Le format d'enregistrement est celui du viewport : Playwright ne sait pas
  // agrandir, il ajouterait des bandes grises. L'agrandissement vient après, au
  // montage, où l'on maîtrise le filtre.
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "fr-FR",
    recordVideo: { dir: rawDir, size: { width, height } },
  });

  const page = await context.newPage();
  const steps: string[] = [];
  let siteName = "";
  let description = "";
  let logo: string | null = null;

  try {
    onProgress?.("ouverture du site");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});

    // Attention : le code passé à `evaluate` part tel quel dans la page. Il ne doit
    // déclarer aucune fonction interne — l'outil qui compile ce fichier les nomme
    // via un helper (`__name`) qui, lui, n'existe pas dans le navigateur. Tout est
    // donc écrit en expressions, et l'échec est signalé au lieu d'être avalé.
    let meta = { name: "", description: "", image: "" };
    try {
      meta = await page.evaluate(() => ({
        name:
          document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim() ||
          document.title ||
          "",
        description:
          document.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() ||
          document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ||
          "",
        image:
          document.querySelector('meta[property="og:image"]')?.getAttribute("content")?.trim() || "",
      }));
    } catch (error) {
      log.warn(`identité du site illisible : ${(error as Error).message.split("\n")[0]}`);
    }
    siteName = meta.name;
    description = meta.description;
    logo = meta.image || null;

    onProgress?.("on laisse la page finir de se charger");
    await waitUntilStill(page, Math.max(4000, settle * 1000 + 6000));

    const mapHandle = await (async () => {
      for (const selector of MAP_SELECTORS) {
        const found = page.locator(selector).first();
        if (await found.count().then((n: number) => n > 0).catch(() => false)) {
          const box = await found.boundingBox().catch(() => null);
          // Une carte occupe une vraie surface : un petit canvas décoratif n'en est pas une.
          if (box && box.width > width * 0.6 && box.height > height * 0.35) return { selector, box };
        }
      }
      return null;
    })();

    const centre: [number, number] = mapHandle
      ? [mapHandle.box.x + mapHandle.box.width / 2, mapHandle.box.y + mapHandle.box.height / 2]
      : [width / 2, height / 2];

    // À partir d'ici, tout est filmé. Le rythme compte autant que les gestes :
    // une pause après chaque action laisse le spectateur voir ce qui se passe.
    const until = Date.now() + seconds * 1000;
    const remaining = () => until - Date.now();

    if (mapHandle) {
      steps.push(`carte détectée (${mapHandle.selector})`);
      onProgress?.("visite de la carte");

      await sleep(900);
      await swipe(page, centre, [width * 0.22, -height * 0.08]);
      steps.push("déplacement de la carte");
      await sleep(700);

      if (remaining() > 6000) {
        // Deux crans seulement : enchaîner les zooms finissait par cadrer le vide
        // entre deux repères, ce qui ne montre plus rien du site.
        await zoom(page, centre, 1, 2);
        steps.push("zoom avant");
        await sleep(900);
      }

      // Un repère ouvert, c'est ce qui montre à quoi sert le site.
      if (remaining() > 6000) {
        for (const selector of MARKER_SELECTORS) {
          const markers = page.locator(selector);
          const count = await markers.count().catch(() => 0);
          if (count === 0) continue;
          const marker = markers.nth(Math.min(count - 1, Math.floor(count / 2)));
          const box = await marker.boundingBox().catch(() => null);
          if (!box) continue;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await sleep(250);
          await marker.click({ timeout: 3000 }).catch(() => {});
          steps.push("ouverture d'un repère");
          await sleep(2200);
          break;
        }
      }

      // La recherche est la démonstration la plus parlante : elle montre à quoi
      // sert le site, pas seulement à quoi il ressemble. On lui garde du temps.
      if (remaining() > 9000) {
        const searched = await demoSearch(page, { query: search, steps, onProgress });
        if (searched) await sleep(1400);
      }

      if (remaining() > 5000) {
        await swipe(page, centre, [-width * 0.18, height * 0.12]);
        steps.push("déplacement de la carte");
        await sleep(800);
      }
      // On revient à la vue d'ensemble pour finir : une visite se termine sur ce
      // qu'on a parcouru, pas sur un gros plan de nulle part.
      if (remaining() > 4000) {
        await zoom(page, centre, -1, 2);
        steps.push("retour à la vue d'ensemble");
        await sleep(1200);
      }
    } else {
      steps.push("aucune carte : parcours de la page");
      onProgress?.("parcours de la page");

      // Une recherche vaut aussi sur un site sans carte : c'est encore le geste
      // qui montre le mieux ce qu'on peut y faire.
      if (remaining() > 9000) {
        const searched = await demoSearch(page, { query: search, steps, onProgress });
        if (searched) await sleep(1200);
      }

      const height2 = await page.evaluate(() => document.body.scrollHeight).catch(() => height);
      const stops = Math.max(2, Math.min(5, Math.round(height2 / height)));
      for (let stop = 1; stop <= stops && remaining() > 3000; stop += 1) {
        await page.evaluate(
          ([to]: number[]) => window.scrollTo({ top: to, behavior: "smooth" }),
          [Math.round((height2 - height) * (stop / stops))],
        );
        steps.push("défilement");
        await sleep(1600);
      }
    }

    // On tient la durée demandée, sans rien laisser figé trop longtemps.
    while (remaining() > 1200) {
      await swipe(page, centre, [width * 0.12, -height * 0.05], 14);
      await sleep(Math.min(1500, Math.max(300, remaining() - 900)));
    }
    await sleep(Math.max(0, remaining()));
  } finally {
    // La vidéo n'est écrite qu'à la fermeture du contexte.
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const files = (await fs.readdir(rawDir)).filter((file) => file.endsWith(".webm"));
  if (files.length === 0) throw new Error("Le navigateur n'a produit aucun enregistrement.");
  const video = path.join(rawDir, files[0]!);

  log.info(`visite filmée : ${steps.join(" · ")}`);
  return { video, steps, siteName, description, logo, seconds };
}
