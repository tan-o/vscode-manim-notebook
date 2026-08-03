// Vendors the reveal.js distribution (used by manim-slides HTML output) into
// the extension so presentations play natively in VS Code without any CDN.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules", "reveal.js", "dist");
const target = path.join(root, "renderer", "reveal", "dist");

if (!fs.existsSync(path.join(source, "reveal.js"))) {
  throw new Error("reveal.js is not installed; run `npm install` first.");
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });

console.log(`copied reveal.js dist -> ${path.relative(root, target)}`);
