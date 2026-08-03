import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  documentationSymbol,
  extractOfficialDocHtml,
  isOfficialManimDocsUrl,
  OfficialDocsClient,
  resolveSymbolFromIndex,
  resolveSymbolFromInventory,
} from "../src/officialDocs";

const WRITE_URL = "https://docs.manim.community/en/stable/reference/manim.animation.creation.Write.html";

test("only the Manim Community documentation origin is accepted", () => {
  assert.equal(isOfficialManimDocsUrl(WRITE_URL), true);
  assert.equal(isOfficialManimDocsUrl("http://docs.manim.community/en/stable/"), false);
  assert.equal(isOfficialManimDocsUrl("https://docs.manim.community.evil.test/"), false);
});

test("official Sphinx article is extracted, sanitized, and linked for inline navigation", () => {
  const raw = `<!doctype html><html><body>
    <nav>large navigation</nav>
    <main id="furo-main-content"><article role="main" onclick="steal()">
      <h1>Write<a class="headerlink" href="#Write">¶</a></h1>
      <p>Simulate hand-writing a <a href="../text/text_mobject.html">Text</a>.</p>
      <script>globalThis.pwned = true</script>
      <pre class="highlight-python"><code>self.play(Write(Text("Hello")))</code></pre>
      <a href="https://evil.test/">external</a>
    </article></main>
  </body></html>`;
  const result = extractOfficialDocHtml(raw, WRITE_URL);
  assert.match(result, /<h1>Write<\/h1>/);
  assert.match(result, /self\.play\(Write/);
  assert.match(result, /data-doc-url="https:\/\/docs\.manim\.community\/en\/stable\/text\/text_mobject\.html"/);
  assert.doesNotMatch(result, /large navigation|script|onclick|evil\.test|headerlink/);
});

test("a URL fragment keeps the matching Sphinx API definition", () => {
  const source = `${WRITE_URL}#manim.animation.creation.Write.begin`;
  const raw = `<article role="main">
    <dl class="py method"><dt id="manim.animation.creation.Write.finish">finish()</dt><dd>Finish it.</dd></dl>
    <dl class="py method"><dt id="manim.animation.creation.Write.begin">begin()</dt><dd>Begin the animation.</dd></dl>
  </article>`;
  const result = extractOfficialDocHtml(raw, source);
  assert.match(result, /Begin the animation/);
  assert.doesNotMatch(result, /Finish it/);
});

test("a symbol can be resolved through the official general index", () => {
  const index = `<a href="reference/manim.animation.creation.Write.html#manim.animation.creation.Write">Write</a>`;
  assert.equal(
    resolveSymbolFromIndex(index, "Write"),
    "https://docs.manim.community/en/stable/reference/manim.animation.creation.Write.html#manim.animation.creation.Write",
  );
});

test("a class is resolved to its exact official API page through objects.inv", () => {
  const inventory = [
    "manim.mobject.geometry.polygram.Square py:class 1 reference/manim.mobject.geometry.polygram.Square.html -",
    "manim.mobject.geometry.polygram py:module 1 reference/manim.mobject.geometry.polygram.html -",
  ].join("\n");
  assert.equal(
    resolveSymbolFromInventory(inventory, "Square"),
    "https://docs.manim.community/en/stable/reference/manim.mobject.geometry.polygram.Square.html",
  );
});

test("a method inventory URI keeps the exact API fragment", () => {
  const inventory = "manim.scene.scene.Scene.play py:method 1 reference/manim.scene.scene.Scene.html#$ -";
  assert.equal(
    resolveSymbolFromInventory(inventory, "play"),
    "https://docs.manim.community/en/stable/reference/manim.scene.scene.Scene.html#manim.scene.scene.Scene.play",
  );
});

test("documentation lookup prefers a Manim call over a user variable", () => {
  assert.equal(documentationSymbol("square", "square = Square()"), "Square");
  assert.equal(documentationSymbol("square", "square.to_edge(LEFT)"), "to_edge");
  assert.equal(documentationSymbol("Write", "self.play(Write(title))"), "Write");
  assert.equal(documentationSymbol("value", "value = 42"), undefined);
});

function mockResponse(url: string, body: string | Buffer, contentType: string): Response {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({ "content-type": contentType, "content-length": String(bytes.length) }),
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  } as Response;
}

test("official documentation retries transient fetch failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "manim-docs-retry-"));
  let calls = 0;
  const fetcher = (async (input: string | URL | Request) => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed");
    return mockResponse(
      String(input),
      '<article role="main"><h1>Write</h1><p>Documentation body.</p></article>',
      "text/html",
    );
  }) as typeof fetch;
  try {
    const client = new OfficialDocsClient(directory, fetcher, 0);
    const result = await client.load(WRITE_URL);
    assert.equal(calls, 3);
    assert.match(result.html, /Documentation body/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Sphinx inventory persists so symbol lookup works after restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "manim-docs-inventory-"));
  const inventoryUrl = "https://docs.manim.community/en/stable/objects.inv";
  const inventoryBody = Buffer.concat([
    Buffer.from(
      "# Sphinx inventory version 2\n# Project: Manim\n# Version: test\n# The remainder of this file is compressed using zlib.\n",
    ),
    deflateSync(Buffer.from(
      "manim.mobject.geometry.polygram.Square py:class 1 reference/manim.mobject.geometry.polygram.Square.html -\n",
    )),
  ]);
  let firstInventoryRequests = 0;
  const online = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === inventoryUrl) {
      firstInventoryRequests += 1;
      return mockResponse(url, inventoryBody, "application/octet-stream");
    }
    return mockResponse(url, '<article role="main"><h1>Square</h1></article>', "text/html");
  }) as typeof fetch;
  let secondInventoryRequests = 0;
  const restarted = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("objects.inv")) {
      secondInventoryRequests += 1;
      throw new TypeError("offline");
    }
    return mockResponse(url, '<article role="main"><h1>Square</h1></article>', "text/html");
  }) as typeof fetch;
  try {
    const search = "https://docs.manim.community/en/stable/search.html?q=Square";
    await new OfficialDocsClient(directory, online, 0).load(search, "Square");
    await new OfficialDocsClient(directory, restarted, 0).load(search, "Square");
    assert.equal(firstInventoryRequests, 1);
    assert.equal(secondInventoryRequests, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
