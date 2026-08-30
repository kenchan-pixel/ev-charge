const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createServer } = require("node:http");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, extname, join, resolve, sep } = require("node:path");

const projectRoot = resolve(__dirname, "..");
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);

  const chrome = candidates.find((candidate) => existsSync(candidate));
  if (!chrome) {
    throw new Error(
      "Chrome was not found. Set CHROME_PATH to a Chrome-compatible browser.",
    );
  }
  return chrome;
}

function startStaticServer() {
  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      const pathname =
        requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      const filePath = resolve(projectRoot, `.${decodeURIComponent(pathname)}`);

      if (
        filePath !== projectRoot &&
        !filePath.startsWith(`${projectRoot}${sep}`)
      ) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }

      response.writeHead(200, {
        "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(readFileSync(filePath));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });

  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function waitFor(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`,
  );
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const events = [];
  let sequence = 0;

  const opened = new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("CDP WebSocket open failed")),
      { once: true },
    );
  });

  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    events.push(message);
  });

  return {
    events,
    opened,
    close: () => {
      try {
        socket.close();
      } catch {}
    },
    send: (method, params = {}) =>
      new Promise((resolveSend, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve: resolveSend, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
  };
}

async function closeBrowserFromPortFile(portFile) {
  if (!existsSync(portFile)) return;

  const [portLine, browserPath] = readFileSync(portFile, "utf8").split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isFinite(port) || !browserPath) return;

  const browserCdp = connectCdp(`ws://127.0.0.1:${port}${browserPath}`);
  try {
    await Promise.race([
      (async () => {
        await browserCdp.opened;
        await browserCdp.send("Browser.close");
      })(),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
  } catch {
    // stopChrome remains the fallback when the launcher process is still alive.
  } finally {
    browserCdp.close();
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Browser evaluation failed");
  }
  return response.result.value;
}

async function stopChrome(chrome) {
  if (!chrome || chrome.exitCode !== null) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(chrome.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    chrome.kill("SIGKILL");
  }

  if (chrome.exitCode === null) {
    await Promise.race([
      new Promise((resolveExit) => chrome.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
}

async function removeOwnedProfile(profilePath) {
  const tempRoot = resolve(
    process.env.EV_CHARGE_BROWSER_TEMP_ROOT ||
      process.env.RUNNER_TEMP ||
      tmpdir(),
  );
  const ownedPath = resolve(profilePath);

  if (
    !ownedPath.startsWith(`${tempRoot}${sep}`) ||
    !basename(ownedPath).startsWith("ev-charge-browser-smoke-")
  ) {
    throw new Error(`Refusing to remove unexpected browser profile: ${ownedPath}`);
  }
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      rmSync(ownedPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        attempt === 10 ||
        (error.code !== "EPERM" && error.code !== "EBUSY")
      ) {
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 100));
    }
  }
}

async function main() {
  const chromePath = findChrome();
  const profileRoot = resolve(
    process.env.EV_CHARGE_BROWSER_TEMP_ROOT ||
      process.env.RUNNER_TEMP ||
      tmpdir(),
  );
  const profilePath = mkdtempSync(join(profileRoot, "ev-charge-browser-smoke-"));
  const portFile = join(profilePath, "DevToolsActivePort");
  const screenshotPath = process.env.BROWSER_SMOKE_SCREENSHOT;
  const { server, url } = await startStaticServer();
  let chrome;
  let cdp;
  let chromeErrors = "";

  try {
    chrome = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-crash-reporter",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-default-browser-check",
        "--no-first-run",
        "--hide-scrollbars",
        "--window-size=1280,900",
        "--remote-debugging-port=0",
        `--user-data-dir=${profilePath}`,
        url,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    chrome.stderr.on("data", (chunk) => {
      chromeErrors = `${chromeErrors}${chunk}`.slice(-20_000);
    });

    const port = await waitFor(() => {
      if (!existsSync(portFile)) return null;
      return Number(readFileSync(portFile, "utf8").split(/\r?\n/, 1)[0]);
    }, "Chrome DevTools port");
    const targets = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return null;
      const pages = await response.json();
      return pages.find(
        (page) => page.type === "page" && page.url.startsWith(url),
      );
    }, "calculator browser target");

    cdp = connectCdp(targets.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(
      async () =>
        evaluate(
          cdp,
          "document.readyState === 'complete' && Boolean(window.EVChargeCore)",
        ),
      "calculator initialization",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));

    const amount = await evaluate(
      cdp,
      `(() => ({
        title: document.title,
        finalPercent: document.getElementById('finalPct').textContent.trim(),
        wallKwh: document.getElementById('wallKwhHero').textContent.trim(),
        batteryKwh: document.getElementById('batteryKwh').textContent.trim(),
        duration: document.getElementById('duration').textContent.trim(),
        cost: document.getElementById('totalCost').textContent.trim(),
        error: document.getElementById('error').textContent.trim(),
        corePath: document.querySelector('script[src="calculation-core.js"]')?.getAttribute('src'),
        manifestPath: document.querySelector('link[rel="manifest"]')?.getAttribute('href')
      }))()`,
    );
    assert.deepEqual(amount, {
      title: "EV 充電計算器 v22",
      finalPercent: "92.0",
      wallKwh: "50.0",
      batteryKwh: "50.00",
      duration: "4小時33分",
      cost: "85.00",
      error: "",
      corePath: "calculation-core.js",
      manifestPath: "manifest.webmanifest",
    });

    const target = await evaluate(
      cdp,
      `(async () => {
        const setInput = (id, value) => {
          const element = document.getElementById(id);
          element.value = String(value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
        };
        document.getElementById('modeTarget').click();
        setInput('currentNumber', 28);
        setInput('efficiency', 90);
        setInput('speedNumber', 11);
        setInput('costNumber', 1.7);
        setInput('mainNumber', 80);
        await new Promise((resolveWait) => setTimeout(resolveWait, 700));
        const saved = JSON.parse(localStorage.getItem('ev-calculator-v22') || '{}');
        return {
          mode: document.getElementById('modeTarget').checked ? 'target' : 'amount',
          finalPercent: document.getElementById('finalPct').textContent.trim(),
          wallKwh: document.getElementById('wallKwhHero').textContent.trim(),
          batteryKwh: document.getElementById('batteryKwh').textContent.trim(),
          duration: document.getElementById('duration').textContent.trim(),
          cost: document.getElementById('totalCost').textContent.trim(),
          error: document.getElementById('error').textContent.trim(),
          storedMode: saved.mode,
          storageKeys: Object.keys(saved).sort()
        };
      })()`,
    );
    assert.deepEqual(target, {
      mode: "target",
      finalPercent: "80.0",
      wallKwh: "45.1",
      batteryKwh: "40.61",
      duration: "4小時06分",
      cost: "76.71",
      error: "",
      storedMode: "target",
      storageKeys: [
        "amount",
        "capacity",
        "cost",
        "current",
        "detailed",
        "efficiency",
        "mode",
        "model",
        "recent",
        "speed",
        "target",
      ],
    });

    const invalid = await evaluate(
      cdp,
      `(async () => {
        const input = document.getElementById('mainNumber');
        input.value = '101';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        return {
          error: document.getElementById('error').textContent.trim(),
          finalPercent: document.getElementById('finalPct').textContent.trim(),
          wallKwh: document.getElementById('wallKwhHero').textContent.trim()
        };
      })()`,
    );
    assert.deepEqual(invalid, {
      error: "目標電量需介乎 0% 至 100%。",
      finalPercent: "—",
      wallKwh: "—",
    });

    const capacity = await evaluate(
      cdp,
      `(() => {
        const setInput = (id, value) => {
          const element = document.getElementById(id);
          element.value = String(value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
        };
        document.getElementById('openCalib').click();
        setInput('calibStart', 20);
        setInput('calibEnd', 80);
        setInput('calibKwh', 52);
        setInput('calibEff', 90);
        return {
          capacityKwh: document.getElementById('calibCapacity').textContent.trim(),
          ratioPercent: document.getElementById('calibRatio').textContent.trim(),
          deltaPercent: document.getElementById('calibDelta').textContent.trim(),
          confidence: document.getElementById('calibConfidence').textContent.trim(),
          applyDisabled: document.getElementById('applyCalibCapacity').disabled
        };
      })()`,
    );
    assert.deepEqual(capacity, {
      capacityKwh: "78.0",
      ratioPercent: "99.9",
      deltaPercent: "60.0",
      confidence: "可信度較高：較適合作容量估算。",
      applyDisabled: false,
    });

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const mobile = await evaluate(
      cdp,
      `(() => ({
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        resultVisible: Boolean(document.getElementById('finalPct').offsetParent)
      }))()`,
    );
    assert.equal(mobile.viewportWidth, 390);
    assert.ok(mobile.documentWidth <= 390);
    assert.equal(mobile.resultVisible, true);

    if (screenshotPath) {
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    }

    const exceptions = cdp.events.filter(
      ({ method }) => method === "Runtime.exceptionThrown",
    );
    assert.deepEqual(exceptions, []);

    console.log(
      JSON.stringify(
        {
          ok: true,
          browser: chromePath,
          amount,
          target,
          invalid,
          capacity,
          mobile,
          screenshotPath: screenshotPath || null,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (chromeErrors) process.stderr.write(chromeErrors);
    throw error;
  } finally {
    if (cdp) cdp.close();
    await closeBrowserFromPortFile(portFile);
    await stopChrome(chrome);
    await new Promise((resolveClose) => server.close(resolveClose));
    await removeOwnedProfile(profilePath);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
