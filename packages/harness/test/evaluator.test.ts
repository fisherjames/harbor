import { describe, expect, it } from "vitest";
import { evaluateCalibration, type EvaluatorRubric } from "../src/index.js";

const rubric: EvaluatorRubric = {
  rubricVersion: "rubric-v1",
  benchmarkSetId: "shared-benchmark-v1",
  calibratedAt: "2026-04-06T00:00:00.000Z",
  minimumAgreement: 0.85,
  maximumDrift: 0.15
};

describe("evaluateCalibration", () => {
  it("returns full agreement when observations are empty", () => {
    const report = evaluateCalibration({
      rubric,
      observations: []
    });

    expect(report.agreementScore).toBe(1);
    expect(report.driftScore).toBe(0);
    expect(report.driftDetected).toBe(false);
    expect(report.failingScenarioIds).toEqual([]);
  });

  it("detects drift when agreement is below threshold", () => {
    const report = evaluateCalibration({
      rubric,
      observations: [
        {
          scenarioId: "s1",
          expectedVerdict: "pass",
          observedVerdict: "fail"
        },
        {
          scenarioId: "s2",
          expectedVerdict: "pass",
          observedVerdict: "pass"
        },
        {
          scenarioId: "s3",
          expectedVerdict: "pass",
          observedVerdict: "fail"
        }
      ]
    });

    expect(report.agreementScore).toBe(0.3333);
    expect(report.driftScore).toBe(0.6667);
    expect(report.driftDetected).toBe(true);
    expect(report.failingScenarioIds).toEqual(["s1", "s3"]);
  });

  it("passes calibration when agreement and drift are within thresholds", () => {
    const report = evaluateCalibration({
      rubric,
      observations: [
        {
          scenarioId: "s1",
          expectedVerdict: "pass",
          observedVerdict: "pass"
        },
        {
          scenarioId: "s2",
          expectedVerdict: "fail",
          observedVerdict: "fail"
        },
        {
          scenarioId: "s3",
          expectedVerdict: "pass",
          observedVerdict: "pass"
        },
        {
          scenarioId: "s4",
          expectedVerdict: "fail",
          observedVerdict: "pass"
        },
        {
          scenarioId: "s5",
          expectedVerdict: "pass",
          observedVerdict: "pass"
        },
        {
          scenarioId: "s6",
          expectedVerdict: "pass",
          observedVerdict: "pass"
        },
        {
          scenarioId: "s7",
          expectedVerdict: "fail",
          observedVerdict: "fail"
        }
      ]
    });

    expect(report.agreementScore).toBe(0.8571);
    expect(report.driftScore).toBe(0.1429);
    expect(report.driftDetected).toBe(false);
  });

  it("clamps invalid rubric thresholds before detection", () => {
    const report = evaluateCalibration({
      rubric: {
        ...rubric,
        minimumAgreement: -1,
        maximumDrift: 2
      },
      observations: [
        {
          scenarioId: "s1",
          expectedVerdict: "pass",
          observedVerdict: "fail"
        }
      ]
    });

    expect(report.minimumAgreement).toBe(0);
    expect(report.maximumDrift).toBe(1);
    expect(report.driftDetected).toBe(false);
  });

  it("coerces non-finite rubric thresholds to safe defaults", () => {
    const report = evaluateCalibration({
      rubric: {
        ...rubric,
        minimumAgreement: Number.NaN,
        maximumDrift: Number.NaN
      },
      observations: [
        {
          scenarioId: "s1",
          expectedVerdict: "pass",
          observedVerdict: "pass"
        }
      ]
    });

    expect(report.minimumAgreement).toBe(0);
    expect(report.maximumDrift).toBe(0);
    expect(report.driftDetected).toBe(false);
  });
});
