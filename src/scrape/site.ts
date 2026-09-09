import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { config } from "../config.js";
import type { SiteImage, SiteProduct, SiteSnapshot } from "../types.js";
import { normalizeTypography, truncate } from "../util/text.js";
import { probeImageSize } from "../render/ffmpeg.js";

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|avif)(\?|$)/i;
const PRODUCT_PATH = /\/(products?|produits?|shop|boutique|item|articles?|collections?\/[^/]+\/products)\//i;
const SKIP_IMAGE = /(sprite|icon|favicon|placeholder|pixel|badge|payment|paypal|visa|mastercard|flag)/i;

interface FetchResult {
  body: string;
  finalUrl: string;
  contentType: string;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": config.userAgent,
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(url: string): Promise<FetchResult | null> {
  try {
    const response = await fetchWithTimeout(url, { headers: { accept: "text/html,application/xhtml+xml" } });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(contentType)) return null;
    return { body: await response.text(), finalUrl: response.url || url, contentType };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * robots.txt
 * ------------------------------------------------------------------ */

export interface RobotsRules {
  disallow: string[];
  allow: string[];
}

export async function loadRobots(origin: string): Promise<RobotsRules> {
  const rules: RobotsRules = { disallow: [], allow: [] };
  try {
    const response = await fetchWithTimeout(`${origin}/robots.txt`, {}, 8000);
    if (!response.ok) return rules;
    const text = await response.text();

    let applies = false;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.split("#")[0]?.trim() ?? "";
      if (!line) continue;
      const [rawKey, ...rest] = line.split(":");
      const key = rawKey?.trim().toLowerCase() ?? "";
      const value = rest.join(":").trim();

      if (key === "user-agent") {
        applies = value === "*";
      } else if (applies && key === "disallow" && value) {
        rules.disallow.push(value);
      } else if (applies && key === "allow" && value) {
        rules.allow.push(value);
      }
    }
  } catch {
    /* pas de robots.txt lisible : on considère l'exploration autorisée */
  }
  return rules;
}

function matchesRule(pathname: string, rule: string): boolean {
  const pattern = rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${pattern}`).test(pathname);
}

export function isAllowed(url: string, rules: RobotsRules): boolean {
  if (!config.respectRobots) return true;
  const { pathname } = new URL(url);
  if (rules.allow.some((rule) => matchesRule(pathname, rule))) return true;
  return !rules.disallow.some((rule) => matchesRule(pathname, rule));
}

/* ------------------------------------------------------------------ *
 * Extraction d'une page
 * ------------------------------------------------------------------ */

function absoluteUrl(candidate: string, base: string): string | null {
  try {
    const url = new URL(candidate, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function bestFromSrcset(srcset: string): string | null {
  const candidates = srcset
    .split(",")
    .map((entry) => entry.trim().split(/\s+/))
    .filter((parts) => parts.length > 0);
  if (candidates.length === 0) return null;
  // Le dernier candidat d'un srcset est le plus large dans l'écrasante majorité des cas.
  return candidates[candidates.length - 1]?.[0] ?? null;
}

interface PageExtract {
  title: string;
  description: string;
  siteName: string;
  text: string;
  imageUrls: Array<{ url: string; alt: string }>;
  links: string[];
  jsonLd: unknown[];
  price?: string;
}

function extractPage(html: string, pageUrl: string): PageExtract {
  const $ = cheerio.load(html);

  // Le JSON-LD se lit avant de retirer les <script>.
  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      jsonLd.push(JSON.parse($(element).text()));
    } catch {
      /* JSON-LD invalide : ignoré */
    }
  });

  $("script, style, noscript, svg, iframe").remove();

  const meta = (selector: string): string => $(selector).attr("content")?.trim() ?? "";
  const title =
    meta('meta[property="og:title"]') || $("h1").first().text().trim() || $("title").text().trim();
  const description =
    meta('meta[property="og:description"]') || meta('meta[name="description"]') || "";
  const siteName = meta('meta[property="og:site_name"]');

  const imageUrls: Array<{ url: string; alt: string }> = [];
  const pushImage = (raw: string | undefined, alt: string): void => {
    if (!raw) return;
    const resolved = absoluteUrl(raw, pageUrl);
    if (!resolved || SKIP_IMAGE.test(resolved)) return;
    if (!IMAGE_EXTENSIONS.test(resolved) && !/\/cdn\/|\/image/i.test(resolved)) return;
    imageUrls.push({ url: resolved, alt: normalizeTypography(alt).slice(0, 160) });
  };

  pushImage(meta('meta[property="og:image"]'), title);
  $("img").each((_, element) => {
    const node = $(element);
    const srcset = node.attr("srcset") ?? node.attr("data-srcset");
    const source = srcset ? bestFromSrcset(srcset) : undefined;
    pushImage(
      source || node.attr("src") || node.attr("data-src") || node.attr("data-lazy-src"),
      node.attr("alt") || node.closest("a").attr("title") || title,
    );
  });
  $("source[srcset]").each((_, element) => {
    const srcset = $(element).attr("srcset");
    if (srcset) pushImage(bestFromSrcset(srcset) ?? undefined, title);
  });

  const links: string[] = [];
  $("a[href]").each((_, element) => {
    const resolved = absoluteUrl($(element).attr("href") ?? "", pageUrl);
    if (resolved) links.push(resolved);
  });

  const text = normalizeTypography(
    $("main").text() || $("body").text() || "",
  ).replace(/\s{2,}/g, " ");

  const price =
    meta('meta[property="product:price:amount"]') ||
    $('[itemprop="price"]').attr("content") ||
    $(".price, .product-price, [class*=price]").first().text().trim().slice(0, 40) ||
    undefined;

  return { title, description, siteName, text, imageUrls, links, jsonLd, price };
}

/* ------------------------------------------------------------------ *
 * JSON-LD : produits déclarés proprement par le site
 * ------------------------------------------------------------------ */

function flattenJsonLd(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLd(item, out);
  } else if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    out.push(record);
    if (record["@graph"]) flattenJsonLd(record["@graph"], out);
    if (record.itemListElement) flattenJsonLd(record.itemListElement, out);
    if (record.item) flattenJsonLd(record.item, out);
  }
  return out;
}

function priceFromOffers(offers: unknown): string | undefined {
  const nodes = flattenJsonLd(offers);
  for (const node of nodes) {
    const price = node.price ?? node.lowPrice;
    if (price !== undefined && price !== null) {
      const currency = typeof node.priceCurrency === "string" ? ` ${node.priceCurrency}` : "";
      return `${String(price)}${currency}`.trim();
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Raccourcis pour les plateformes courantes
 * ------------------------------------------------------------------ */

interface RawProduct {
  title: string;
  url: string;
  price?: string;
  description?: string;
  images: Array<{ url: string; alt: string }>;
}

async function tryShopify(origin: string): Promise<RawProduct[]> {
  try {
    const response = await fetchWithTimeout(`${origin}/products.json?limit=40`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { products?: unknown };
    if (!Array.isArray(data.products)) return [];

    return data.products.slice(0, 40).map((raw) => {
      const item = raw as Record<string, any>;
      const variant = Array.isArray(item.variants) ? item.variants[0] : undefined;
      return {
        title: String(item.title ?? "").trim(),
        url: `${origin}/products/${String(item.handle ?? "")}`,
        price: variant?.price ? `${variant.price}` : undefined,
        description: normalizeTypography(
          String(item.body_html ?? "").replace(/<[^>]+>/g, " "),
        ).slice(0, 700),
        images: (Array.isArray(item.images) ? item.images : [])
          .slice(0, 3)
          .map((image: Record<string, any>) => ({
            url: String(image.src ?? ""),
            alt: String(image.alt ?? item.title ?? ""),
          }))
          .filter((image: { url: string }) => image.url.length > 0),
      };
    });
  } catch {
    return [];
  }
}

async function tryWooCommerce(origin: string): Promise<RawProduct[]> {
  try {
    const response = await fetchWithTimeout(`${origin}/wp-json/wc/store/products?per_page=40`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];

    return data.slice(0, 40).map((raw) => {
      const item = raw as Record<string, any>;
      return {
        title: String(item.name ?? "").trim(),
        url: String(item.permalink ?? origin),
        price: item.prices?.price ? `${item.prices.price} ${item.prices.currency_code ?? ""}`.trim() : undefined,
        description: normalizeTypography(
          String(item.short_description ?? item.description ?? "").replace(/<[^>]+>/g, " "),
        ).slice(0, 700),
        images: (Array.isArray(item.images) ? item.images : [])
          .slice(0, 3)
          .map((image: Record<string, any>) => ({
            url: String(image.src ?? ""),
            alt: String(image.alt ?? item.name ?? ""),
          }))
          .filter((image: { url: string }) => image.url.length > 0),
      };
    });
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Exploration
 * ------------------------------------------------------------------ */

export interface CrawlOptions {
  maxPages?: number;
  onProgress?: (message: string) => void;
}

export async function crawlSite(startUrl: string, options: CrawlOptions = {}): Promise<SiteSnapshot> {
  const maxPages = options.maxPages ?? config.maxPages;
  const start = new URL(startUrl);
  const origin = start.origin;
  const robots = await loadRobots(origin);

  options.onProgress?.(`lecture de ${start.hostname}`);
  const home = await fetchPage(startUrl);
  if (!home) {
    throw new Error(
      `Impossible de lire ${startUrl}. Vérifiez l'adresse, ou que le site répond bien en HTML.`,
    );
  }

  const homeExtract = extractPage(home.body, home.finalUrl);
  const pagesVisited = [home.finalUrl];

  // 1. Les plateformes e-commerce exposent souvent un catalogue structuré : on le prend en priorité.
  const rawProducts: RawProduct[] = [];
  const shopify = await tryShopify(origin);
  if (shopify.length > 0) {
    options.onProgress?.(`catalogue Shopify détecté (${shopify.length} produits)`);
    rawProducts.push(...shopify);
  } else {
    const woo = await tryWooCommerce(origin);
    if (woo.length > 0) {
      options.onProgress?.(`catalogue WooCommerce détecté (${woo.length} produits)`);
      rawProducts.push(...woo);
    }
  }

  // 2. Sinon (ou en complément), on suit les liens qui ressemblent à des fiches produit.
  if (rawProducts.length < 6) {
    const candidates = [...new Set(homeExtract.links)]
      .filter((link) => {
        try {
          const url = new URL(link);
          return url.origin === origin && PRODUCT_PATH.test(url.pathname) && isAllowed(link, robots);
        } catch {
          return false;
        }
      })
      .slice(0, maxPages);

    for (const [index, link] of candidates.entries()) {
      options.onProgress?.(`page ${index + 1}/${candidates.length} : ${new URL(link).pathname}`);
      const page = await fetchPage(link);
      if (!page) continue;
      pagesVisited.push(page.finalUrl);

      const extract = extractPage(page.body, page.finalUrl);
      const products = flattenJsonLd(extract.jsonLd).filter(
        (node) => node["@type"] === "Product" || (Array.isArray(node["@type"]) && node["@type"].includes("Product")),
      );
      const jsonProduct = products[0];

      rawProducts.push({
        title: normalizeTypography(String(jsonProduct?.name ?? extract.title)),
        url: page.finalUrl,
        price: priceFromOffers(jsonProduct?.offers) ?? extract.price,
        description: normalizeTypography(
          String(jsonProduct?.description ?? extract.description ?? extract.text.slice(0, 400)),
        ).slice(0, 700),
        images: extract.imageUrls.slice(0, 3),
      });
    }
  }

  // 3. Construction de la banque d'images, indexée pour que le modèle puisse la référencer.
  const images: SiteImage[] = [];
  const seen = new Set<string>();
  const addImage = (url: string, alt: string, source: string): void => {
    let key: string;
    try {
      const parsed = new URL(url);
      key = `${parsed.origin}${parsed.pathname}`;
    } catch {
      return;
    }
    if (seen.has(key) || images.length >= 40) return;
    seen.add(key);
    images.push({ index: images.length, url, alt: alt || source, source });
  };

  for (const product of rawProducts) {
    for (const image of product.images) addImage(image.url, image.alt, product.title);
  }
  for (const image of homeExtract.imageUrls) {
    addImage(image.url, image.alt, homeExtract.title || start.hostname);
  }

  const products: SiteProduct[] = rawProducts
    .filter((product) => product.title.length > 1)
    .map((product) => ({
      title: product.title,
      url: product.url,
      price: product.price,
      description: product.description,
      imageIndexes: product.images
        .map((image) => {
          try {
            const parsed = new URL(image.url);
            return images.find(
              (candidate) => new URL(candidate.url).pathname === parsed.pathname,
            )?.index;
          } catch {
            return undefined;
          }
        })
        .filter((index): index is number => index !== undefined),
    }));

  return {
    url: home.finalUrl,
    origin,
    domain: start.hostname.replace(/^www\./, ""),
    siteName: homeExtract.siteName || homeExtract.title || start.hostname,
    title: homeExtract.title,
    description: homeExtract.description,
    pageText: truncate(homeExtract.text, 6000),
    products,
    images,
    pagesVisited,
  };
}

