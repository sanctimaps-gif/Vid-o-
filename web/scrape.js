/**
 * Lecture d'un site depuis le navigateur.
 *
 * Un navigateur n'a pas le droit de lire une page d'un autre domaine : c'est la règle
 * du « même origine ». On tente donc l'accès direct, puis on passe par un relais public
 * qui, lui, ajoute les en-têtes autorisant la lecture.
 */

// Accès direct : constante, pour que la mémorisation du transport puisse le reconnaître.
const DIRECT = (url) => url;

const PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

const PRODUCT_PATH = /\/(products?|produits?|shop|boutique|item|articles?|collections?\/[^/]+\/products)\//i;
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|avif)(\?|$)/i;
const SKIP_IMAGE = /(sprite|icon|favicon|placeholder|pixel|badge|payment|paypal|visa|mastercard|flag|logo)/i;

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} : délai dépassé`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Une fois qu'un transport a fonctionné pour ce site, on le réutilise : sur mobile,
// retenter l'accès direct puis chaque relais à chaque image coûte très cher.
let preferred = null;

/**
 * Récupère une ressource distante, en direct si possible, sinon via un relais.
 * `maxAttempts` limite le nombre de transports essayés, pour les requêtes exploratoires.
 */
export async function fetchRemote(url, { as = "text", timeout = 20000, maxAttempts } = {}) {
  const all = [DIRECT, ...PROXIES];
  const ordered = preferred ? [preferred, ...all.filter((build) => build !== preferred)] : all;
  const attempts = maxAttempts ? ordered.slice(0, maxAttempts) : ordered;
  let lastError = null;

  for (const build of attempts) {
    try {
      const response = await withTimeout(fetch(build(url), { redirect: "follow" }), timeout, "lecture");
      if (!response.ok) {
        lastError = new Error(`réponse ${response.status}`);
        continue;
      }
      const payload = as === "blob" ? await response.blob() : await response.text();
      preferred = build;
      return payload;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("ressource inaccessible");
}

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
    if (!resolved || SKIP_IMAGE.test(resolved)) return;
    if (!IMAGE_EXTENSIONS.test(resolved) && !/\/cdn\/|\/image/i.test(resolved)) return;
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
  const text = body.replace(/\s+/g, " ").trim().slice(0, 4000);

  return {
    lang: (doc.documentElement.getAttribute("lang") ?? "").toLowerCase(),
    siteName: meta('meta[property="og:site_name"]'),
    title,
    description,
    images,
    links,
    jsonLd,
    text,
  };
}

async function tryShopify(origin, onProgress) {
  try {
    const raw = await fetchRemote(`${origin}/products.json?limit=30`, {
      timeout: 12000,
      maxAttempts: 2,
    });
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

/**
 * Explore le site et renvoie ce qui servira à écrire les scripts.
 * Sur mobile on limite volontairement le nombre de pages : chaque page passe par un relais.
 */
export async function crawlSite(startUrl, { maxPages = 6, onProgress } = {}) {
  const start = new URL(startUrl);
  const origin = start.origin;

  onProgress?.(`lecture de ${start.hostname}`);
  const html = await fetchRemote(startUrl);
  const home = extractPage(html, startUrl);

  const rawProducts = await tryShopify(origin, onProgress);

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
        const pageHtml = await fetchRemote(link, { timeout: 15000 });
        const page = extractPage(pageHtml, link);
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
        /* page inaccessible : on continue */
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
    products,
    images,
  };
}

/** Télécharge les visuels et les décode. Une image illisible est simplement écartée. */
export async function loadImages(site, { limit = 10, onProgress } = {}) {
  let loaded = 0;
  for (const image of site.images) {
    if (loaded >= limit) break;
    try {
      const blob = await fetchRemote(image.url, { as: "blob", timeout: 20000 });
      if (blob.size < 4000) continue;
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width < 300 || bitmap.height < 300) continue;
      image.bitmap = bitmap;
      loaded += 1;
      onProgress?.(`image ${loaded}/${limit}`);
    } catch {
      /* visuel inaccessible : on passe au suivant */
    }
  }
  return loaded;
}
