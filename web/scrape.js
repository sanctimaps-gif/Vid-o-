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

const PRODUCT_PATH = /\/(products?|produits?|shop|boutique|item|articles?|collections?\/[^/]+\/products)\//i;
const SKIP_IMAGE = /(sprite|icon|favicon|placeholder|pixel|badge|payment|paypal|visa|mastercard|flag|\.svg|\.gif)/i;

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
export async function fetchRemote(url, { as = "text", timeout = 20000, sticky = true } = {}) {
  const wantsBytes = as === "blob" || as === "image";
  const usable = SOURCES.filter((source) => !wantsBytes || source.binary);

  if (preferred && usable.includes(preferred)) {
    try {
      return await attempt(preferred, url, { as, timeout });
    } catch {
      /* le chemin habituel a lâché : on relance une course complète */
    }
  }
  return race(usable, url, { as, timeout }, sticky);
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

function bestFromSrcset(srcset) {
  const parts = srcset.split(",").map((entry) => entry.trim().split(/\s+/)[0]).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
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
  const body = markdown.replace(/^[\s\S]*?Markdown Content:\s*/m, "");

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

async function tryShopify(origin, onProgress) {
  try {
    const raw = await fetchRemote(`${origin}/products.json?limit=30`, { timeout: 12000 });
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
    const raw = await fetchRemote(`${origin}/wp-json/wc/store/products?per_page=30`, { timeout: 12000 });
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
  try {
    home = extractPage(await fetchRemote(startUrl), startUrl);
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
        45000,
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

  // Une page qui ne livre presque rien est le plus souvent construite en JavaScript :
  // le lecteur, lui, l'exécute avant de répondre.
  if (isThin(home)) {
    onProgress?.("page presque vide, relecture via le lecteur");
    try {
      const markdown = await withTimeout(
        fetch(READER.url(startUrl)).then((response) => response.text()),
        45000,
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

  let rawProducts = await tryShopify(origin, onProgress);
  if (rawProducts.length === 0) rawProducts = await tryWooCommerce(origin, onProgress);

  if (rawProducts.length < 4) {
    const candidates = [...new Set(home.links)]
      .filter((link) => {
        try {
          const url = new URL(link);
          return url.origin === origin && PRODUCT_PATH.test(url.pathname);
        } catch {
          return false;
        }
      })
      .slice(0, maxPages);

    for (const [index, link] of candidates.entries()) {
      onProgress?.(`page ${index + 1}/${candidates.length}`);
      try {
        const page = extractPage(await fetchRemote(link, { timeout: 15000 }), link);
        const product = flattenJsonLd(page.jsonLd).find(
          (node) =>
            node["@type"] === "Product" ||
            (Array.isArray(node["@type"]) && node["@type"].includes("Product")),
        );
        rawProducts.push({
          title: String(product?.name ?? page.title).trim(),
          url: link,
          price: priceFromOffers(product?.offers),
          description: String(product?.description ?? page.description ?? page.text.slice(0, 300))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 600),
          images: page.images.slice(0, 2),
        });
      } catch {
        /* page inaccessible : on continue avec les autres */
      }
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
  for (const image of home.images) addImage(image.url, image.alt, home.title || start.hostname);

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
  };
}

/** Télécharge les visuels et les décode. Une image illisible est simplement écartée. */
export async function loadImages(site, { limit = 10, onProgress } = {}) {
  let loaded = 0;
  let tried = 0;

  for (const image of site.images) {
    if (loaded >= limit) break;
    tried += 1;
    try {
      const bitmap = await fetchRemote(image.url, { as: "image", timeout: 20000 });
      // Les pictogrammes et les bandeaux très étirés ne font pas un bon fond.
      const ratio = bitmap.width / bitmap.height;
      if (bitmap.width < 300 || bitmap.height < 260 || ratio > 4 || ratio < 0.25) continue;
      image.bitmap = bitmap;
      loaded += 1;
      onProgress?.(`${loaded} visuel(s) sur ${tried} essayé(s)`);
    } catch {
      /* visuel inaccessible ou illisible : on passe au suivant */
    }
  }
  return loaded;
}

/**
 * Capture de la page réelle, par le service gratuit de WordPress.
 * C'est un bonus : s'il ne répond pas, la vidéo se rabat sur une page reconstituée.
 */
export async function siteScreenshot(url, { width = 720, timeout = 25000 } = {}) {
  const shot = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=${width}`;
  try {
    const bitmap = await withTimeout(
      fetch(shot).then(async (response) => {
        if (!response.ok) throw new Error(`capture : réponse ${response.status}`);
        return createImageBitmap(await response.blob());
      }),
      timeout,
      "capture",
    );
    // Le service renvoie parfois une image d'attente presque vide : on la refuse.
    return bitmap.width >= 320 && bitmap.height >= 320 ? bitmap : null;
  } catch {
    return null;
  }
}
