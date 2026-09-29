/**
 * Lecture d'un site depuis le navigateur.
 *
 * Un navigateur n'a pas le droit de lire une page d'un autre domaine : c'est la règle
 * du « même origine ». Vid-O tente donc plusieurs chemins *en parallèle* — accès direct
 * et plusieurs relais publics — et garde le premier qui répond. Courir les relais l'un
 * après l'autre condamnait toute la lecture dès qu'un seul était lent ou hors service.
 */

const encode = (url) => encodeURIComponent(url);

/**
 * Chemins d'accès, du plus souhaitable au moins souhaitable.
 * `unwrap` extrait le contenu réel : certains relais renvoient une enveloppe JSON.
 * `binary: false` marque ceux qui ne savent pas transporter une image.
 */
const SOURCES = [
  { id: "direct", url: (u) => u, unwrap: (text) => text, binary: true },
  {
    id: "allorigins",
    url: (u) => `https://api.allorigins.win/raw?url=${encode(u)}`,
    unwrap: (text) => text,
    binary: true,
  },
  {
    id: "corsproxy",
    url: (u) => `https://corsproxy.io/?url=${encode(u)}`,
    unwrap: (text) => text,
    binary: true,
  },
  {
    id: "codetabs",
    url: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encode(u)}`,
    unwrap: (text) => text,
    binary: true,
  },
  {
    id: "cors.lol",
    url: (u) => `https://api.cors.lol/?url=${encode(u)}`,
    unwrap: (text) => text,
    binary: true,
  },
  {
    id: "allorigins-json",
    url: (u) => `https://api.allorigins.win/get?url=${encode(u)}`,
    unwrap: (text) => JSON.parse(text).contents,
    binary: false,
  },
  {
    id: "whateverorigin",
    url: (u) => `https://whateverorigin.org/get?url=${encode(u)}`,
    unwrap: (text) => JSON.parse(text).contents,
    binary: false,
  },
];

/** Lecteur de dernier recours : il exécute le JavaScript du site et renvoie du Markdown. */
const READER = { id: "lecteur", url: (u) => `https://r.jina.ai/${u}` };

/**
 * Chemins qui annoncent une fiche. Le commerce d'abord, puis ce qu'on rencontre
 * sur les sites de contenu : un saint, un lieu, un monument ont eux aussi leur
 * page, et il n'y a aucune raison de ne savoir présenter qu'un article en vente.
 */
const PRODUCT_PATH =
  /\/(products?|produits?|shop|boutique|item|articles?|collections?\/[^/]+\/products|saints?|saintes?|lieux?|sanctuaires?|chapelles?|[ée]glises?|basiliques?|abbayes?|monast[eè]res?|p[eè]lerinages?|monuments?|patrimoine|fiches?|notices?)\//i;

/** Dossiers qui regroupent des pages sans en être : ils ne font pas un catalogue. */
const NOT_A_FAMILY = /^(tag|tags|category|categorie|catégorie|categories|author|auteur|page|pages|feed|search|recherche|assets|static|media|wp-content|wp-json|cdn)$/i;

/**
 * Familles de pages. Les liens d'un même dossier qui ne diffèrent que par leur
 * dernier segment forment un catalogue : /produits/x, /saints/y, /lieux/z. C'est
 * ce qui permet de trouver les fiches d'un site sans rien savoir de son
 * vocabulaire — et donc de présenter un saint comme on présente une veste.
 */
function pageFamilies(links, origin) {
  const families = new Map();

  for (const link of links) {
    let parsed;
    try {
      parsed = new URL(link);
    } catch {
      continue;
    }
    if (parsed.origin !== origin) continue;

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || parts.length > 3) continue;
    if (parts.some((part) => NOT_A_FAMILY.test(part))) continue;

    const prefix = parts.slice(0, -1).join("/");
    if (!families.has(prefix)) families.set(prefix, new Set());
    families.get(prefix).add(parsed.toString());
  }

  return [...families.entries()]
    .map(([prefix, urls]) => ({ prefix, urls: [...urls] }))
    // Trois pages sœurs, c'est un catalogue ; deux, c'est une coïncidence.
    .filter((family) => family.urls.length >= 3)
    .sort((a, b) => b.urls.length - a.urls.length);
}

/**
 * Types de données structurées qui décrivent un sujet présentable. `Organization`
 * en est exclu : c'est presque toujours l'éditeur du site, pas un sujet.
 */
const SUBJECT_TYPES = new Set(
  ("Product Person Place Event Article NewsArticle BlogPosting CreativeWork Book " +
    "TouristAttraction TouristDestination LandmarksOrHistoricalBuildings Church " +
    "PlaceOfWorship Museum HistoricalPlace CivicStructure Painting VisualArtwork")
    .split(" "),
);

function subjectNode(jsonLd) {
  return flattenJsonLd(jsonLd).find((node) => {
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    return types.some((type) => SUBJECT_TYPES.has(String(type)));
  });
}
const SKIP_IMAGE = /(sprite|icon|favicon|placeholder|pixel|badge|payment|paypal|visa|mastercard|flag|\.svg|\.gif)/i;

