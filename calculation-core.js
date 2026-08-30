(function exposeCore(root, factory) {
  const core = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = core;
  } else if (root) {
    root.EVChargeCore = core;
  }
})(typeof globalThis === "object" ? globalThis : this, function createCore() {
  "use strict";

  function invalidCharge(error) {
    return {
      ok: false,
      error,
      risk: "",
      finalPercent: Number.NaN,
      batteryKwh: Number.NaN,
      wallKwh: Number.NaN,
      durationHours: Number.NaN,
      cost: Number.NaN,
    };
  }

  function calculateCharge(input = {}) {
    const capacityKwh = Number(input.capacityKwh);
    const efficiency = Number(input.efficiencyPercent) / 100;
    const currentPercent = Number(input.currentPercent);
    const speedKw = Number(input.speedKw);
    const costPerKwh = Number(input.costPerKwh);
    const mainValue = Number(
      input.mode === "target" ? input.targetPercent : input.amountKwh,
    );
    let error = "";
    let finalPercent;
    let batteryKwh;
    let wallKwh;

    if (!Number.isFinite(capacityKwh) || capacityKwh <= 0) {
      error = "請輸入有效電池容量。";
    } else if (
      !Number.isFinite(efficiency) ||
      efficiency <= 0 ||
      efficiency > 1
    ) {
      error = "充電效率需介乎 1% 至 100%。";
    } else if (
      currentPercent < 0 ||
      currentPercent > 100 ||
      !Number.isFinite(currentPercent)
    ) {
      error = "目前電量需介乎 0% 至 100%。";
    } else if (!Number.isFinite(speedKw) || speedKw <= 0) {
      error = "充電速度需大於 0 kW。";
    } else if (costPerKwh < 0 || !Number.isFinite(costPerKwh)) {
      error = "電費單價不可少於 0。";
    } else if (mainValue < 0 || !Number.isFinite(mainValue)) {
      error = "請輸入有效數值。";
    }

    if (error) return invalidCharge(error);
    if (input.mode !== "amount" && input.mode !== "target") {
      return invalidCharge("請選擇有效計算模式。");
    }

    if (input.mode === "target") {
      if (mainValue > 100) {
        return invalidCharge("目標電量需介乎 0% 至 100%。");
      }
      if (mainValue < currentPercent) {
        return invalidCharge("目標電量低於目前電量。");
      }
      finalPercent = mainValue;
      batteryKwh = (capacityKwh * (finalPercent - currentPercent)) / 100;
      wallKwh = batteryKwh / efficiency;
    } else {
      wallKwh = mainValue;
      batteryKwh = wallKwh * efficiency;
      finalPercent = currentPercent + (batteryKwh / capacityKwh) * 100;
      if (finalPercent > 100) {
        return invalidCharge("預計最終電量超過 100%。");
      }
    }

    let risk = "";
    if (finalPercent >= 95) {
      risk = "接近滿電，尾段會較慢";
    } else if (finalPercent >= 90) {
      risk = "高電量區間充電較慢";
    }

    return {
      ok: true,
      error: "",
      risk,
      finalPercent,
      batteryKwh,
      wallKwh,
      durationHours: wallKwh / speedKw,
      cost: wallKwh * costPerKwh,
    };
  }

  function estimateCapacity(input = {}) {
    const startPercent = Number(input.startPercent);
    const endPercent = Number(input.endPercent);
    const wallKwh = Number(input.wallKwh);
    const efficiency = Number(input.efficiencyPercent) / 100;
    const referenceCapacityKwh = Number(input.referenceCapacityKwh);
    const deltaPercent = endPercent - startPercent;
    const valid =
      Number.isFinite(startPercent) &&
      Number.isFinite(endPercent) &&
      Number.isFinite(wallKwh) &&
      Number.isFinite(efficiency) &&
      Number.isFinite(referenceCapacityKwh) &&
      deltaPercent > 0 &&
      startPercent >= 0 &&
      endPercent <= 100 &&
      wallKwh > 0 &&
      efficiency > 0 &&
      efficiency <= 1 &&
      referenceCapacityKwh > 0;

    if (!valid) {
      return {
        ok: false,
        error: "請輸入有效充電紀錄。",
        capacityKwh: Number.NaN,
        ratioPercent: Number.NaN,
        deltaPercent: Number.NaN,
        confidence: "",
      };
    }

    const capacityKwh = (wallKwh * efficiency) / (deltaPercent / 100);
    let confidence = "";

    if (deltaPercent < 20) {
      confidence = "可信度偏低：SOC 差距太細。";
    } else if (deltaPercent < 50) {
      confidence = "可信度中等：可作粗略估算。";
    } else {
      confidence = "可信度較高：較適合作容量估算。";
    }
    if (startPercent < 10 || endPercent > 90) {
      confidence += " 接近低 / 高電量區間可能有誤差。";
    }

    return {
      ok: true,
      error: "",
      capacityKwh,
      ratioPercent: (capacityKwh / referenceCapacityKwh) * 100,
      deltaPercent,
      confidence,
    };
  }

  return Object.freeze({ calculateCharge, estimateCapacity });
});
