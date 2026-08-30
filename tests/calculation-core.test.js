const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateCharge,
  estimateCapacity,
} = require("../calculation-core.js");

test("core loads without browser globals or a DOM", () => {
  assert.equal(globalThis.EVChargeCore, undefined);
  assert.equal(typeof document, "undefined");
  assert.equal(typeof calculateCharge, "function");
  assert.equal(typeof estimateCapacity, "function");
});

test("amount mode converts wall energy into battery energy and final charge", () => {
  assert.deepEqual(
    calculateCharge({
      mode: "amount",
      capacityKwh: 75,
      efficiencyPercent: 90,
      currentPercent: 20,
      amountKwh: 40,
      speedKw: 8,
      costPerKwh: 2.5,
    }),
    {
      ok: true,
      error: "",
      risk: "",
      finalPercent: 68,
      batteryKwh: 36,
      wallKwh: 40,
      durationHours: 5,
      cost: 100,
    },
  );
});

test("target mode converts the requested percentage into required wall energy", () => {
  assert.deepEqual(
    calculateCharge({
      mode: "target",
      capacityKwh: 60,
      efficiencyPercent: 80,
      currentPercent: 25,
      targetPercent: 75,
      speedKw: 10,
      costPerKwh: 3,
    }),
    {
      ok: true,
      error: "",
      risk: "",
      finalPercent: 75,
      batteryKwh: 30,
      wallKwh: 37.5,
      durationHours: 3.75,
      cost: 112.5,
    },
  );
});

test("shared input validation returns the existing calculator errors", () => {
  const valid = {
    mode: "amount",
    capacityKwh: 75,
    efficiencyPercent: 90,
    currentPercent: 20,
    amountKwh: 40,
    speedKw: 8,
    costPerKwh: 2.5,
  };
  const cases = [
    [{ capacityKwh: 0 }, "請輸入有效電池容量。"],
    [{ capacityKwh: "invalid" }, "請輸入有效電池容量。"],
    [{ capacityKwh: Number.POSITIVE_INFINITY }, "請輸入有效電池容量。"],
    [{ efficiencyPercent: 0 }, "充電效率需介乎 1% 至 100%。"],
    [{ efficiencyPercent: 101 }, "充電效率需介乎 1% 至 100%。"],
    [{ currentPercent: -1 }, "目前電量需介乎 0% 至 100%。"],
    [{ currentPercent: 101 }, "目前電量需介乎 0% 至 100%。"],
    [{ speedKw: 0 }, "充電速度需大於 0 kW。"],
    [{ speedKw: Number.POSITIVE_INFINITY }, "充電速度需大於 0 kW。"],
    [{ costPerKwh: -1 }, "電費單價不可少於 0。"],
    [{ amountKwh: -1 }, "請輸入有效數值。"],
    [{ amountKwh: "invalid" }, "請輸入有效數值。"],
  ];

  for (const [overrides, error] of cases) {
    const result = calculateCharge({ ...valid, ...overrides });
    assert.deepEqual(
      { ok: result.ok, error: result.error },
      { ok: false, error },
    );
  }
});

test("missing core inputs return validation results instead of throwing", () => {
  const charge = calculateCharge();
  const capacity = estimateCapacity();

  assert.deepEqual(
    { ok: charge.ok, error: charge.error },
    { ok: false, error: "請輸入有效電池容量。" },
  );
  assert.deepEqual(
    { ok: capacity.ok, error: capacity.error },
    { ok: false, error: "請輸入有效充電紀錄。" },
  );
});

test("mode-specific validation rejects impossible charge requests", () => {
  const common = {
    capacityKwh: 75,
    efficiencyPercent: 100,
    currentPercent: 20,
    speedKw: 8,
    costPerKwh: 2.5,
  };
  const cases = [
    [
      { ...common, mode: "amount", currentPercent: 90, amountKwh: 8 },
      "預計最終電量超過 100%。",
    ],
    [
      { ...common, mode: "target", targetPercent: 101 },
      "目標電量需介乎 0% 至 100%。",
    ],
    [
      { ...common, mode: "target", targetPercent: 10 },
      "目標電量低於目前電量。",
    ],
    [
      { ...common, mode: "target", targetPercent: -1 },
      "請輸入有效數值。",
    ],
    [
      { ...common, mode: "unknown", amountKwh: 10 },
      "請選擇有效計算模式。",
    ],
  ];

  for (const [input, error] of cases) {
    const result = calculateCharge(input);
    assert.deepEqual(
      { ok: result.ok, error: result.error },
      { ok: false, error },
    );
  }
});

test("charge risk messages match the existing 90% and 95% thresholds", () => {
  const common = {
    mode: "amount",
    capacityKwh: 100,
    efficiencyPercent: 100,
    currentPercent: 50,
    speedKw: 10,
    costPerKwh: 1,
  };

  assert.equal(
    calculateCharge({ ...common, amountKwh: 40 }).risk,
    "高電量區間充電較慢",
  );
  assert.equal(
    calculateCharge({ ...common, amountKwh: 45 }).risk,
    "接近滿電，尾段會較慢",
  );
});

