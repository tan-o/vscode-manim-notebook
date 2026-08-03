import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

interface MarkdownRenderer {
  render(source: string, environment?: unknown): string;
}

interface RendererSandbox {
  installTypstRules?: (markdown: MarkdownRenderer) => void;
  requestPending?: (context: { postMessage(message: unknown): unknown }) => void;
}

const MarkdownIt = require("markdown-it") as new () => MarkdownRenderer;

async function configuredMarkdown(): Promise<MarkdownRenderer> {
  const filename = path.resolve(__dirname, "..", "..", "renderer", "typstMarkdown.js");
  const source = (await readFile(filename, "utf8"))
    .replace("export async function activate", "async function activate")
    .concat("\nglobalThis.installTypstRules = installTypstRules;\n");
  const sandbox: RendererSandbox & Record<string, unknown> = { atob, TextDecoder };
  runInNewContext(source, sandbox);
  const markdown = new MarkdownIt();
  assert.ok(sandbox.installTypstRules);
  sandbox.installTypstRules(markdown);
  return markdown;
}

function typstCellEnv() {
  return {
    outputItem: {
      metadata: {
        metadata: { manimJupyterTypst: true },
      },
    },
  };
}

test("Typst renderer claims math only for cells carrying the Typst metadata flag", async () => {
  const markdown = await configuredMarkdown();
  const expression = "integral_a^b f(x) dif x";
  const typst = markdown.render(`$$${expression}$$`, typstCellEnv());
  assert.match(typst, /class="manim-typst-host pending display"/);
  assert.match(typst, /data-expression="integral_a%5Eb%20f\(x\)%20dif%20x"/);
  assert.doesNotMatch(
    markdown.render(`$$${expression}$$`, { outputItem: { metadata: {} } }),
    /manim-typst-host/,
  );
  assert.doesNotMatch(
    markdown.render(`$$${expression}$$`, { outputItem: {} }),
    /manim-typst-host/,
  );
});

test("Typst renderer claims inline and multiline display math synchronously", async () => {
  const markdown = await configuredMarkdown();
  const env = typstCellEnv();
  assert.match(markdown.render("Energy: $E=mc^2$", env), /manim-typst-host pending inline/);
  assert.match(
    markdown.render("$$\nsum_(k=1)^n k\n$$", env),
    /class="manim-typst-host pending display"/,
  );
});

test("Typst renderer always requests native MathML without writing a cell metadata cache", async () => {
  const markdown = await configuredMarkdown();
  const expression = "sum_(k=1)^n";
  const html = markdown.render(`$${expression}$`, typstCellEnv());
  assert.match(html, /class="manim-typst-host pending inline"/);
  assert.match(html, /data-expression="sum_\(k%3D1\)%5En"/);
  assert.doesNotMatch(html, /manimJupyterTypstSvgs/);
});

test("Typst renderer retries a request lost during extension-host startup", async () => {
  const filename = path.resolve(__dirname, "..", "..", "renderer", "typstMarkdown.js");
  const source = (await readFile(filename, "utf8"))
    .replace("export async function activate", "async function activate")
    .concat("\nglobalThis.requestPending = requestPending;\n");
  const requests: unknown[] = [];
  let retry: (() => void) | undefined;
  const element = {
    dataset: { expression: encodeURIComponent("integral_a^b f(x) dif x") },
    classList: {
      contains: (name: string) => name === "display",
      add: (_name: string) => undefined,
    },
    isConnected: true,
    textContent: "",
  };
  const sandbox = {
    atob,
    TextDecoder,
    document: {
      querySelectorAll: (_selector: string) => [element],
    },
    setTimeout: (callback: () => void, _delay: number) => {
      retry = callback;
      return 1;
    },
    clearTimeout: (_timer: unknown) => undefined,
  } as RendererSandbox & Record<string, unknown>;
  runInNewContext(source, sandbox);
  assert.ok(sandbox.requestPending);
  sandbox.requestPending({
    postMessage: (message) => {
      requests.push(message);
      return false;
    },
  });
  assert.equal(requests.length, 1);
  assert.ok(retry);
  retry();
  assert.equal(requests.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(requests[0])),
    {
      type: "renderTypst",
      id: (requests[0] as { id: string }).id,
      expression: "integral_a^b f(x) dif x",
      display: true,
    },
  );
});

test("Typst MathML styles follow the native markdown-style template mechanism", async () => {
  const source = await readFile(
    path.resolve(__dirname, "..", "..", "renderer", "typstMarkdown.js"),
    "utf8",
  );
  assert.match(source, /classList\.add\("markdown-style"\)/);
  assert.match(source, /inline math\{font-size:1\.06em/);
  assert.match(source, /display math\{font-size:2\.2em/);
  assert.match(source, /observedShadowRoots/);
  assert.match(source, /outputItem\.metadata/);
  assert.doesNotMatch(source, /getNotebookScope/);
  assert.doesNotMatch(source, /manim-typst-svg/);
  assert.doesNotMatch(source, /inline:only-child/);
});
