const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");

test("static page loads the calculation core before its UI adapter", () => {
  const coreScript = '<script src="calculation-core.js"></script>';
  const coreIndex = html.indexOf(coreScript);
  const inlineScriptIndex = html.indexOf("<script>", coreIndex + coreScript.length);

  assert.notEqual(coreIndex, -1);
  assert.ok(inlineScriptIndex > coreIndex);
});

test("static hosting, install, and localStorage contracts stay relative and stable", () => {
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /href="apple-touch-icon\.png"/);
  assert.match(html, /const STORAGE_KEY='ev-calculator-v22';/);
  assert.match(html, /const KEY='evcalc_theme';/);
});

test("inline JavaScript remains syntactically valid", () => {
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(inlineScripts.length > 0);

  for (const [, source] of inlineScripts) {
    new vm.Script(source);
  }
});

test("README documents formulas, tests, and the maintenance workflow", () => {
  assert.match(readme, /## Calculation core/);
  assert.match(readme, /battery energy = wall energy × efficiency/);
  assert.match(readme, /required wall energy = required battery energy ÷ efficiency/);
  assert.match(readme, /estimated capacity = wall energy × efficiency ÷ SOC change/);
  assert.match(readme, /node --test/);
  assert.match(readme, /node tests\/browser-smoke\.js/);
  assert.match(readme, /## Maintenance workflow/);
});