/* ------------------------------------------------------------------ *
 * Téléchargement des visuels
 * ------------------------------------------------------------------ */

export async function downloadImages(
  snapshot: SiteSnapshot,
  cacheDir: string,
  options: { limit?: number; onProgress?: (message: string) => void } = {},
): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const limit = options.limit ?? 26;
  let downloaded = 0;

  for (const image of snapshot.images) {
    if (downloaded >= limit) break;
    try {
      const response = await fetchWithTimeout(image.url, { headers: { accept: "image/*" } }, 25_000);
      if (!response.ok) continue;

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength < 4_000 || buffer.byteLength > 12_000_000) continue;

      const extension = /\.(jpe?g|png|webp|avif)/i.exec(image.url)?.[0] ?? ".jpg";
      const filePath = path.join(cacheDir, `img-${String(image.index).padStart(2, "0")}${extension}`);
      await fs.writeFile(filePath, buffer);

      const size = await probeImageSize(filePath);
      if (!size || size.width < 320 || size.height < 320) {
        await fs.rm(filePath, { force: true });
        continue;
      }

      image.localPath = filePath;
      image.width = size.width;
      image.height = size.height;
      downloaded += 1;
      options.onProgress?.(`image ${downloaded}/${limit}`);
    } catch {
      /* image inaccessible : on passe à la suivante */
    }
  }
}
