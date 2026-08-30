const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

test("CI validates every pull request and master update without a schedule", () => {
  const workflow = readFileSync(
    join(__dirname, "..", ".github", "workflows", "validate.yml"),
    "utf8",
  );

  assert.match(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /^\s*push:/m);
  assert.match(workflow, /branches:\s*\[master\]/);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.match(workflow, /uses: actions\/checkout@v7/);
  assert.match(workflow, /uses: actions\/setup-node@v7/);
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /node --check calculation-core\.js/);
  assert.match(workflow, /node --test/);
  assert.match(workflow, /node tests\/browser-smoke\.js/);
});
