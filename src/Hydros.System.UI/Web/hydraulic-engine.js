const gravity = 9.80665;

export function waterProperties(temperatureC) {
  if (!Number.isFinite(temperatureC) || temperatureC < 0 || temperatureC > 100) throw new Error("Temperatura da água deve estar entre 0 e 100 °C.");
  const density = 1000 * (1 - ((temperatureC + 288.9414) / (508929.2 * (temperatureC + 68.12963))) * (temperatureC - 3.9863) ** 2);
  const viscosity = 2.414e-5 * 10 ** (247.8 / (temperatureC + 133.15));
  return { density, viscosity };
}

export function calculatePipeLoss(flowLps, input, temperatureC) {
  if ([input.diameterMm, input.lengthM, input.roughnessMm, input.k].some(value => String(value ?? "").trim() === "")) throw new Error("Diâmetro, comprimento, rugosidade e K precisam ser informados explicitamente; zero só é aceito quando digitado.");
  const diameterM = Number(input.diameterMm) / 1000, lengthM = Number(input.lengthM), roughnessM = Number(input.roughnessMm) / 1000, k = Number(input.k);
  if (![flowLps, diameterM, lengthM, roughnessM, k].every(Number.isFinite) || flowLps < 0 || diameterM <= 0 || lengthM <= 0 || roughnessM < 0 || k < 0) throw new Error("Informe vazão, diâmetro interno, comprimento, rugosidade e K válidos para cada tubo.");
  const { density, viscosity } = waterProperties(temperatureC), flow = flowLps / 1000, area = Math.PI * diameterM ** 2 / 4;
  const velocity = flow / area, reynolds = density * velocity * diameterM / viscosity;
  const a = (2.457 * Math.log(1 / ((7 / Math.max(reynolds, 1)) ** 0.9 + 0.27 * roughnessM / diameterM))) ** 16;
  const b = (37530 / Math.max(reynolds, 1)) ** 16;
  const frictionFactor = reynolds === 0 ? 0 : 8 * ((8 / reynolds) ** 12 + 1 / (a + b) ** 1.5) ** (1 / 12);
  const velocityHead = velocity ** 2 / (2 * gravity), majorLossM = frictionFactor * lengthM / diameterM * velocityHead, minorLossM = k * velocityHead;
  return { flowLps, velocity, reynolds, frictionFactor, majorLossM, minorLossM, totalLossM: majorLossM + minorLossM, density };
}
