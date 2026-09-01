const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

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

test("static smoke server retries a browser-blocked ephemeral port", async () => {
  let probeCalls = 0;
  const badPortError = new TypeError("fetch failed", {
    cause: new Error("bad port"),
  });
  const { server, url } = await smoke.startStaticServer({
    probe: async () => {
      probeCalls += 1;
      if (probeCalls === 1) throw badPortError;
    },
  });

  try {
    assert.equal(probeCalls, 2);
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await closeServer(server);
  }
});

test("static smoke server bounds a stalled safety probe", async () => {
  let releaseProbe;
  const stalledProbe = new Promise((resolveProbe) => {
    releaseProbe = resolveProbe;
  });
  const startingServer = smoke.startStaticServer({
    probe: () => stalledProbe,
    probeTimeoutMs: 10,
  });

  try {
    await assert.rejects(
      regressionDeadline(startingServer, 100),
      /Static server probe timed out/,
    );
  } finally {
    releaseProbe();
    try {
      const { server } = await startingServer;
      await closeServer(server);
    } catch {
      // The repaired path rejects after closing its owned server.
    }
  }
});

test("static smoke server closes on an unexpected probe failure", async () => {
  let probeCalls = 0;
  await assert.rejects(
    regressionDeadline(
      smoke.startStaticServer({
        probe: async () => {
          probeCalls += 1;
          throw new Error("probe failed");
        },
      }),
      250,
    ),
    /probe failed/,
  );
  assert.equal(probeCalls, 1);
});

test("static smoke server bounds repeated bad-port retries", async () => {
  let probeCalls = 0;
  const badPortError = new TypeError("fetch failed", {
    cause: new Error("bad port"),
  });
  await assert.rejects(
    regressionDeadline(
      smoke.startStaticServer({
        probe: async () => {
          probeCalls += 1;
          throw badPortError;
        },
        maxBadPortRetries: 2,
      }),
      250,
    ),
    (error) => error === badPortError,
  );
  assert.equal(probeCalls, 3);
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

test("owned-resource cleanup runs every step before reporting failures", async () => {
  const calls = [];
  const cdpError = new Error("CDP close failed");
  const serverError = new Error("server close failed");

  await assert.rejects(
    smoke.runCleanupSteps([
      ["CDP", async () => {
        calls.push("CDP");
        throw cdpError;
      }],
      ["browser", async () => calls.push("browser")],
      ["Chrome", async () => calls.push("Chrome")],
      ["server", async () => {
        calls.push("server");
        throw serverError;
      }],
      ["profile", async () => calls.push("profile")],
    ]),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.message, /owned-resource cleanup failed/i);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0].cause, cdpError);
      assert.equal(error.errors[1].cause, serverError);
      return true;
    },
  );

  assert.deepEqual(calls, ["CDP", "browser", "Chrome", "server", "profile"]);
});

test("profile cleanup outlasts a delayed Windows file-lock release", async () => {
  assert.equal(typeof smoke.removeOwnedProfile, "function");
  let attempts = 0;
  const waits = [];

  await smoke.removeOwnedProfile(
    join(tmpdir(), "ev-charge-browser-smoke-regression"),
    {
      remove: () => {
        attempts += 1;
        if (attempts <= 10) {
          const error = new Error("profile remains locked");
          error.code = "EPERM";
          throw error;
        }
      },
      wait: async (delayMs) => waits.push(delayMs),
    },
  );

  assert.equal(attempts, 11);
  assert.equal(waits.length, 10);
});

test("profile cleanup retries transient ENOTEMPTY failures", async () => {
  let attempts = 0;
  const waits = [];

  await smoke.removeOwnedProfile(
    join(tmpdir(), "ev-charge-browser-smoke-regression"),
    {
      remove: () => {
        attempts += 1;
        if (attempts <= 3) {
          const error = new Error("profile directory is not empty yet");
          error.code = "ENOTEMPTY";
          throw error;
        }
      },
      wait: async (delayMs) => waits.push(delayMs),
      maxAttempts: 5,
    },
  );

  assert.equal(attempts, 4);
  assert.equal(waits.length, 3);
});

test("profile cleanup retries transient EBUSY failures", async () => {
  let attempts = 0;

  await smoke.removeOwnedProfile(
    join(tmpdir(), "ev-charge-browser-smoke-regression"),
    {
      remove: () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("profile remains busy");
          error.code = "EBUSY";
          throw error;
        }
      },
      wait: async () => {},
    },
  );

  assert.equal(attempts, 2);
});

test("profile cleanup does not retry unexpected removal failures", async () => {
  let attempts = 0;
  let waits = 0;

  await assert.rejects(
    smoke.removeOwnedProfile(
      join(tmpdir(), "ev-charge-browser-smoke-regression"),
      {
        remove: () => {
          attempts += 1;
          const error = new Error("access denied");
          error.code = "EACCES";
          throw error;
        },
        wait: async () => {
          waits += 1;
        },
      },
    ),
    (error) => error.code === "EACCES",
  );

  assert.equal(attempts, 1);
  assert.equal(waits, 0);
});

test("profile cleanup rejects unowned paths before removal", async () => {
  const unsafePaths = [
    join(tmpdir(), "not-an-owned-browser-profile"),
    resolve(tmpdir(), "..", "ev-charge-browser-smoke-outside-temp"),
  ];

  for (const unsafePath of unsafePaths) {
    let removeCalls = 0;
    await assert.rejects(
      smoke.removeOwnedProfile(unsafePath, {
        remove: () => {
          removeCalls += 1;
        },
      }),
      /Refusing to remove unexpected browser profile/,
    );
    assert.equal(removeCalls, 0);
  }
});

test("profile cleanup stops at its bounded retry limit", async () => {
  let attempts = 0;
  const waits = [];

  await assert.rejects(
    smoke.removeOwnedProfile(
      join(tmpdir(), "ev-charge-browser-smoke-regression"),
      {
        remove: () => {
          attempts += 1;
          const error = new Error("profile directory remains non-empty");
          error.code = "ENOTEMPTY";
          throw error;
        },
        wait: async (delayMs) => waits.push(delayMs),
        maxAttempts: 3,
      },
    ),
    (error) => error.code === "ENOTEMPTY",
  );

  assert.equal(attempts, 3);
  assert.equal(waits.length, 2);
});

test("a second signal during cleanup shares the pending task before disposal", async () => {
  const signalSource = new EventEmitter();
  const exits = [];
  let cleanupCalls = 0;
  let releaseCleanup;
  const cleanupBlock = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const cleanup = smoke.createIdempotentCleanup(async () => {
    cleanupCalls += 1;
    await cleanupBlock;
  });
  const dispose = smoke.installSignalCleanup(cleanup, {
    signalSource,
    exit: (code) => exits.push(code),
    reportError: (error) => {
      throw error;
    },
  });

  const finalizing = smoke.cleanupAndDispose(cleanup, dispose);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 1);
  assert.equal(signalSource.listenerCount("SIGINT"), 1);
  assert.equal(signalSource.listenerCount("SIGTERM"), 1);

  const firstSignal = signalSource.listeners("SIGINT")[0]();
  const secondSignal = signalSource.listeners("SIGTERM")[0]();
  assert.equal(typeof firstSignal?.then, "function");
  assert.equal(secondSignal, firstSignal);
  assert.deepEqual(exits, []);
  assert.equal(signalSource.listenerCount("SIGINT"), 1);
  assert.equal(signalSource.listenerCount("SIGTERM"), 1);

  releaseCleanup();
  await Promise.all([finalizing, firstSignal, secondSignal]);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(exits, [130]);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
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
