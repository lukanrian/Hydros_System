import assert from "node:assert/strict";
import test from "node:test";
import { calculateHotWaterReturn } from "../src/Hydros.System.UI/Web/hot-water-return.js";

const hot = "Água quente", returned = "Água quente retorno";
const pipe = (id, systemLabel, lengthM) => ({ kind: "pipe", type: "IfcPipeSegment", expressId: id, systemLabel,
  endpoints: [[0, 0, 0], [lengthM, 0, 0]] });
const end = (id, edge) => ({ expressId: id, end: edge, type: "IfcPipeSegment" });
const part = (id, type = "IfcPipeFitting") => ({ expressId: id, type });
const link = (key, from, fromEnd, to, toEnd = null) => ({ key, from: end(from, fromEnd), to: typeof to === "number" ? end(to, toEnd) : to });
const network = () => {
  const records = [pipe(1, hot, 5), pipe(2, hot, 5), pipe(3, hot, 10), pipe(4, returned, 5), pipe(5, returned, 10), pipe(6, returned, 5)];
  const candidates = [
    link("boiler-supply", 1, 0, part(90, "IfcBoiler")), link("supply-tee-a", 1, 1, part(100)),
    link("branch-a-start", 2, 0, part(100)), link("branch-a-junction", 2, 1, part(101)),
    link("branch-b-start", 3, 0, part(100)), link("branch-b-junction", 3, 1, part(102)),
    link("return-a-start", 4, 0, part(101)), link("return-a-merge", 4, 1, part(103)),
    link("return-b-start", 5, 0, part(102)), link("return-b-merge", 5, 1, part(103)),
    link("return-boiler", 6, 0, part(103)), link("return-boiler-end", 6, 1, part(90, "IfcBoiler"))
  ];
  return { records, candidates, decisions: Object.fromEntries(candidates.map(item => [item.key, "Confirmada"])) };
};
const input = lengthM => ({ diameterMm: 21.6, lengthM, roughnessMm: 0.0015, k: 0, source: "ficha técnica", thermalLossWm: "10", thermalSource: "cálculo térmico do projeto" });
const args = (overrides = {}) => {
  const base = network();
  return { ...base, boundary: { expressId: 90, type: "IfcBoiler" }, deltaTC: "10", temperatureC: "60",
    pipeInputs: new Map(base.records.map(item => [item.expressId, input(item.endpoints[1][0])])), ...overrides };
};

test("deriva alças nos encontros de ida/retorno, rateia perda comum e dimensiona vazões e balanceamento", () => {
  const result = calculateHotWaterReturn(args());
  assert.equal(result.error, undefined);
  assert.equal(result.branches.length, 2);
  assert.deepEqual(result.branches.map(item => item.junctionExpressId), [101, 102]);
  assert.deepEqual(result.sharedPipeIds.sort((a, b) => a - b), [1, 6]);
  assert.equal(result.totalHeatLossW, 400);
  assert.equal(result.branches[0].heatLossW, 400 / 3);
  assert.equal(result.branches[1].heatLossW, 800 / 3);
  assert.ok(result.branches[1].flowLps > result.branches[0].flowLps);
  assert.equal(result.totalFlowLps, result.branches.reduce((sum, branch) => sum + branch.flowLps, 0));
  assert.ok(result.branches.some(item => item.additionalBalancingHeadM > 0));
  assert.equal(result.requiredHeadM, Math.max(...result.branches.map(item => item.loopHeadM)));
});

test("exige retorno explicitamente identificado no IFC e origem em equipamento", () => {
  const base = network();
  const records = base.records.map(item => ({ ...item, systemLabel: hot }));
  assert.match(calculateHotWaterReturn(args({ records })).error, /IFC.*retorno|retorno.*IFC/i);
  assert.match(calculateHotWaterReturn(args({ boundary: { expressId: 1, type: "IfcPipeSegment", end: 0 } })).error, /origem.*aquecedor|aquecedor.*origem/i);
});

test("exige ΔT positivo e perda térmica com fonte em cada tubo de circulação", () => {
  assert.match(calculateHotWaterReturn(args({ deltaTC: "0" })).error, /ΔT/i);
  const badInputs = args();
  badInputs.pipeInputs.get(3).thermalSource = " ";
  assert.match(calculateHotWaterReturn(badInputs).error, /fonte.*térmica/i);
});

test("bloqueia conexão pendente e rede de retorno sem ligação até o aquecedor", () => {
  const pending = args();
  pending.decisions["return-a-start"] = "Pendente";
  assert.match(calculateHotWaterReturn(pending).error, /retorno.*alça|alça.*retorno/i);

  const noReturnToBoiler = args();
  noReturnToBoiler.decisions["return-boiler-end"] = "Rejeitada";
  assert.match(calculateHotWaterReturn(noReturnToBoiler).error, /árvore contínua.*retorno|retorno.*aquecedor/i);
});
