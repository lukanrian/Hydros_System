export const pumpCurves = [{
  id: "wdm-vpi1",
  model: "VPI1 - EEP 1.5 15 (1,5 cv), sistema com uma bomba",
  manufacturer: "WDM",
  source: "WDM-Catalogo-2023_compressed.pdf · página impressa 19 (página 21 do PDF), tabela VPI1 - EEP 1.5",
  points: [
    [0, 26], [5.3, 25], [6.8, 24], [8.6, 23], [10.4, 22], [11.1, 21], [12.1, 20], [13.9, 19], [14.4, 18], [15.6, 17], [16.3, 16], [17.3, 15], [18, 14], [19, 13], [19.5, 12], [20.6, 11], [21.4, 10], [22.1, 9], [22.8, 8], [23.5, 7], [24.3, 6], [24.8, 5]
  ]
}];

// Specifications transcribed from the manufacturer's 2026 catalog; its curves are plotted, not tabulated.
export const rowaPressurizers = [
  { model: "MAX PRESS 20E", flowM3h: 5, pressureMca: 20, voltage: 220, currentA: 2.5, powerHp: 0.5, weightKg: 8.2, tankL: 1, source: "Catálogo Técnico Rowa 2026, p. 7 (PDF p. 9); dimensions p. 8 (PDF p. 10)" },
  { model: "MAX PRESS 25E", flowM3h: 6, pressureMca: 24.5, voltage: 220, currentA: 4.7, powerHp: 0.7, weightKg: 10.8, tankL: 2, source: "Catálogo Técnico Rowa 2026, p. 7 (PDF p. 9); dimensions p. 8 (PDF p. 10)" },
  { model: "MAX PRESS 30E", flowM3h: 7, pressureMca: 29, voltage: 220, currentA: 5.9, powerHp: 0.85, weightKg: 13.3, tankL: 2, source: "Catálogo Técnico Rowa 2026, p. 7 (PDF p. 9); dimensions p. 8 (PDF p. 10)" },
  { model: "MAX PRESS 30VF", flowM3h: 8, pressureMca: 29, voltage: 220, currentA: 8.6, powerHp: 1, pressureAdjustmentMca: "22–29", weightKg: 15.6, tankL: 2, source: "Catálogo Técnico Rowa 2026, p. 7 (PDF p. 9); dimensions p. 8 (PDF p. 10)" },
  { model: "MAX PRESS 40VF", flowM3h: 9, pressureMca: 36, voltage: 220, currentA: 10, powerHp: 1.5, pressureAdjustmentMca: "26–36", weightKg: 15.6, tankL: 2, source: "Catálogo Técnico Rowa 2026, p. 7 (PDF p. 9); dimensions p. 8 (PDF p. 10)" }
];

export const rowaHighFlow = [
  ["MAX PRESS 30MVF", 13, 29, "220", "14,3", 2.7, "22–29"], ["MAX PRESS 200E TRIF", 18, 20, "3 x 220", "6,7", 2.5], ["MAX PRESS 270E TRIF", 20, 27, "3 x 220", "7,8", 2.5],
  ["PRESS 350E TRIF", 26, 32, "3 x 220 / 380", "11,0 / 7,5", 3.5], ["PRESS 410E TRIF", 27, 36, "3 x 220 / 380", "13,0 / 7,5", 4], ["MAX PRESS 270VF MONO", 18.5, 26, "220", "10,0", 2.5, "14–26"],
  ["MAX PRESS 360VF MONO", 17, 35, "220", "13,5", 3, "26–35"], ["ROWA PRESS 410VF TRIF", 25, 35, "3 x 220 / 380", "16,6 / 9,6", 4, "25–35"], ["ROWA PRESS 510VF TRIF", 23.5, 45, "3 x 220 / 380", "12,3 / 7,1", 4.2, "25–45"]
].map(([model, flowM3h, pressureMca, voltage, currentA, powerHp, pressureAdjustmentMca]) => ({ model, flowM3h, pressureMca, voltage, currentA, powerHp, pressureAdjustmentMca, source: "Catálogo Técnico Rowa 2026, pp. 10–11 (PDF pp. 12–13)" }));

export const rowaMaxflow = [
  ["MAXFLOW 20E", 5, 20, "220", 2.5, 0.5, 35], ["MAXFLOW 25E", 6, 24.5, "220", 4.7, 0.7, 35], ["MAXFLOW 30VF", 8, 29, "220", 8.6, 1, 60], ["MAXFLOW 270E", 20, 27, "3 x 220", 7.8, 2.5, 60]
].map(([model, flowM3h, pressureMca, voltage, currentA, powerHp, tankL]) => ({ model, flowM3h, pressureMca, voltage, currentA, powerHp, tankL, source: "Catálogo Técnico Rowa 2026, p. 14 (PDF p. 16)" }));

export const rowaHotCirculators = [
  ["RW S50 Controller TT · velocidade 1", 2.7, 5, 75], ["RW S50 Controller TT · velocidade 2", 3, 6, 100],
  ["RW S150 Controller TT · velocidade 1", 2.202, 13, 55], ["RW S150 Controller TT · velocidade 2", 2.802, 15, 78], ["RW S150 Controller TT · velocidade 3", 3.3, 16, 95]
].map(([model, flowM3h, pressureMca, powerW]) => ({ model, flowM3h, pressureMca, powerW, powerUnit: "W", voltage: "220", temperatureMaxC: 95, source: "Catálogo Técnico Rowa 2026, pp. 41–42 (PDF pp. 43–44)" }));

export function evaluatePump(curve, flowM3h, requiredHeadM) {
  if (!curve?.points || curve.points.length < 2 || !Number.isFinite(flowM3h) || !Number.isFinite(requiredHeadM) || requiredHeadM < 0) return { error: "Ponto de operação ou curva inválidos." };
  const points = curve.points;
  if (flowM3h < points[0][0] || flowM3h > points.at(-1)[0]) return { error: "A vazão requerida está fora da faixa publicada; sem extrapolação.", outOfRange: true };
  const upper = points.findIndex(point => point[0] >= flowM3h);
  const a = points[Math.max(0, upper - 1)], b = points[upper];
  const headM = a[0] === b[0] ? a[1] : a[1] + (b[1] - a[1]) * (flowM3h - a[0]) / (b[0] - a[0]);
  return { flowM3h, requiredHeadM, curveHeadM: headM, fitsHead: headM >= requiredHeadM, method: "Interpolação linear entre pontos tabulados; sem extrapolação." };
}
