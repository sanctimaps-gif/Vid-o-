/**
 * Carte de fin : le plan de clôture qui rappelle le nom du site et où le trouver.
 *
 * Elle est dessinée en HTML puis photographiée par le navigateur déjà nécessaire à
 * la visite, plutôt qu'assemblée en filtres FFmpeg : une mise en page se décrit
 * bien mieux en CSS qu'en `drawtext`, et le résultat se relit.
 */
import path from "node:path";
import fs from "node:fs/promises";

export interface EndCardOptions {
  siteName: string;
  tagline: string;
  domain: string;
  /** Adresse d'un visuel du site, affiché au-dessus du nom. */
  logo?: string | null;
  accent?: string;
  background?: string;
  width?: number;
  outDir: string;
}

const escape = (text: string) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export function endCardHtml(options: EndCardOptions): string {
  const { siteName, tagline, domain, logo, accent = "#e8b44d", background = "#0b1020" } = options;

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:100vw;height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:5vh;padding:0 9vw;text-align:center;
    background:radial-gradient(120% 70% at 50% 28%, ${accent}22 0%, transparent 60%), ${background};
    color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .logo{width:42vw;height:42vw;object-fit:contain;border-radius:6vw}
  .mark{width:34vw;height:34vw;border-radius:50%;display:flex;align-items:center;justify-content:center;
    background:${accent};color:${background};font-size:16vw;font-weight:800}
  h1{font-size:9.5vw;font-weight:800;letter-spacing:.02em;line-height:1.05}
  p{font-size:4.6vw;color:${accent};font-weight:600;line-height:1.35}
  .rule{width:22vw;height:.5vw;background:${accent};opacity:.7;border-radius:1vw}
  .domain{font-size:4.2vw;color:#c8d0e4;letter-spacing:.06em}
</style></head><body>
  ${
    logo
      ? `<img class="logo" src="${escape(logo)}" alt="">`
      : `<div class="mark">${escape((siteName || domain).trim().charAt(0).toUpperCase() || "•")}</div>`
  }
  <h1>${escape(siteName || domain)}</h1>
  <div class="rule"></div>
  ${tagline ? `<p>${escape(tagline)}</p>` : ""}
  <div class="domain">${escape(domain)}</div>
</body></html>`;
}

/** Photographie la carte de fin et rend le chemin de l'image. */
export async function renderEndCard(options: EndCardOptions): Promise<string> {
  const { width = 540, outDir } = options;
  const height = Math.round((width * 16) / 9);
  const file = path.join(outDir, "fin.png");
  await fs.mkdir(outDir, { recursive: true });

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    executablePath: process.env.VIDO_CHROMIUM || undefined,
    args: ["--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      // Deux fois la taille : la carte de fin est une image fixe, elle peut être nette.
      deviceScaleFactor: 2,
    });
    await page.setContent(endCardHtml(options), { waitUntil: "load" });
    // Un logo distant peut mettre un instant ; sans lui la carte reste correcte.
    await page.waitForTimeout(1200);
    await page.screenshot({ path: file, type: "png" });
  } finally {
    await browser.close().catch(() => {});
  }
  return file;
}