test("capacity estimation converts a charging record into usable capacity", () => {
  assert.deepEqual(
    estimateCapacity({
      startPercent: 20,
      endPercent: 80,
      wallKwh: 52,
      efficiencyPercent: 90,
      referenceCapacityKwh: 78.1,
    }),
    {
      ok: true,
      error: "",
      capacityKwh: 78.00000000000001,
      ratioPercent: 99.87195902688863,
      deltaPercent: 60,
      confidence: "可信度較高：較適合作容量估算。",
    },
  );
});

test("capacity estimation stays usable without a valid reference capacity", () => {
  for (const referenceCapacityKwh of ["", 0, "invalid"]) {
    assert.deepEqual(
      estimateCapacity({
        startPercent: 20,
        endPercent: 80,
        wallKwh: 52,
        efficiencyPercent: 90,
        referenceCapacityKwh,
      }),
      {
        ok: true,
        error: "",
        capacityKwh: 78.00000000000001,
        ratioPercent: Number.NaN,
        deltaPercent: 60,
        confidence: "可信度較高：較適合作容量估算。",
      },
    );
  }
});

test("capacity confidence follows the existing SOC-span guidance", () => {
  const common = {
    wallKwh: 10,
    efficiencyPercent: 100,
    referenceCapacityKwh: 75,
  };

  assert.equal(
    estimateCapacity({ ...common, startPercent: 20, endPercent: 35 })
      .confidence,
    "可信度偏低：SOC 差距太細。",
  );
  assert.equal(
    estimateCapacity({ ...common, startPercent: 20, endPercent: 50 })
      .confidence,
    "可信度中等：可作粗略估算。",
  );
  assert.equal(
    estimateCapacity({
      ...common,
      startPercent: 5,
      endPercent: 95,
    }).confidence,
    "可信度較高：較適合作容量估算。 接近低 / 高電量區間可能有誤差。",
  );
});

test("capacity estimation rejects invalid charging records", () => {
  const valid = {
    startPercent: 20,
    endPercent: 80,
    wallKwh: 52,
    efficiencyPercent: 90,
    referenceCapacityKwh: 78.1,
  };
  const invalidCases = [
    { endPercent: 20 },
    { startPercent: -1 },
    { endPercent: 101 },
    { wallKwh: 0 },
    { efficiencyPercent: 0 },
    { efficiencyPercent: 101 },
    { wallKwh: "invalid" },
  ];

  for (const overrides of invalidCases) {
    const result = estimateCapacity({ ...valid, ...overrides });
    assert.deepEqual(
      { ok: result.ok, error: result.error },
      { ok: false, error: "請輸入有效充電紀錄。" },
    );
  }
});

test("0% and 100% are valid target boundaries", () => {
  assert.deepEqual(
    calculateCharge({
      mode: "target",
      capacityKwh: 60,
      efficiencyPercent: 85,
      currentPercent: 0,
      targetPercent: 0,
      speedKw: 7,
      costPerKwh: 0,
    }),
    {
      ok: true,
      error: "",
      risk: "",
      finalPercent: 0,
      batteryKwh: 0,
      wallKwh: 0,
      durationHours: 0,
      cost: 0,
    },
  );
  assert.deepEqual(
    calculateCharge({
      mode: "target",
      capacityKwh: 60,
      efficiencyPercent: 75,
      currentPercent: 0,
      targetPercent: 100,
      speedKw: 10,
      costPerKwh: 0,
    }),
    {
      ok: true,
      error: "",
      risk: "接近滿電，尾段會較慢",
      finalPercent: 100,
      batteryKwh: 60,
      wallKwh: 80,
      durationHours: 8,
      cost: 0,
    },
  );
});

test("representative results exactly match the pre-extraction calculator", () => {
  assert.deepEqual(
    calculateCharge({
      mode: "amount",
      capacityKwh: 78.1,
      efficiencyPercent: 100,
      currentPercent: 28,
      amountKwh: 50,
      speedKw: 11,
      costPerKwh: 1.7,
    }),
    {
      ok: true,
      error: "",
      risk: "高電量區間充電較慢",
      finalPercent: 92.02048655569783,
      batteryKwh: 50,
      wallKwh: 50,
      durationHours: 4.545454545454546,
      cost: 85,
    },
  );
  assert.deepEqual(
    calculateCharge({
      mode: "target",
      capacityKwh: 78.1,
      efficiencyPercent: 90,
      currentPercent: 28,
      targetPercent: 80,
      speedKw: 11,
      costPerKwh: 1.7,
    }),
    {
      ok: true,
      error: "",
      risk: "",
      finalPercent: 80,
      batteryKwh: 40.611999999999995,
      wallKwh: 45.124444444444435,
      durationHours: 4.102222222222221,
      cost: 76.71155555555553,
    },
  );
});
