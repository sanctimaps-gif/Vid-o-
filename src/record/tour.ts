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
  const { url, outDir, seconds = 22, width = 540, settle = 2.5, onProgress } = options;
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
