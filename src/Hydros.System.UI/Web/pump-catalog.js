export const pumpCurves = [{
  model: "VPI1 - EEP 1.5 15 (1,5 cv), sistema com uma bomba",
  manufacturer: "WDM",
  source: "WDM-Catalogo-2023_compressed.pdf · página impressa 19 (página 21 do PDF), tabela VPI1 - EEP 1.5",
  points: [
    [0, 26], [5.3, 25], [6.8, 24], [8.6, 23], [10.4, 22], [11.1, 21], [12.1, 20], [13.9, 19], [14.4, 18], [15.6, 17], [16.3, 16], [17.3, 15], [18, 14], [19, 13], [19.5, 12], [20.6, 11], [21.4, 10], [22.1, 9], [22.8, 8], [23.5, 7], [24.3, 6], [24.8, 5]
  ]
}];

export function evaluatePump(curve, flowM3h, requiredHeadM) {
  if (!curve?.points || curve.points.length < 2 || !Number.isFinite(flowM3h) || !Number.isFinite(requiredHeadM) || requiredHeadM < 0) return { error: "Ponto de operação ou curva inválidos." };
  const points = curve.points;
  if (flowM3h < points[0][0] || flowM3h > points.at(-1)[0]) return { error: "A vazão requerida está fora da faixa publicada; sem extrapolação." };
  const upper = points.findIndex(point => point[0] >= flowM3h);
  const a = points[Math.max(0, upper - 1)], b = points[upper];
  const headM = a[0] === b[0] ? a[1] : a[1] + (b[1] - a[1]) * (flowM3h - a[0]) / (b[0] - a[0]);
  return { flowM3h, requiredHeadM, curveHeadM: headM, fitsHead: headM >= requiredHeadM, method: "Interpolação linear entre pontos tabulados; sem extrapolação." };
}
