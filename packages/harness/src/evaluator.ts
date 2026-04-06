import type {
  EvaluatorBenchmarkObservation,
  EvaluatorCalibrationReport,
  EvaluatorRubric
} from "./types.js";

export interface EvaluateCalibrationInput {
  rubric: EvaluatorRubric;
  observations: EvaluatorBenchmarkObservation[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function evaluateCalibration(input: EvaluateCalibrationInput): EvaluatorCalibrationReport {
  const total = input.observations.length;
  const matches = input.observations.filter(
    (observation) => observation.expectedVerdict === observation.observedVerdict
  ).length;
  const agreementRaw = total === 0 ? 1 : matches / total;
  const agreementScore = round4(clamp01(agreementRaw));
  const driftScore = round4(clamp01(1 - agreementScore));

  const failingScenarioIds = input.observations
    .filter((observation) => observation.expectedVerdict !== observation.observedVerdict)
    .map((observation) => observation.scenarioId);

  const minimumAgreement = round4(clamp01(input.rubric.minimumAgreement));
  const maximumDrift = round4(clamp01(input.rubric.maximumDrift));
  const driftDetected = agreementScore < minimumAgreement || driftScore > maximumDrift;

  return {
    rubricVersion: input.rubric.rubricVersion,
    benchmarkSetId: input.rubric.benchmarkSetId,
    calibratedAt: input.rubric.calibratedAt,
    agreementScore,
    driftScore,
    minimumAgreement,
    maximumDrift,
    driftDetected,
    failingScenarioIds
  };
}
