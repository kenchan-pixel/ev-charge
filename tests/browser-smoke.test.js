const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const smokeSource = readFileSync(join(__dirname, "browser-smoke.js"), "utf8");
const smoke = require("./browser-smoke.js");

class FakeWebSocket {
  static instance;

  constructor() {
    this.listeners = new Map();
    FakeWebSocket.instance = this;
  }

  addEventListener(type, listener, options = {}) {
    const wrapped = options.once
      ? (...args) => {
          this.removeEventListener(type, wrapped);
          listener(...args);
        }
      : listener;
    const listeners = this.listeners.get(type) || [];
    listeners.push(wrapped);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener(event);
    }
  }

  send() {}

  close() {
    this.emit("close");
  }
}

function regressionDeadline(promise, timeoutMs = 50) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((unused, reject) => {
      timeout = setTimeout(
        () => reject(new Error("regression deadline elapsed")),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("static smoke server exposes only public site assets", async () => {
  const { server, url } = await smoke.startStaticServer();
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(new URL("calculation-core.js", url))).status, 200);
    assert.equal(
      (await fetch(new URL("tests/calculation-core.test.js", url))).status,
      403,
    );
    assert.equal((await fetch(new URL(".git/config", url))).status, 403);
  } finally {
    await closeServer(server);
  }
});

test("Chrome keeps its sandbox enabled for PR-controlled pages", () => {
  assert.doesNotMatch(smokeSource, /--no-sandbox/);
});

test("CDP commands fail on a hard per-command deadline", async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const cdp = smoke.connectCdp("ws://example.invalid", {
      commandTimeoutMs: 10,
    });
    FakeWebSocket.instance.emit("open");
    await cdp.opened;
    await assert.rejects(
      regressionDeadline(cdp.send("Runtime.enable")),
      /CDP command timed out: Runtime\.enable/,
    );
    cdp.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

for (const [event, error] of [
  ["close", /CDP WebSocket closed/],
  ["error", /CDP WebSocket error/],
]) {
  test(`CDP socket ${event} rejects every pending command`, async () => {
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket;
    try {
      const cdp = smoke.connectCdp("ws://example.invalid");
      FakeWebSocket.instance.emit("open");
      await cdp.opened;
      const pending = cdp.send("Page.enable");
      FakeWebSocket.instance.emit(event);
      await assert.rejects(regressionDeadline(pending), error);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
}

test("waitFor bounds a stalled asynchronous check", async () => {
  await assert.rejects(
    regressionDeadline(
      smoke.waitFor(() => new Promise(() => {}), "stalled probe", 30),
      250,
    ),
    /Timed out waiting for stalled probe/,
  );
});

test("owned-resource cleanup is idempotent", async () => {
  assert.equal(typeof smoke.createIdempotentCleanup, "function");
  let calls = 0;
  const cleanup = smoke.createIdempotentCleanup(async () => {
    calls += 1;
  });

  await Promise.all([cleanup(), cleanup(), cleanup()]);
  assert.equal(calls, 1);
});

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(`${signal} awaits owned-resource cleanup exactly once`, async () => {
    assert.equal(typeof smoke.installSignalCleanup, "function");
    const signalSource = new EventEmitter();
    const exits = [];
    let cleanupCalls = 0;
    const cleanup = smoke.createIdempotentCleanup(async () => {
      cleanupCalls += 1;
    });
    const dispose = smoke.installSignalCleanup(cleanup, {
      signalSource,
      exit: (code) => exits.push(code),
      reportError: (error) => {
        throw error;
      },
    });

    signalSource.emit(signal);
    signalSource.emit(signal);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(cleanupCalls, 1);
    assert.deepEqual(exits, [exitCode]);
    dispose();
  });
}