/**
 * Bibliothèques de carte interactive, et les marques qu'elles laissent dans la page.
 *
 * Une page qui charge une carte n'est pas finie quand son HTML arrive : le fond de
 * carte, les tuiles et les repères sont demandés ensuite, et mettent plusieurs
 * secondes. La capturer tout de suite ne donne qu'un rectangle vide à la place de
 * la carte — exactement ce qu'il ne faut pas montrer dans une vidéo.
 */
const MAP_MARKERS =
  /(leaflet|mapbox|maplibre|openlayers|\bol\.js\b|google\.[a-z.]+\/maps|maps\.googleapis|deck\.gl|cesium|arcgis|\bumap\b|tilelayer|tileserver|tile\.openstreetmap|basemap|id=["']map["']|class=["'][^"']*\bmap(-container|box)?\b)/i;

const MAP_WORDS = /\b(carte|cartes|map|maps|plan interactif|geoportail|géoportail|itinéraire|itineraire)\b/i;

export function looksLikeMap(html) {
  return MAP_MARKERS.test(String(html ?? ""));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ReadFailure extends Error {
  constructor(message, reasons) {
    super(message);
    this.name = "ReadFailure";
    this.reasons = reasons;
  }
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

async function attempt(source, url, { as, timeout }) {
  const response = await withTimeout(fetch(source.url(url), { redirect: "follow" }), timeout, source.id);
  if (!response.ok) throw new Error(`${source.id} : réponse ${response.status}`);

  // Une image est décodée ici, à l'intérieur de la tentative : un relais qui répond
  // une page d'erreur au lieu du fichier doit compter comme un échec, pour que le
  // chemin suivant soit essayé. Décoder plus loin faisait perdre l'image en silence.
  if (as === "image") {
    const blob = await response.blob();
    if (blob.size < 2000) throw new Error(`${source.id} : fichier trop petit`);
    try {
      return await createImageBitmap(blob);
    } catch {
      throw new Error(`${source.id} : ce n'est pas une image`);
    }
  }

  if (as === "blob") {
    const blob = await response.blob();
    if (blob.size < 512) throw new Error(`${source.id} : fichier vide`);
    return blob;
  }

  const payload = source.unwrap(await response.text());
  if (!payload || payload.length < 120) throw new Error(`${source.id} : contenu vide`);
  return payload;
}

// Le chemin qui a fonctionné est mémorisé : sans cela, chaque image relancerait
// une course complète, ce qui sature la connexion d'un téléphone.
let preferred = null;

export function preferredSource() {
  return preferred?.id ?? null;
}

export function resetTransport() {
  preferred = null;
}

/** Lance tous les chemins de front et garde le premier qui aboutit. */
function race(sources, url, options, sticky = true) {
  return new Promise((resolve, reject) => {
    const reasons = [];
    let pending = sources.length;
    if (pending === 0) reject(new ReadFailure("aucun chemin disponible", reasons));

    for (const source of sources) {
      attempt(source, url, options).then(
        (payload) => {
          // Une requête de service tiers (la voix) ne doit pas imposer son chemin
          // à la lecture du site, qui a ses propres contraintes.
          if (sticky) preferred = source;
          resolve(payload);
        },
        (error) => {
          reasons.push(error.message);
          pending -= 1;
          if (pending === 0) reject(new ReadFailure("tous les chemins ont échoué", reasons));
        },
      );
    }
  });
}

/**
 * Récupère une ressource distante. Le premier appel met les chemins en concurrence ;
 * les suivants réutilisent le gagnant, et ne relancent une course qu'en cas d'échec.
 */
export async function fetchRemote(url, { as = "text", timeout = 15000, sticky = true, single = false } = {}) {
  const wantsBytes = as === "blob" || as === "image";
  const usable = SOURCES.filter((source) => !wantsBytes || source.binary);

  if (preferred && usable.includes(preferred)) {
    try {
      return await attempt(preferred, url, { as, timeout });
    } catch (error) {
      // `single` : requête exploratoire dont l'échec est banal (une sonde de
      // plateforme). Inutile d'essayer tous les relais pour confirmer une absence.
      if (single) throw error;
    }
  }
  if (single && preferred) throw new Error("sonde sans résultat");
  return race(usable, url, { as, timeout }, sticky);
}

/** Exécute `task` sur chaque élément, `limit` à la fois. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ *
 * Extraction d'une page HTML
 * ------------------------------------------------------------------ */

function absoluteUrl(candidate, base) {
  try {
    const url = new URL(candidate, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Dans un `srcset`, on veut la plus grande variante, déclarée par son descripteur. */
function bestFromSrcset(srcset) {
  let best = null;
  let bestWidth = -1;
  for (const entry of srcset.split(",")) {
    const [url, descriptor] = entry.trim().split(/\s+/);
    if (!url) continue;
    const width = /^(\d+)w$/.exec(descriptor ?? "")?.[1];
    const value = width ? Number(width) : 0;
    if (value >= bestWidth) {
      bestWidth = value;
      best = url;
    }
  }
  return best;
}

/** Images posées en fond par la feuille de style : très courant pour les bandeaux. */
function backgroundUrls(text) {
  const found = [];
  for (const match of String(text ?? "").matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
    if (match[1] && !match[1].startsWith("data:")) found.push(match[1]);
  }
  return found;
}

function flattenJsonLd(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLd(item, out);
  } else if (node && typeof node === "object") {
    out.push(node);
    if (node["@graph"]) flattenJsonLd(node["@graph"], out);
    if (node.itemListElement) flattenJsonLd(node.itemListElement, out);
    if (node.item) flattenJsonLd(node.item, out);
  }
  return out;
}

function priceFromOffers(offers) {
  for (const node of flattenJsonLd(offers)) {
    const price = node.price ?? node.lowPrice;
    if (price !== undefined && price !== null) {
      return `${price}${node.priceCurrency ? ` ${node.priceCurrency}` : ""}`.trim();
    }
  }
  return undefined;
}

/**
 * Titres de la page et texte qui les suit.
 * C'est la matière des vidéos quand le site n'a pas de fiches produit.
 */
function extractSections(doc) {
  const sections = [];
  const seen = new Set();

  for (const heading of doc.querySelectorAll("h1, h2, h3")) {
    const title = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
    const key = title.toLowerCase();
    if (title.length < 4 || title.length > 90 || seen.has(key)) continue;

    let text = "";
    let node = heading.nextElementSibling;
    let hops = 0;
    while (node && hops < 4 && text.length < 260) {
      if (/^H[1-3]$/.test(node.tagName)) break;
      const chunk = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (chunk.length > 30) text = text ? `${text} ${chunk}` : chunk;
      node = node.nextElementSibling;
      hops += 1;
    }

    seen.add(key);
    sections.push({ title, text: text.slice(0, 400) });
    if (sections.length >= 12) break;
  }
  return sections;
}

function extractPage(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const jsonLd = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      jsonLd.push(JSON.parse(script.textContent ?? ""));
    } catch {
      /* JSON-LD invalide : ignoré */
    }
  }

  const meta = (selector) => doc.querySelector(selector)?.getAttribute("content")?.trim() ?? "";
  const title =
    meta('meta[property="og:title"]') ||
    doc.querySelector("h1")?.textContent?.trim() ||
    doc.title?.trim() ||
    "";
  const description = meta('meta[property="og:description"]') || meta('meta[name="description"]');

  const images = [];
  const pushImage = (raw, alt) => {
    if (!raw) return;
    const resolved = absoluteUrl(raw, pageUrl);
    // On accepte large : beaucoup de sites servent leurs visuels par un CDN, sans
    // extension de fichier. Le décodage fera le tri, lui, sans se tromper.
    if (!resolved || SKIP_IMAGE.test(resolved)) return;
    images.push({ url: resolved, alt: (alt || "").trim().slice(0, 160) });
  };

  pushImage(meta('meta[property="og:image"]'), title);
  pushImage(meta('meta[name="twitter:image"]'), title);

  for (const link of doc.querySelectorAll('link[rel="preload"][as="image"], link[rel="image_src"]')) {
    pushImage(link.getAttribute("href") ?? link.getAttribute("imagesrcset")?.split(",")[0]?.trim(), title);
  }

  // Fonds déclarés en style, dans l'attribut des balises comme dans les feuilles internes.
  for (const node of doc.querySelectorAll("[style*=url]")) {
    for (const found of backgroundUrls(node.getAttribute("style"))) pushImage(found, title);
  }
  for (const sheet of doc.querySelectorAll("style")) {
    for (const found of backgroundUrls(sheet.textContent).slice(0, 12)) pushImage(found, title);
  }

  for (const source of doc.querySelectorAll("picture source[srcset]")) {
    pushImage(bestFromSrcset(source.getAttribute("srcset") ?? ""), title);
  }

  for (const img of doc.querySelectorAll("img")) {
    const srcset = img.getAttribute("srcset") ?? img.getAttribute("data-srcset");
    pushImage(
      (srcset && bestFromSrcset(srcset)) ||
        img.getAttribute("src") ||
        img.getAttribute("data-src") ||
        img.getAttribute("data-lazy-src"),
      img.getAttribute("alt") || title,
    );
  }

  const links = [];
  for (const anchor of doc.querySelectorAll("a[href]")) {
    const resolved = absoluteUrl(anchor.getAttribute("href") ?? "", pageUrl);
    if (resolved) links.push(resolved);
  }

  // Le texte des balises techniques fait partie du `textContent` de la page. Sans
  // ce nettoyage, le code JavaScript du site finissait dans la narration et dans
  // les sous-titres — d'autant plus qu'un site construit en JavaScript en contient
  // beaucoup plus que de phrases. Le retrait vient ici, après la lecture des
  // données structurées et des fonds d'image, qui logent justement dans ces balises.
  // Les menus et les pieds de page partent aussi : ce sont des listes de liens, pas
  // des phrases, et lus à voix haute ils donnent « À propos Mentions légales
  // Contact ». Les liens, eux, ont déjà été relevés juste au-dessus.
  for (const junk of doc.querySelectorAll(
    "script, style, noscript, template, svg, iframe, nav, footer",
  )) {
    junk.remove();
  }

  const body = (doc.querySelector("main") ?? doc.body)?.textContent ?? "";

  return {
    lang: (doc.documentElement.getAttribute("lang") ?? "").toLowerCase(),
    siteName: meta('meta[property="og:site_name"]'),
    title,
    description,
    images,
    links,
    jsonLd,
    sections: extractSections(doc),
    text: body.replace(/\s+/g, " ").trim().slice(0, 4000),
  };
}

/* ------------------------------------------------------------------ *
 * Extraction depuis le Markdown du lecteur de secours
 * ------------------------------------------------------------------ */

function extractMarkdown(markdown, pageUrl) {
  const title = /^Title:\s*(.+)$/m.exec(markdown)?.[1]?.trim() ?? "";
  const body = markdown
    .replace(/^[\s\S]*?Markdown Content:\s*/m, "")
    // Les blocs de code du lecteur ne sont pas du texte à lire à voix haute.
    .replace(/```[\s\S]*?```/g, " ");

  const images = [];
  for (const match of body.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)/g)) {
    const resolved = absoluteUrl(match[2], pageUrl);
    if (resolved && !SKIP_IMAGE.test(resolved)) images.push({ url: resolved, alt: match[1].trim() });
  }

  const links = [];
  for (const match of body.matchAll(/(?<!!)\[[^\]]*\]\((https?:\/\/[^)\s]+)/g)) {
    const resolved = absoluteUrl(match[1], pageUrl);
    if (resolved) links.push(resolved);
  }

  const sections = [];
  const lines = body.split("\n");
  for (const [index, line] of lines.entries()) {
    const heading = /^#{1,3}\s+(.{4,90})$/.exec(line.trim());
    if (!heading) continue;
    const text = lines
      .slice(index + 1, index + 5)
      .filter((next) => !next.trim().startsWith("#"))
      .join(" ")
      .replace(/[*_`>[\]()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    sections.push({ title: heading[1].trim(), text: text.slice(0, 400) });
    if (sections.length >= 12) break;
  }

  const text = body
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#*_`>|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    lang: "",
    siteName: "",
    title,
    description: text.slice(0, 200),
    images,
    links,
    jsonLd: [],
    sections,
    text: text.slice(0, 4000),
  };
}

/** Le site est-il exploitable en l'état, ou faut-il tenter le lecteur ? */
function isThin(page) {
  return page.images.length === 0 && page.sections.length === 0 && page.text.length < 400;
}

/* ------------------------------------------------------------------ *
 * Catalogues des plateformes courantes
 * ------------------------------------------------------------------ */

/**
 * Indices de plateforme laissés dans le HTML. Sonder `/products.json` sur un site
 * qui n'est pas Shopify coûtait un aller-retour par relais, tous voués à l'échec :
 * plusieurs secondes perdues sur la grande majorité des sites.
 */
function looksLikeShopify(html) {
  return /cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.theme|shopify-section/i.test(html);
}

function looksLikeWooCommerce(html) {
  return /woocommerce|wp-content\/plugins\/woo|wc-block|wp-json\/wc\//i.test(html);
}

async function tryShopify(origin, onProgress) {
  try {
    const raw = await fetchRemote(`${origin}/products.json?limit=30`, { timeout: 8000, single: true });
    const data = JSON.parse(raw);
    if (!Array.isArray(data.products) || data.products.length === 0) return [];
    onProgress?.(`catalogue Shopify détecté (${data.products.length} produits)`);

    return data.products.map((item) => ({
      title: String(item.title ?? "").trim(),
      url: `${origin}/products/${item.handle ?? ""}`,
      price: item.variants?.[0]?.price ? String(item.variants[0].price) : undefined,
      description: String(item.body_html ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600),
      images: (item.images ?? [])
        .slice(0, 2)
        .map((image) => ({ url: String(image.src ?? ""), alt: String(image.alt ?? item.title ?? "") }))
        .filter((image) => image.url),
    }));
  } catch {
    return [];
  }
}

async function tryWooCommerce(origin, onProgress) {
  try {
    const raw = await fetchRemote(`${origin}/wp-json/wc/store/products?per_page=30`, {
      timeout: 8000,
      single: true,
    });
    const data = JSON.parse(raw);
    if (!Array.isArray(data) || data.length === 0) return [];
    onProgress?.(`catalogue WooCommerce détecté (${data.length} produits)`);

    return data.map((item) => ({
      title: String(item.name ?? "").trim(),
      url: String(item.permalink ?? origin),
      price: item.prices?.price
        ? `${item.prices.price} ${item.prices.currency_code ?? ""}`.trim()
        : undefined,
      description: String(item.short_description ?? item.description ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600),
      images: (item.images ?? [])
        .slice(0, 2)
        .map((image) => ({ url: String(image.src ?? ""), alt: String(image.alt ?? item.name ?? "") }))
        .filter((image) => image.url),
    }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Exploration
 * ------------------------------------------------------------------ */

export async function crawlSite(startUrl, { maxPages = 6, onProgress } = {}) {
  const start = new URL(startUrl);
  const origin = start.origin;

  onProgress?.(`lecture de ${start.hostname}`);

  let home;
  let readVia;
  let rawHtml = "";
  try {
    rawHtml = await fetchRemote(startUrl, { timeout: 12000 });
    home = extractPage(rawHtml, startUrl);
    readVia = preferredSource();
  } catch (error) {
    // Aucun chemin HTML n'a abouti : le lecteur reste la dernière chance.
    onProgress?.("accès direct refusé, tentative via le lecteur");
    try {
      home = extractMarkdown(await withTimeout(
        fetch(READER.url(startUrl)).then((response) => {
          if (!response.ok) throw new Error(`lecteur : réponse ${response.status}`);
          return response.text();
        }),
        25000,
        "lecteur",
      ), startUrl);
      readVia = READER.id;
    } catch (readerError) {
      throw new ReadFailure(`${start.hostname} n'a pas pu être lu depuis le navigateur.`, [
        ...(error instanceof ReadFailure ? error.reasons : [String(error.message)]),
        String(readerError.message),
      ]);
    }
  }

  // Le site se charge-t-il tout seul après l'arrivée du HTML ? La réponse décide du
  // temps qu'on laissera à la page avant de la photographier.
  let interactive = looksLikeMap(rawHtml) ? "carte" : null;

  // Une page qui ne livre presque rien est le plus souvent construite en JavaScript :
  // le lecteur, lui, l'exécute avant de répondre.
  if (isThin(home)) {
    interactive ??= "application";
    onProgress?.("page presque vide, relecture via le lecteur");
    try {
      const markdown = await withTimeout(
        fetch(READER.url(startUrl)).then((response) => response.text()),
        25000,
        "lecteur",
      );
      const rendered = extractMarkdown(markdown, startUrl);
      if (!isThin(rendered)) {
        home = { ...rendered, lang: home.lang, siteName: home.siteName || rendered.siteName };
        readVia = READER.id;
      }
    } catch {
      /* le lecteur n'a rien donné : on garde ce qu'on a */
    }
  }

  // Le lecteur a rendu la page en Markdown : les marques de bibliothèque ont disparu,
  // mais le vocabulaire de la page trahit encore la carte.
  if (!interactive && MAP_WORDS.test(`${home.title} ${home.description}`)) interactive = "carte";

  let rawProducts = [];
  if (looksLikeShopify(rawHtml)) rawProducts = await tryShopify(origin, onProgress);
  else if (looksLikeWooCommerce(rawHtml)) rawProducts = await tryWooCommerce(origin, onProgress);

  if (rawProducts.length < 4) {
    const links = [...new Set(home.links)];
    const named = links.filter((link) => {
      try {
        const url = new URL(link);
        return url.origin === origin && PRODUCT_PATH.test(url.pathname);
      } catch {
        return false;
      }
    });

    // Aucun chemin reconnaissable : on cherche la plus grosse famille de pages
    // sœurs. Un site de contenu range ses fiches comme une boutique range ses
    // produits, il ne les appelle simplement pas pareil.
    let candidates = named;
    if (candidates.length < 3) {
      const family = pageFamilies(links, origin)[0];
      if (family) {
        onProgress?.(`${family.urls.length} fiches trouvées dans /${family.prefix}`);
        candidates = [...new Set([...named, ...family.urls])];
      }
    }
    candidates = candidates.slice(0, maxPages);

    let done = 0;
    const fetched = await mapLimit(candidates, 4, async (link) => {
      try {
        const page = extractPage(await fetchRemote(link, { timeout: 12000 }), link);
        const subject = subjectNode(page.jsonLd);
        const title = String(subject?.name ?? page.title).trim();
        // Une page d'index ou d'erreur porte le titre du site : ce n'est pas un sujet.
        if (!title || title === home.title) return null;
        return {
          title,
          url: link,
          price: priceFromOffers(subject?.offers),
          description: String(subject?.description ?? page.description ?? page.text.slice(0, 300))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 600),
          images: page.images.slice(0, 2),
        };
      } catch {
        return null;
      } finally {
        done += 1;
        onProgress?.(`page ${done}/${candidates.length}`);
      }
    });
    rawProducts.push(...fetched.filter(Boolean));
  }

  // Trop peu de visuels : on explore quelques pages de plus, en privilégiant
  // celles qui ressemblent à une galerie. Un site se raconte avec ses images.
  const harvested = [...home.images];
  if (harvested.length < 6) {
    const GALLERY = /(galerie|gallery|photos?|portfolio|realisation|réalisation|projets?|works?|about|propos)/i;
    const extra = [...new Set(home.links)]
      .filter((link) => {
        try {
          const parsed = new URL(link);
          return parsed.origin === origin && !PRODUCT_PATH.test(parsed.pathname);
        } catch {
          return false;
        }
      })
      .sort((a, b) => Number(GALLERY.test(b)) - Number(GALLERY.test(a)))
      .slice(0, 4);

    for (const [index, link] of extra.entries()) {
      onProgress?.(`recherche de visuels ${index + 1}/${extra.length}`);
      try {
        const page = extractPage(await fetchRemote(link, { timeout: 12000 }), link);
        harvested.push(...page.images);
      } catch {
        /* page inaccessible : on continue */
      }
      if (harvested.length >= 12) break;
    }
  }

  // Pas une seule image dans tout le site : la page ne les montre probablement
  // qu'une fois exécutée. Le lecteur, lui, l'exécute avant de répondre — c'est la
  // dernière source avant de renoncer.
  if (harvested.length === 0 && readVia !== READER.id) {
    onProgress?.("aucune image dans la page, relecture par le lecteur");
    try {
      const markdown = await withTimeout(
        fetch(READER.url(startUrl)).then((response) => response.text()),
        20000,
        "lecteur",
      );
      harvested.push(...extractMarkdown(markdown, startUrl).images);
    } catch {
      /* le lecteur n'a rien donné non plus */
    }
  }

  // Banque d'images indexée, sans doublon.
  const images = [];
  const seen = new Set();
  const addImage = (url, alt, source) => {
    let key;
    try {
      const parsed = new URL(url);
      key = parsed.origin + parsed.pathname;
    } catch {
      return;
    }
    if (seen.has(key) || images.length >= 24) return;
    seen.add(key);
    images.push({ index: images.length, url, alt: alt || source, source });
  };

  for (const product of rawProducts) {
    for (const image of product.images) addImage(image.url, image.alt, product.title);
  }
  for (const image of harvested) addImage(image.url, image.alt, home.title || start.hostname);

  const products = rawProducts
    .filter((product) => product.title.length > 1)
    .map((product) => ({
      ...product,
      imageIndexes: product.images
        .map((image) => {
          try {
            const wanted = new URL(image.url).pathname;
            return images.find((candidate) => new URL(candidate.url).pathname === wanted)?.index;
          } catch {
            return undefined;
          }
        })
        .filter((index) => index !== undefined),
    }));

  return {
    url: startUrl,
    origin,
    domain: start.hostname.replace(/^www\./, ""),
    siteName: home.siteName || home.title || start.hostname,
    lang: home.lang,
    title: home.title,
    description: home.description,
    pageText: home.text,
    sections: home.sections,
    products,
    images,
    readVia,
    interactive,
    links: [...new Set(home.links)],
  };
}

/** Télécharge les visuels et les décode. Une image illisible est simplement écartée. */
export async function loadImages(site, { limit = 14, onProgress } = {}) {
  let loaded = 0;
  let tried = 0;

  // Quatre téléchargements de front : sur un téléphone, les faire l'un après
  // l'autre passait l'essentiel du temps à attendre le réseau.
  await mapLimit(site.images.slice(0, limit + 6), 4, async (image) => {
    if (loaded >= limit) return;
    tried += 1;
    try {
      const bitmap = await fetchRemote(image.url, { as: "image", timeout: 12000 });
      // Les pictogrammes et les bandeaux très étirés ne font pas un bon fond.
      const ratio = bitmap.width / bitmap.height;
      if (bitmap.width < 300 || bitmap.height < 260 || ratio > 4 || ratio < 0.25) return;
      image.bitmap = bitmap;
      loaded += 1;
      onProgress?.(`${loaded} visuel(s) sur ${tried} essayé(s)`);
    } catch {
      /* visuel inaccessible ou illisible : on passe au suivant */
    }
  });
  return loaded;
}

/* ------------------------------------------------------------------ *
 * Visite du site : on le parcourt comme un visiteur avant de le filmer
 * ------------------------------------------------------------------ */

/**
 * Services de capture gratuits et sans compte.
 *
 * `patient` marque ceux qui savent attendre avant de déclencher : on leur dit
 * combien de secondes laisser à la page. C'est ce qui permet de photographier une
 * carte une fois ses tuiles arrivées, et non le cadre vide qui la précède.
 */
const SHOT_SERVICES = [
  {
    id: "thum.io",
    patient: true,
    url: (url, width, wait) =>
      `https://image.thum.io/get/width/${width}/wait/${Math.min(20, Math.max(1, Math.round(wait)))}/noanimate/${url}`,
  },
  {
    id: "microlink",
    patient: true,
    url: (url, width, wait) =>
      `https://api.microlink.io/?url=${encode(url)}&screenshot=true&meta=false&embed=screenshot.url` +
      `&viewport.width=${width}&viewport.height=${Math.round(width * 2)}&type=jpeg` +
      `&waitUntil=networkidle0&waitFor=${Math.min(25000, Math.round(wait * 1000))}`,
  },
  {
    id: "mshots",
    patient: false,
    url: (url, width) => `https://s.wordpress.com/mshots/v1/${encode(url)}?w=${width}&h=${Math.round(width * 2.2)}`,
  },
];

/** Vignette en niveaux de gris : la matière des deux mesures qui suivent. */
function thumbnail(bitmap, size) {
  const probe = document.createElement("canvas");
  probe.width = size;
  probe.height = size;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const values = new Float32Array(size * size);
  for (let cell = 0; cell < values.length; cell += 1) {
    const offset = cell * 4;
    values[cell] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  }
  return values;
}

/**
 * Une capture encore en préparation revient sous forme de rectangle presque uni.
 * Elle a la bonne taille : seule la variété des pixels permet de la reconnaître.
 */
function looksBlank(bitmap) {
  try {
    const values = thumbnail(bitmap, 24);
    let sum = 0;
    let sumSquares = 0;
    for (const value of values) {
      sum += value;
      sumSquares += value * value;
    }
    const mean = sum / values.length;
    const variance = sumSquares / values.length - mean * mean;
    // Une vraie page contient du texte et des images : son écart-type dépasse largement 6.
    return Math.sqrt(Math.max(0, variance)) < 6;
  } catch {
    return false;
  }
}

/**
 * Densité de détail : la part de l'image où la teinte change d'un point au suivant.
 *
 * Une carte chargée est faite de routes, d'étiquettes et de reliefs : elle change
 * partout. Le même cadre avant l'arrivée des tuiles est un aplat, avec du détail
 * seulement dans l'en-tête du site. C'est ce qui distingue « la carte est là » de
 * « la carte se charge encore », alors que les deux images ont la même taille.
 */
function pageDetail(bitmap) {
  try {
    const size = 40;
    const values = thumbnail(bitmap, size);
    let textured = 0;
    let pairs = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const here = values[y * size + x];
        if (x + 1 < size) {
          pairs += 1;
          if (Math.abs(here - values[y * size + x + 1]) > 4) textured += 1;
        }
        if (y + 1 < size) {
          pairs += 1;
          if (Math.abs(here - values[(y + 1) * size + x]) > 4) textured += 1;
        }
      }
    }
    return pairs === 0 ? 0 : textured / pairs;
  } catch {
    return 1;
  }
}

/**
 * En dessous, une page annoncée comme interactive n'a visiblement pas fini de se
 * dessiner. Mesuré sur des captures : un cadre de carte encore vide tombe à 0,01,
 * une carte dessinée monte à 0,30, et une page ordinaire très dépouillée — le pire
 * cas honnête — reste à 0,17. Le seuil est placé entre les deux, plus près du bas :
 * se tromper ici ne coûte qu'une attente de plus, la meilleure image obtenue étant
 * conservée à la fin.
 */
const LOADED_DETAIL = 0.09;

async function tryShot(service, url, width, wait, timeout) {
  // On passe par la chaîne de transport habituelle : le canvas doit rester
  // exploitable, et certains services ne renvoient pas d'en-tête d'autorisation.
  const bitmap = await fetchRemote(service.url(url, width, wait), { as: "image", timeout, sticky: false });
  if (bitmap.width < 320 || bitmap.height < 320) throw new Error(`${service.id} : capture trop petite`);
  if (looksBlank(bitmap)) throw new Error(`${service.id} : capture encore en préparation`);
  return { bitmap, detail: pageDetail(bitmap), via: service.id };
}

/**
 * Une capture d'une page. En mode patient on interroge les seuls services qui
 * savent attendre, et on garde la plus fournie des réponses plutôt que la première :
 * entre deux captures de la même page, celle où la carte est arrivée gagne toujours.
 */
async function bestShot(url, width, wait, patient) {
  const services = SHOT_SERVICES.filter((service) => !patient || service.patient);
  const timeout = Math.round(wait * 1000) + 22000;

  if (!patient) {
    return Promise.any(services.map((service) => tryShot(service, url, width, wait, timeout)));
  }

  const settled = await Promise.allSettled(
    services.map((service) => tryShot(service, url, width, wait, timeout)),
  );
  const obtained = settled.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
  if (obtained.length === 0) throw new Error("aucun service n'a rendu de capture");
  return obtained.sort((a, b) => b.detail - a.detail)[0];
}

/**
 * Photographie une page, en lui laissant le temps de finir. Les services gratuits
 * fabriquent l'image à la demande et répondent volontiers une image d'attente : on
 * redemande, avec à chaque fois un délai plus long, et on garde la meilleure.
 */
async function capturePage(url, { width, isPatient, label, onProgress }) {
  let best = null;

  // `isPatient` est relu à chaque tour : la lecture du site peut annoncer la carte
  // après le départ de la première capture, et le tour suivant doit en tenir compte.
  for (let round = 0; round < 3; round += 1) {
    const patient = isPatient();
    // Une carte met couramment cinq à dix secondes à s'afficher : la première
    // demande part donc déjà avec une longue attente, plutôt que de la découvrir
    // après deux tentatives perdues.
    const rounds = patient ? [9, 15, 20] : [2, 6];
    if (round >= rounds.length) break;
    const wait = rounds[round];

    if (round > 0) {
      // Deux échecs très différents, à ne pas confondre dans ce qu'on affiche :
      // une image reçue mais encore vide, et aucune image du tout.
      onProgress?.(
        best
          ? `${label} : la page n'a pas fini de se charger, on lui laisse ${wait} s de plus`
          : `${label} : aucune capture obtenue, nouvelle tentative`,
      );
      await sleep(round === 1 ? 4000 : 7000);
    } else {
      onProgress?.(patient ? `${label} : on attend le chargement complet` : `${label} : capture`);
    }

    try {
      const shot = await bestShot(url, width, wait, patient);
      if (!best || shot.detail > best.detail) best = shot;
      // En mode ordinaire la première capture correcte suffit ; en mode patient on
      // n'arrête que lorsque la page est visiblement dessinée.
      if (!patient || best.detail >= LOADED_DETAIL) break;
    } catch {
      /* aucun service n'a encore d'image exploitable : on retente */
    }
  }

  // Une page qui s'annonçait interactive et qui reste un aplat après toutes les
  // tentatives n'a jamais fini de se dessiner. Mieux vaut alors ne rien rendre :
  // la vidéo montrera la page reconstituée, avec les vrais textes du site, plutôt
  // qu'un rectangle gris là où la carte aurait dû être. Un site ordinaire garde en
  // revanche sa capture, même dépouillée : elle, au moins, est fidèle.
  if (best && isPatient() && best.detail < 0.04) return null;
  return best;
}

/** Ce qui s'affichera dans la barre d'adresse de la vidéo : « /la-carte ». */
function pathLabel(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path && path !== "/" ? path : "";
  } catch {
    return "";
  }
}

// « cart » est délimité : sans cela il attrapait « carte », et le site à filmer
// perdait justement la page qui porte sa carte.
const VISIT_SKIP =
  /(mentions|legal|cgv|cgu|privacy|confidentialite|confidentialité|cookie|panier|\bcarts?\b|checkout|compte|account|login|connexion|contact|\.pdf|\.zip|\.jpe?g|\.png)/i;
const VISIT_PREFER =
  /(carte|map|galerie|gallery|boutique|shop|produits?|products?|collections?|decouvrir|découvrir|explorer|visite|lieux|sanctuaire|about|propos|services?)/i;

/**
 * Les pages qui valent la visite : d'abord celles dont les vidéos vont parler —
 * la fiche d'un saint, d'un lieu, d'un produit — puis celles qui montrent
 * quelque chose. Une vidéo qui présente un sujet doit ouvrir sur sa page à lui.
 */
function pagesToVisit(site, limit, prefer = []) {
  const home = pathLabel(site.url);
  const seen = new Set([home]);
  const candidates = [];

  const wanted = new Set(prefer);

  for (const link of [...prefer, ...(site.links ?? [])]) {
    let parsed;
    try {
      parsed = new URL(link);
    } catch {
      continue;
    }
    if (parsed.origin !== site.origin) continue;
    const path = pathLabel(link);
    if (!path || seen.has(path) || VISIT_SKIP.test(path)) continue;
    // Une page enterrée à quatre niveaux est rarement celle qu'on montrerait.
    if (path.split("/").length > 4) continue;
    seen.add(path);
    candidates.push({ url: link, path, asked: wanted.has(link) });
  }

  // Une page demandée passe avant toute autre : c'est celle dont la vidéo parle.
  // Sans cette priorité, un « à propos » bien nommé doublait la fiche du sujet.
  const rank = (page) => (page.asked ? 2 : VISIT_PREFER.test(page.path) ? 1 : 0);
  return candidates.sort((a, b) => rank(b) - rank(a)).slice(0, limit);
}

/**
 * Lance la visite du site et rend un objet qui se remplit au fur et à mesure.
 *
 * On commence par la page d'accueil, puis on va voir deux autres pages : la vidéo
 * montre alors un vrai parcours, et non trois fois le même écran. La visite démarre
 * dès que la lecture du site a dit si la page se charge toute seule — un site à
 * carte n'est pas photographié comme une page statique — et au plus tard au bout
 * de quatre secondes, pour ne pas retarder les sites ordinaires.
 */
export function startVisit(startUrl, { width = 720, pages = 3, onProgress } = {}) {
  const shots = [];
  const waiting = [];
  let patient = false;
  let kind = null;

  let begin;
  const started = new Promise((resolve) => {
    begin = resolve;
  });
  const beginTimer = setTimeout(begin, 4000);

  let announcePages;
  const planned = new Promise((resolve) => {
    announcePages = resolve;
  });
  const pagesTimer = setTimeout(() => announcePages([]), 15000);

  const add = (shot, url, label) => {
    if (!shot) return;
    shots.push({ ...shot, url, label, path: pathLabel(url) });
    for (const resolve of waiting.splice(0)) resolve(shots);
  };

  const visit = {
    shots,
    get patient() {
      return patient;
    },
    get kind() {
      return kind;
    },

    /**
     * La lecture du site a abouti : elle dit ce qu'est la page, et où aller
     * ensuite. `prefer` porte les pages des sujets que les vidéos vont présenter.
     */
    explore(site, prefer = []) {
      kind = site.interactive ?? null;
      patient = Boolean(site.interactive);
      clearTimeout(beginTimer);
      clearTimeout(pagesTimer);
      begin();
      announcePages(pagesToVisit(site, pages, prefer));
    },

    /** Attend qu'au moins une page soit photographiée, sans dépasser `ms`. */
    ready(ms) {
      if (shots.length > 0) return Promise.resolve(shots);
      return new Promise((resolve) => {
        waiting.push(resolve);
        setTimeout(() => resolve(shots), ms);
      });
    },
  };

  const isPatient = () => patient;

  visit.done = (async () => {
    await started;
    add(await capturePage(startUrl, { width, isPatient, label: "accueil", onProgress }), startUrl, "accueil");

    // Les autres pages sont photographiées ensemble. À la suite, chacune ajoutait
    // son attente à celle des précédentes : une minute pour trois pages, là où les
    // services travaillent très bien en parallèle.
    const others = (await planned).map((page) => ({
      ...page,
      label: page.path.replace(/^\//, "").replace(/-/g, " ").slice(0, 28) || "page",
    }));
    const captured = await Promise.all(
      others.map((page) => capturePage(page.url, { width, isPatient, label: page.label, onProgress })),
    );
    // Ajoutées dans l'ordre de la visite, pas dans celui des réponses.
    others.forEach((page, index) => add(captured[index], page.url, page.label));
    onProgress?.(`visite terminée : ${shots.length} page(s)`);
    return shots;
  })().catch(() => shots);

  return visit;
}

/** Réservé aux vérifications : ces mesures n'ont de sens qu'avec de vraies images. */
export const __test = { pageDetail, looksBlank, pagesToVisit };
