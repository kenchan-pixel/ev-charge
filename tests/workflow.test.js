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
  assert.match(
    workflow,
    /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/,
  );
  assert.doesNotMatch(workflow, /actions\/(checkout|setup-node)@v\d/);
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /node --check calculation-core\.js/);
  assert.match(workflow, /node --test/);
  assert.match(workflow, /node --check tests\/browser-smoke\.test\.js/);
  assert.match(workflow, /node tests\/browser-smoke\.js/);
});
