import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { inflateSync } from "node:zlib";

const DOCS_ORIGIN = "https://docs.manim.community";
const MAX_DOWNLOAD_BYTES = 3 * 1024 * 1024;
const MAX_RENDERED_BYTES = 220 * 1024;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INVENTORY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
const MAX_INVENTORY_BYTES = 12 * 1024 * 1024;

export interface OfficialDocResult {
  html: string;
  sourceUrl: string;
  fetchedAt: string;
  cached: boolean;
  stale: boolean;
}

interface CacheRecord {
  html: string;
  sourceUrl: string;
  fetchedAt: string;
}

interface InventoryCacheRecord {
  inventory: string;
  sourceUrl: string;
  fetchedAt: string;
}

interface RetryableError extends Error {
  retryable?: boolean;
  status?: number;
  cause?: unknown;
}

export function isOfficialManimDocsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === DOCS_ORIGIN;
  } catch {
    return false;
  }
}

/** Prefer an API call from the statement over a user-defined variable. */
export function documentationSymbol(
  cursorWord: string,
  statement: string,
): string | undefined {
  const word = cursorWord.trim();
  if (/^[A-Za-z_]\w*$/.test(word)) {
    const escaped = escapeRegExp(word);
    const usedAsApi = new RegExp(`(?:\\.|\\b)${escaped}\\s*\\(`).test(statement) ||
      /^[A-Z][A-Za-z0-9_]*$/.test(word) ||
      /^[A-Z][A-Z0-9_]*$/.test(word);
    if (usedAsApi) return word;
  }
  return statement.match(/\b([A-Z][A-Za-z0-9_]*)\s*\(/)?.[1]
    ?? statement.match(/\bself\.([a-z_]\w*)\s*\(/)?.[1]
    ?? statement.match(/\.([a-z_]\w*)\s*\(/)?.[1]
    ?? statement.match(/\b([a-z_]\w*)\s*\(/)?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");
}

function textOnly(value: string): string {
  return decodeBasicEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractArticle(html: string): string {
  const article = html.match(/<article\b[^>]*\brole=["']main["'][^>]*>([\s\S]*?)<\/article>/i)
    ?? html.match(/<main\b[^>]*\bid=["']furo-main-content["'][^>]*>([\s\S]*?)<\/main>/i)
    ?? html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return article?.[1] ?? html;
}

function extractFragment(html: string, fragment: string): string {
  if (!fragment) return html;
  const escaped = escapeRegExp(fragment);
  const definitionLists = html.match(/<dl\b[^>]*>[\s\S]*?<\/dl>/gi) ?? [];
  const matchedList = definitionLists.find((block) =>
    new RegExp(`\\bid=["']${escaped}["']`, "i").test(block),
  );
  if (matchedList) return matchedList;

  const section = html.match(
    new RegExp(`<section\\b[^>]*\\bid=["']${escaped}["'][^>]*>[\\s\\S]*?<\\/section>`, "i"),
  );
  return section?.[0] ?? html;
}

/**
 * Furo (the Manim docs theme) does not give every API a `<dl id="...">`
 * fragment; many pages only carry the module-level `<dl>` and per-method
 * headings. When a fragment cannot be matched structurally, fall back to the
 * heading (`<h2>` / `<h3>` / `<dt>` / `<h4>`) whose id equals the fragment and
 * cut the article there, so the panel shows the single requested API instead
 * of the whole page.
 */
function extractHeadingFragment(html: string, fragment: string): string {
  if (!fragment) return html;
  const escaped = escapeRegExp(fragment);
  const heading = html.match(
    new RegExp(`<(?:h[234]|dt)\\b[^>]*\\bid=["']${escaped}["'][^>]*>[\\s\\S]*?(?=<\\/(?:h[234]|dt)>)`, "i"),
  );
  if (!heading) return html;
  const start = heading.index ?? 0;
  const after = html.slice(start);
  // The requested API's definition block runs until the next heading of the
  // same or higher level, or a sibling `<dt>`.
  const next = after.match(/<(?:h[234]|dt)\b[^>]*>/g) ?? [];
  let end = html.length;
  if (next.length > 1) {
    const nextStart = html.indexOf(next[1], start);
    if (nextStart > start) end = nextStart;
  }
  return html.slice(start, end);
}

function safeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rewriteLink(tag: string, sourceUrl: string): string {
  const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
  if (!href) return "<a>";
  try {
    const absolute = new URL(href, sourceUrl).toString();
    return isOfficialManimDocsUrl(absolute)
      ? `<a href="#" data-doc-url="${safeAttribute(absolute)}">`
      : "<a>";
  } catch {
    return "<a>";
  }
}

/** Extracts the official Sphinx article and reduces it to inert, webview-safe HTML. */
export function extractOfficialDocHtml(rawHtml: string, sourceUrl: string): string {
  if (!isOfficialManimDocsUrl(sourceUrl)) {
    throw new Error("只允许解析 Manim Community 官方文档域名。");
  }
  const fragment = new URL(sourceUrl).hash.slice(1);
  let decodedFragment = fragment;
  try {
    decodedFragment = decodeURIComponent(fragment);
  } catch {
    // Keep malformed-but-inert fragments literal; the page body remains usable.
  }
  let html = extractFragment(extractArticle(rawHtml), decodedFragment);
  html = extractHeadingFragment(html, decodedFragment);
  html = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template|noscript|iframe|object|embed|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(img|input|button)\b[^>]*\/?\s*>/gi, "")
    .replace(/<a\b[^>]*\bclass=["'][^"']*headerlink[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/<a\b[^>]*\bclass=["'][^"']*viewcode-link[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, "");

  const allowed = new Set([
    "a", "blockquote", "br", "code", "dd", "details", "div", "dl", "dt", "em",
    "h1", "h2", "h3", "h4", "hr", "kbd", "li", "ol", "p", "pre", "samp", "section",
    "small", "span", "strong", "summary", "table", "tbody", "td", "th", "thead", "tr", "ul",
  ]);
  html = html.replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (tag, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) return "";
    if (tag.startsWith("</")) return name === "a" ? "</a>" : `</${name}>`;
    if (name === "a") return rewriteLink(tag, sourceUrl);
    if (name === "br" || name === "hr") return `<${name}>`;
    return `<${name}>`;
  });
  html = html.replace(/\s{3,}/g, "\n\n").trim();
  if (!textOnly(html)) {
    throw new Error("官方页面已加载，但没有解析出可显示的正文。");
  }
  if (Buffer.byteLength(html, "utf8") > MAX_RENDERED_BYTES) {
    html = Buffer.from(html, "utf8").subarray(0, MAX_RENDERED_BYTES).toString("utf8");
  }
  return html;
}

export function resolveSymbolFromIndex(
  rawHtml: string,
  symbol: string,
  indexUrl = `${DOCS_ORIGIN}/en/stable/genindex.html`,
): string | undefined {
  const normalized = symbol.trim().replace(/\(\)$/, "");
  if (!/^[A-Za-z_]\w*$/.test(normalized)) return undefined;
  const candidates: Array<{ href: string; label: string }> = [];
  for (const match of rawHtml.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    candidates.push({ href: match[2], label: textOnly(match[3]).replace(/\(\)$/, "") });
  }
  const exact = candidates.find((candidate) => candidate.label === normalized)
    ?? candidates.find((candidate) => candidate.label.endsWith(`.${normalized}`));
  if (!exact) return undefined;
  try {
    const url = new URL(exact.href, indexUrl).toString();
    return isOfficialManimDocsUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve one API name from Sphinx's official objects.inv inventory. */
export function resolveSymbolFromInventory(
  inventory: string,
  symbol: string,
  inventoryUrl = `${DOCS_ORIGIN}/en/stable/objects.inv`,
): string | undefined {
  const normalized = symbol.trim().replace(/\(\)$/, "");
  if (!/^[A-Za-z_]\w*$/.test(normalized)) return undefined;
  const roleRank: Record<string, number> = {
    "py:class": 0,
    "py:function": 1,
    "py:method": 2,
    "py:attribute": 3,
    "py:data": 4,
    "std:doc": 9,
  };
  const candidates: Array<{ name: string; role: string; uri: string }> = [];
  for (const line of inventory.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+-?\d+\s+(\S+)\s+.*$/);
    if (!match) continue;
    const name = match[1];
    if (name.split(".").at(-1) !== normalized) continue;
    candidates.push({ name, role: match[2], uri: match[3] });
  }
  candidates.sort((left, right) => {
    const role = (roleRank[left.role] ?? 8) - (roleRank[right.role] ?? 8);
    if (role) return role;
    const leftReference = left.uri.startsWith("reference/") ? 0 : 1;
    const rightReference = right.uri.startsWith("reference/") ? 0 : 1;
    if (leftReference !== rightReference) return leftReference - rightReference;
    return left.name.length - right.name.length;
  });
  const candidate = candidates[0];
  if (!candidate) return undefined;
  try {
    const uri = candidate.uri.endsWith("$")
      ? `${candidate.uri.slice(0, -1)}${candidate.name}`
      : candidate.uri;
    const url = new URL(uri, inventoryUrl).toString();
    return isOfficialManimDocsUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function decodeSphinxInventory(value: Buffer): string {
  let offset = 0;
  for (let line = 0; line < 4; line += 1) {
    const newline = value.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("Manim 官方文档索引格式无效。");
    offset = newline + 1;
  }
  const result = inflateSync(value.subarray(offset));
  if (result.byteLength > MAX_INVENTORY_BYTES) {
    throw new Error("Manim 官方文档索引过大，已停止读取。");
  }
  return result.toString("utf8");
}

export class OfficialDocsClient {
  private readonly memory = new Map<string, CacheRecord>();
  private readonly inFlight = new Map<string, Promise<OfficialDocResult>>();
  private readonly inventories = new Map<string, string>();

  constructor(
    private readonly cacheDirectory: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly retryDelayMs = RETRY_DELAY_MS,
  ) {}

  async load(requestedUrl: string, symbol?: string): Promise<OfficialDocResult> {
    let sourceUrl = requestedUrl;
    if (!isOfficialManimDocsUrl(sourceUrl)) {
      throw new Error("文档地址不是 Manim Community 官方域名。");
    }
    if (new URL(sourceUrl).pathname.endsWith("/search.html") && symbol) {
      sourceUrl = await this.resolveSymbol(symbol) ?? "";
      if (!sourceUrl) {
        throw new Error(`Manim 官方 API 索引中没有找到 ${symbol}。`);
      }
    }
    const fresh = await this.readCache(sourceUrl);
    if (fresh && Date.now() - Date.parse(fresh.fetchedAt) < CACHE_MAX_AGE_MS) {
      return { ...fresh, cached: true, stale: false };
    }
    const running = this.inFlight.get(sourceUrl);
    if (running) return running;
    const request = this.loadRemote(sourceUrl, fresh);
    this.inFlight.set(sourceUrl, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(sourceUrl);
    }
  }

  private async loadRemote(
    sourceUrl: string,
    fallback: CacheRecord | undefined,
  ): Promise<OfficialDocResult> {
    try {
      const raw = await this.fetchText(sourceUrl);
      const record: CacheRecord = {
        html: extractOfficialDocHtml(raw, sourceUrl),
        sourceUrl,
        fetchedAt: new Date().toISOString(),
      };
      this.memory.set(sourceUrl, record);
      void this.writeCache(record);
      return { ...record, cached: false, stale: false };
    } catch (error) {
      if (fallback) return { ...fallback, cached: true, stale: true };
      throw error;
    }
  }

  private async resolveSymbol(symbol: string): Promise<string | undefined> {
    let loadedInventory = false;
    let lastError: unknown;
    for (const version of ["stable", "latest"]) {
      const inventoryUrl = `${DOCS_ORIGIN}/en/${version}/objects.inv`;
      try {
        const inventory = await this.loadInventory(inventoryUrl);
        loadedInventory = true;
        const resolved = resolveSymbolFromInventory(inventory, symbol, inventoryUrl);
        if (resolved) return resolved;
      } catch (error) {
        lastError = error;
      }
    }
    if (!loadedInventory && lastError) throw lastError;
    return undefined;
  }

  private async loadInventory(inventoryUrl: string): Promise<string> {
    const memory = this.inventories.get(inventoryUrl);
    if (memory) return memory;
    const fallback = await this.readInventoryCache(inventoryUrl);
    if (fallback && Date.now() - Date.parse(fallback.fetchedAt) < INVENTORY_CACHE_MAX_AGE_MS) {
      this.inventories.set(inventoryUrl, fallback.inventory);
      return fallback.inventory;
    }
    try {
      const inventory = decodeSphinxInventory(await this.fetchBytes(
        inventoryUrl,
        "application/octet-stream,*/*",
      ));
      this.inventories.set(inventoryUrl, inventory);
      await this.writeInventoryCache({
        inventory,
        sourceUrl: inventoryUrl,
        fetchedAt: new Date().toISOString(),
      });
      return inventory;
    } catch (error) {
      if (fallback) {
        this.inventories.set(inventoryUrl, fallback.inventory);
        return fallback.inventory;
      }
      throw error;
    }
  }

  private async fetchText(url: string): Promise<string> {
    return (await this.fetchBytes(url, "text/html,application/xhtml+xml")).toString("utf8");
  }

  private async fetchBytes(url: string, accept: string): Promise<Buffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await this.fetchImplementation(url, {
          method: "GET",
          signal: controller.signal,
          redirect: "follow",
          headers: {
            Accept: accept,
            "Accept-Encoding": "gzip, br",
            "Cache-Control": "no-cache",
            "User-Agent": "Manim-CE-Jupyter-VSCode/0.10.1",
          },
        });
        if (!response.ok) {
          const error = new Error(`Manim 官方文档返回 HTTP ${response.status}。`) as RetryableError;
          error.status = response.status;
          error.retryable = response.status === 408 || response.status === 425 ||
            response.status === 429 || response.status >= 500;
          throw error;
        }
        if (!isOfficialManimDocsUrl(response.url)) throw new Error("官方文档发生了不安全的跨域跳转。");
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > MAX_DOWNLOAD_BYTES) throw new Error("官方文档页面过大，已停止读取。");
        const result = Buffer.from(await response.arrayBuffer());
        if (result.byteLength > MAX_DOWNLOAD_BYTES) {
          throw new Error("官方文档页面过大，已停止读取。");
        }
        return result;
      } catch (error) {
        lastError = error;
        const value = error as RetryableError;
        const retryable = value.name === "AbortError" || value.retryable === true ||
          (value.name === "TypeError" && /fetch failed/i.test(value.message));
        if (!retryable || attempt === REQUEST_ATTEMPTS - 1) break;
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * 2 ** attempt));
    }
    const value = lastError as RetryableError | undefined;
    if (value?.name === "AbortError") {
      throw new Error(`连接 Manim 官方文档超时（已尝试 ${REQUEST_ATTEMPTS} 次）。`);
    }
    if (value?.status) throw value;
    const cause = value?.cause as { code?: unknown } | undefined;
    const detail = typeof cause?.code === "string" ? `：${cause.code}` : "";
    throw new Error(`连接 Manim 官方文档失败${detail}（已尝试 ${REQUEST_ATTEMPTS} 次）。`);
  }

  private cachePath(url: string): string {
    const name = createHash("sha256").update(url).digest("hex");
    return path.join(this.cacheDirectory, `${name}.json`);
  }

  private inventoryCachePath(url: string): string {
    const name = createHash("sha256").update(url).digest("hex");
    return path.join(this.cacheDirectory, `inventory-${name}.json`);
  }

  private async readCache(url: string): Promise<CacheRecord | undefined> {
    const memory = this.memory.get(url);
    if (memory) return memory;
    try {
      const record = JSON.parse(await fs.readFile(this.cachePath(url), "utf8")) as CacheRecord;
      if (record.sourceUrl !== url || typeof record.html !== "string" || typeof record.fetchedAt !== "string") {
        return undefined;
      }
      this.memory.set(url, record);
      return record;
    } catch {
      return undefined;
    }
  }

  private async writeCache(record: CacheRecord): Promise<void> {
    try {
      await fs.mkdir(this.cacheDirectory, { recursive: true });
      await fs.writeFile(this.cachePath(record.sourceUrl), JSON.stringify(record), "utf8");
    } catch {
      // Documentation still works in memory when disk cache is unavailable.
    }
  }

  private async readInventoryCache(url: string): Promise<InventoryCacheRecord | undefined> {
    try {
      const record = JSON.parse(
        await fs.readFile(this.inventoryCachePath(url), "utf8"),
      ) as InventoryCacheRecord;
      if (
        record.sourceUrl !== url ||
        typeof record.inventory !== "string" ||
        typeof record.fetchedAt !== "string" ||
        Buffer.byteLength(record.inventory, "utf8") > MAX_INVENTORY_BYTES
      ) {
        return undefined;
      }
      return record;
    } catch {
      return undefined;
    }
  }

  private async writeInventoryCache(record: InventoryCacheRecord): Promise<void> {
    try {
      await fs.mkdir(this.cacheDirectory, { recursive: true });
      await fs.writeFile(this.inventoryCachePath(record.sourceUrl), JSON.stringify(record), "utf8");
    } catch {
      // A failed disk cache must not prevent online documentation.
    }
  }
}
