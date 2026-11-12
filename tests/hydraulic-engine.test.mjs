import assert from "node:assert/strict";
import test from "node:test";
import { calculatePipeLoss, waterProperties } from "../src/Hydros.System.UI/Web/hydraulic-engine.js";
import { evaluatePump, pumpCurves } from "../src/Hydros.System.UI/Web/pump-catalog.js";

const close = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected} (±${tolerance})`);

test("propriedades da água seguem os valores tabelados", () => {
  close(waterProperties(4).density, 1000, 0.01);
  close(waterProperties(20).density, 998.2, 0.1);
  close(waterProperties(20).viscosity, 1.002e-3, 2e-6);
  close(waterProperties(60).density, 983.2, 0.1);
  assert.throws(() => waterProperties(120));
  assert.throws(() => waterProperties(Number.NaN));
});

test("fator de atrito turbulento concorda com Colebrook", () => {
  const input = { diameterMm: 21.6, lengthM: 10, roughnessMm: 0.0015, k: 2 };
  const loss = calculatePipeLoss(0.5, input, 20);
  const relative = 0.0015 / 21.6;
  let colebrook = 0.02;
  for (let i = 0; i < 50; i++) colebrook = 1 / (-2 * Math.log10(relative / 3.7 + 2.51 / (loss.reynolds * Math.sqrt(colebrook)))) ** 2;
  close(loss.frictionFactor, colebrook, colebrook * 0.01);
  const velocityHead = loss.velocity ** 2 / (2 * 9.80665);
  close(loss.majorLossM, loss.frictionFactor * 10 / 0.0216 * velocityHead, 1e-12);
  close(loss.minorLossM, 2 * velocityHead, 1e-12);
  close(loss.totalLossM, loss.majorLossM + loss.minorLossM, 1e-12);
});

test("regime laminar devolve 64/Re e vazão nula não gera perda", () => {
  const input = { diameterMm: 21.6, lengthM: 10, roughnessMm: 0, k: 0 };
  const laminar = calculatePipeLoss(0.01, input, 20);
  assert.ok(laminar.reynolds < 2000);
  close(laminar.frictionFactor, 64 / laminar.reynolds, 1e-9);
  assert.equal(calculatePipeLoss(0, input, 20).totalLossM, 0);
});

test("dados ausentes bloqueiam o cálculo; zero só vale quando informado", () => {
  assert.throws(() => calculatePipeLoss(0.5, { diameterMm: 21.6, lengthM: 10, roughnessMm: "", k: 0 }, 20));
  assert.throws(() => calculatePipeLoss(0.5, { diameterMm: 21.6, lengthM: 10, roughnessMm: 0.0015 }, 20));
  assert.throws(() => calculatePipeLoss(0.5, { diameterMm: 0, lengthM: 10, roughnessMm: 0.0015, k: 0 }, 20));
  assert.doesNotThrow(() => calculatePipeLoss(0.5, { diameterMm: "21.6", lengthM: "10", roughnessMm: "0", k: "0" }, 20));
});

test("curva de bomba interpola dentro da faixa e recusa extrapolar", () => {
  const curve = pumpCurves[0], points = curve.points;
  assert.ok(points.every((point, i) => !i || (point[0] > points[i - 1][0] && point[1] < points[i - 1][1])), "curva deve ser monotônica");
  const inside = evaluatePump(curve, 6, 20);
  close(inside.curveHeadM, 25 + (24 - 25) * (6 - 5.3) / (6.8 - 5.3), 1e-9);
  assert.equal(inside.fitsHead, true);
  assert.equal(evaluatePump(curve, 6, 26).fitsHead, false);
  assert.equal(evaluatePump(curve, points[0][0], 1).curveHeadM, points[0][1]);
  assert.equal(evaluatePump(curve, 30, 5).outOfRange, true);
  assert.ok(evaluatePump({ points: [[0, 1]] }, 0, 1).error);
});
