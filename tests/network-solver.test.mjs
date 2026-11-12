import assert from "node:assert/strict";
import test from "node:test";
import { calculatePipeLoss, waterProperties } from "../src/Hydros.System.UI/Web/hydraulic-engine.js";
import { candidateInSystem, hotWaterPipeRole, pipeInSystem, solveFlows, solvePressures, systemKind, terminalsInSystem } from "../src/Hydros.System.UI/Web/network-solver.js";

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
const cold = "Água fria", hot = "Água quente", feedLabel = "Alimentação";
const pipe = (id, z0, z1, label = cold) => ({ kind: "pipe", type: "IfcPipeSegment", expressId: id, systemLabel: label, endpoints: [[0, 0, z0], [0, 0, z1]] });
const end = (id, e, system = cold) => ({ expressId: id, end: e, type: "IfcPipeSegment", system });
const part = (id, type, system) => ({ expressId: id, end: null, type, system });
const confirm = candidates => Object.fromEntries(candidates.map(candidate => [candidate.key, "Confirmada"]));

// origem → tubo 1 → tê (peça 50) → tubo 2 → terminal 9 ; tê → tubo 3 → terminal 8
function tee({ terminal9System = cold, fittingSystem = cold } = {}) {
  const records = [pipe(1, 10, 5), pipe(2, 5, 1), pipe(3, 5, 5)];
  const candidates = [
    { key: "a", from: end(1, 1), to: part(50, "IfcPipeFitting", fittingSystem) },
    { key: "b", from: end(2, 0), to: part(50, "IfcPipeFitting", fittingSystem) },
    { key: "c", from: end(3, 0), to: part(50, "IfcPipeFitting", fittingSystem) },
    { key: "d", from: end(2, 1), to: part(9, "IfcSanitaryTerminal", terminal9System) },
    { key: "f", from: end(3, 1), to: part(8, "IfcSanitaryTerminal", cold) }
  ];
  const terminals = [
    { expressId: 9, type: "IfcSanitaryTerminal", systemLabel: terminal9System },
    { expressId: 8, type: "IfcSanitaryTerminal", systemLabel: cold }
  ];
  const demands = { 9: { include: true, flowLps: "0.2", source: "ficha" }, 8: { include: true, flowLps: "0.3", source: "ficha", pressureMca: "5" } };
  const boundary = { expressId: 1, type: "IfcPipeSegment", end: 0, headM: "10", staticHeadM: "12", elevationM: "100" };
  return { system: "cold", boundary, tankMode: false, records, candidates, decisions: confirm(candidates), terminals, demands };
}
const hydraulics = { diameterMm: 21.6, lengthM: 5, roughnessMm: "0.0015", k: "2", source: "ficha" };
const pipeInputs = ids => new Map(ids.map(id => [id, hydraulics]));

test("classificação de rede aceita acentos e recusa rótulos desconhecidos", () => {
  assert.equal(systemKind("Água fria"), "cold");
  assert.equal(systemKind("AGUA QUENTE - retorno"), "hot");
  assert.equal(systemKind("Alimentação"), "feed");
  assert.equal(systemKind("Esgoto"), "unknown");
  assert.equal(systemKind("Água friagem"), "unknown");
  assert.equal(hotWaterPipeRole({ kind: "pipe", systemLabel: "Água quente - retorno" }), "return");
  assert.equal(pipeInSystem({ kind: "pipe", systemLabel: "Água quente - retorno" }, "hot"), false);
  assert.equal(pipeInSystem({ kind: "pipe", systemLabel: "Água quente" }, "hot"), true);
  assert.equal(hotWaterPipeRole({ kind: "pipe", systemLabels: ["Água quente", "Retorno"] }), "return");
  assert.equal(hotWaterPipeRole({ kind: "pipe", systemLabels: ["Água quente", "Água quente retorno"] }), "ambiguous");
  assert.equal(hotWaterPipeRole({ kind: "pipe", systemLabels: ["Retorno"], systemLabel: "Água quente" }), "return");
  assert.equal(hotWaterPipeRole({ kind: "pipe", systemLabel: "Recirculação" }), "return");
  assert.equal(hotWaterPipeRole({ kind: "pipe", systemLabel: "AQ - Ida" }), "supply");
  assert.equal(hotWaterPipeRole({ kind: "pipe", systemLabel: "AQ - Retorno" }), "return");
  assert.equal(candidateInSystem({ from: end(1, 0, hot), to: part(50, "IfcPipeSegment", "Retorno") }, "hot"), true);
});

test("vazões são agregadas a jusante em rede em árvore", () => {
  const flows = solveFlows(tee());
  assert.equal(flows.error, undefined);
  assert.deepEqual([...flows.result].sort(([a], [b]) => a - b), [[1, 0.5], [2, 0.2], [3, 0.3]]);
  assert.equal(flows.totalLps, 0.5);
  assert.deepEqual(flows.elevations[flows.source], 10);
});

test("terminal rotulado em outra rede entra pela rede do tubo ligado", () => {
  const scenario = tee({ terminal9System: hot });
  assert.deepEqual(terminalsInSystem(scenario.terminals, scenario.candidates, "cold").map(item => item.expressId), [9, 8]);
  assert.equal(solveFlows(scenario).totalLps, 0.5);
});

test("peça sem rede reconhecida entra pela rede do tubo; tubo de outra rede não", () => {
  assert.equal(solveFlows(tee({ fittingSystem: null })).totalLps, 0.5);
  assert.equal(candidateInSystem({ from: end(1, 1), to: part(50, "IfcValve", "Esgoto") }, "cold"), true);
  assert.equal(candidateInSystem({ from: end(1, 1), to: part(50, "IfcValve", hot) }, "cold"), false);
  assert.equal(candidateInSystem({ from: end(1, 1), to: end(2, 0, hot) }, "cold"), false);
  assert.equal(candidateInSystem({ from: end(1, 1, hot), to: end(2, 0, hot) }, "cold"), false);
});

test("pontas abertas, ambiguidades, ciclos e paralelos bloqueiam o cálculo", () => {
  const open = tee();
  open.decisions.f = "Pendente";
  assert.match(solveFlows(open).error, /1 extremidade\(s\) de tubo sem conexão/);

  const ambiguous = tee();
  ambiguous.candidates.push({ key: "x", from: end(1, 1), to: end(2, 0) });
  ambiguous.decisions.x = "Confirmada";
  assert.match(solveFlows(ambiguous).error, /mais de uma conexão confirmada/);

  const parallel = tee();
  parallel.records = [pipe(1, 10, 5), pipe(2, 5, 1), pipe(3, 5, 1)];
  parallel.candidates = [
    { key: "a", from: end(1, 1), to: part(50, "IfcPipeFitting", cold) }, { key: "b", from: end(2, 0), to: part(50, "IfcPipeFitting", cold) },
    { key: "c", from: end(3, 0), to: part(50, "IfcPipeFitting", cold) }, { key: "d", from: end(2, 1), to: part(51, "IfcPipeFitting", cold) },
    { key: "e", from: end(3, 1), to: part(51, "IfcPipeFitting", cold) }
  ];
  parallel.decisions = confirm(parallel.candidates);
  assert.match(solveFlows(parallel).error, /paralelo|ciclo/);

  const noSource = tee();
  noSource.boundary = null;
  assert.match(solveFlows(noSource).error, /origem/);

  const noDemand = tee();
  noDemand.demands = {};
  assert.match(solveFlows(noDemand).error, /ponto de utilização/);
});

test("demanda exige vazão positiva e fonte", () => {
  const scenario = tee();
  scenario.demands[9] = { include: true, flowLps: "0.2", source: " " };
  assert.match(solveFlows(scenario).error, /vazão positiva e fonte/);
});

test("alimentação de reservatório usa volume diário sobre o tempo de reposição", () => {
  const records = [pipe(1, 0, 3, feedLabel), pipe(2, 3, 8, feedLabel)];
  const candidates = [{ key: "a", from: end(1, 1, feedLabel), to: end(2, 0, feedLabel) }];
  const boundary = { expressId: 1, type: "IfcPipeSegment", end: 0, elevationM: "0", target: { expressId: 2, type: "IfcPipeSegment", end: 1 } };
  const base = { system: "feed", boundary, tankMode: true, records, candidates, decisions: confirm(candidates), terminals: [], demands: {}, dailyVolumeL: "5400", refillHours: "3", buildingType: "single" };
  const flows = solveFlows(base);
  close(flows.totalLps, 0.5);
  assert.deepEqual([...flows.result.values()], [0.5, 0.5]);
  assert.ok(solveFlows({ ...base, refillHours: "4" }).error, "unifamiliar limita a 3 h");
  assert.equal(solveFlows({ ...base, refillHours: "4", buildingType: "other" }).error, undefined);
  assert.ok(solveFlows({ ...base, refillHours: "7", buildingType: "other" }).error, "demais edificações limitam a 6 h");
  assert.ok(solveFlows({ ...base, dailyVolumeL: "" }).error);

  const pressures = solvePressures({ flowCalculation: flows, system: "feed", boundary, temperatureInput: "20",
    utilityPressure: "15", utilityStaticPressure: "20", utilityFlow: "0.5", pipeInputs: pipeInputs([1, 2]), demands: {} });
  const k = waterProperties(20).density / 1000, loss = calculatePipeLoss(0.5, hydraulics, 20).totalLossM;
  close(pressures.destination.available, 15 - (8 + 2 * loss) * k);
  close(pressures.destination.staticPressure, 20 - 8 * k);
  assert.match(solvePressures({ flowCalculation: flows, system: "feed", boundary, temperatureInput: "20",
    utilityPressure: "15", utilityStaticPressure: "20", utilityFlow: "0.4", pipeInputs: pipeInputs([1, 2]), demands: {} }).error, /vazão de referência/);
});

test("pressões seguem o balanço de carga com datum informado e m.c.a. convencional", () => {
  const scenario = tee();
  const flows = solveFlows(scenario);
  const result = solvePressures({ flowCalculation: flows, system: "cold", boundary: scenario.boundary, temperatureInput: "20",
    pipeInputs: pipeInputs([1, 2, 3]), demands: scenario.demands });
  assert.equal(result.error, undefined);
  const k = waterProperties(20).density / 1000, loss = q => calculatePipeLoss(q, hydraulics, 20).totalLossM;
  close(result.mcaPerMetre, k);
  assert.equal(result.elevationOffsetM, 90);
  const byId = Object.fromEntries(result.terminals.map(item => [item.expressId, item]));
  // terminal 9: Z IFC 1 m → cota 91 m ; terminal 8: Z IFC 5 m → cota 95 m
  close(byId[9].available, 10 + (100 - 91 - loss(0.5) - loss(0.2)) * k);
  close(byId[8].available, 10 + (100 - 95 - loss(0.5) - loss(0.3)) * k);
  close(byId[9].staticPressure, 12 + 9 * k);
  close(byId[9].staticPressureKpa, byId[9].staticPressure * 9.80665);
  close(byId[9].required, 10 / 9.80665);
  assert.equal(byId[8].required, 5);
  assert.ok(byId[9].passed && byId[8].passed);
  close(result.pipes[1].upstreamPressureMca, 10);
  close(result.pipes[2].downstreamPressureMca, byId[9].available);
  assert.deepEqual(result.failures, []);
});

test("a 60 °C a mesma pressão em m.c.a. equivale a mais coluna de água", () => {
  const scenario = tee();
  const flows = solveFlows(scenario);
  const at = temperature => solvePressures({ flowCalculation: flows, system: "cold", boundary: scenario.boundary,
    temperatureInput: String(temperature), pipeInputs: pipeInputs([1, 2, 3]), demands: scenario.demands });
  const warm = at(60), k = waterProperties(60).density / 1000;
  assert.ok(k < 0.99);
  const loss = q => calculatePipeLoss(q, hydraulics, 60).totalLossM;
  close(warm.terminals.find(item => item.expressId === 9).available, 10 + (9 - loss(0.5) - loss(0.2)) * k);
});

test("limites de pressão, velocidade e dados ausentes são sinalizados", () => {
  const scenario = tee();
  const flows = solveFlows(scenario);
  const run = (overrides = {}, inputs = pipeInputs([1, 2, 3])) => solvePressures({ flowCalculation: flows, system: "cold",
    boundary: { ...scenario.boundary, ...overrides }, temperatureInput: "20", pipeInputs: inputs, demands: scenario.demands });

  const highStatic = run({ staticHeadM: "45" });
  assert.ok(highStatic.failures.some(text => /estática acima de 400 kPa/.test(text)));
  assert.equal(highStatic.terminals.every(item => item.passed), false);

  const lowDynamic = run({ headM: "0.2", staticHeadM: "0.2" });
  assert.ok(lowDynamic.failures.some(text => /abaixo da requerida/.test(text)));
  assert.ok(lowDynamic.failures.some(text => /origem abaixo de 5 kPa/.test(text)));

  const narrow = run({}, new Map([1, 2, 3].map(id => [id, { ...hydraulics, diameterMm: 10 }])));
  assert.ok(narrow.failures.some(text => /velocidade acima de 3 m\/s/.test(text)));

  assert.match(run({}, new Map([1, 2, 3].map(id => [id, { ...hydraulics, source: "" }]))).error, /fonte física/);
  assert.match(run({}, new Map([1, 2, 3].map(id => [id, { ...hydraulics, roughnessMm: "" }]))).error, /Tubo Express ID/);
  assert.match(run({ elevationM: "" }).error, /cota da origem/);
  assert.match(run({ staticHeadM: "5" }).error, /estática máxima/);
  assert.match(solvePressures({ flowCalculation: flows, system: "cold", boundary: scenario.boundary, temperatureInput: "",
    pipeInputs: pipeInputs([1, 2, 3]), demands: scenario.demands }).error, /temperatura/);
});

test("água quente sai marcada como resultado parcial", () => {
  const scenario = tee();
  for (const item of scenario.records) item.systemLabel = hot;
  for (const candidate of scenario.candidates) { candidate.from.system = hot; candidate.to.system = hot; }
  for (const item of scenario.terminals) item.systemLabel = hot;
  scenario.system = "hot";
  const flows = solveFlows(scenario);
  assert.equal(flows.totalLps, 0.5);
  const result = solvePressures({ flowCalculation: flows, system: "hot", boundary: scenario.boundary, temperatureInput: "60",
    pipeInputs: pipeInputs([1, 2, 3]), demands: scenario.demands });
  assert.ok(result.failures.some(text => /retorno e balanceamento/.test(text)));
});

test("tubo de ida conectado ao retorno fecha a ponta sem entrar na árvore de distribuição", () => {
  const scenario = tee();
  for (const item of scenario.records) item.systemLabel = hot;
  for (const candidate of scenario.candidates) { candidate.from.system = hot; candidate.to.system = hot; }
  scenario.records.push(pipe(30, 0, 0, hot + " - retorno"));
  scenario.candidates = scenario.candidates.filter(candidate => candidate.key !== "f");
  scenario.candidates.push({ key: "return", from: end(3, 1, hot), to: end(30, 0, hot + " - retorno") });
  scenario.decisions.return = "Confirmada";
  scenario.system = "hot";
  scenario.demands[8].include = false;
  const result = solveFlows(scenario);
  assert.equal(result.error, undefined);
  assert.equal(result.result.has(30), false);
  assert.equal(result.result.get(3), 0);
});

test("ponta declarada sem vazão deixa de bloquear e fica registrada", () => {
  const scenario = tee();
  scenario.decisions.f = "Pendente";
  scenario.demands = { 9: scenario.demands[9] };
  assert.match(solveFlows(scenario).error, /declare a ponta sem vazão/);
  const flows = solveFlows({ ...scenario, closedEnds: new Set(["p:3:1"]) });
  assert.equal(flows.error, undefined);
  assert.deepEqual([...flows.result].sort(([a], [b]) => a - b), [[1, 0.2], [2, 0.2], [3, 0]]);
  assert.deepEqual(flows.declaredClosedEnds, [{ expressId: 3, end: 1 }]);
  // tubo sem vazão não gera perda e mantém a pressão do nó a montante, corrigida pela cota
  const pressures = solvePressures({ flowCalculation: flows, system: "cold", boundary: scenario.boundary, temperatureInput: "20",
    pipeInputs: pipeInputs([1, 2, 3]), demands: scenario.demands });
  assert.equal(pressures.pipes[3].totalLossM, 0);
  close(pressures.pipes[3].downstreamPressureMca, pressures.pipes[3].upstreamPressureMca);
});

test("rede separada da mesma classe fica fora do cálculo e é informada", () => {
  const scenario = tee();
  // segunda rede de água fria (ex.: reúso), fechada em si mesma e sem ligação com a origem
  scenario.records.push(pipe(20, 0, 3, "Água fria (Reúso)"), pipe(21, 3, 6, "Água fria (Reúso)"));
  scenario.candidates.push({ key: "r", from: end(20, 1, "Água fria (Reúso)"), to: end(21, 0, "Água fria (Reúso)") });
  scenario.decisions.r = "Confirmada";
  const flows = solveFlows(scenario);
  assert.equal(flows.error, undefined);
  assert.equal(flows.unreachedPipes, 2);
  assert.equal(flows.result.size, 3);
  assert.equal(flows.totalLps, 0.5);
});

test("ligação esquecida continua bloqueando mesmo com outra rede separada", () => {
  const scenario = tee();
  scenario.decisions.b = "Pendente"; // tubo 2 solto do tê: ponta aberta e terminal 9 inalcançável
  assert.match(solveFlows(scenario).error, /terminal Express ID 9 não é alcançado|extremidade\(s\) de tubo sem conexão/);
  assert.match(solveFlows({ ...scenario, closedEnds: new Set(["p:2:0"]) }).error, /terminal Express ID 9 não é alcançado/);
});

test("reservatório e aquecedor ligam tubos de redes diferentes", () => {
  const tank = part(70, "IfcTank", feedLabel), boiler = part(71, "IfcBoiler", hot);
  assert.equal(candidateInSystem({ from: end(1, 0), to: tank }, "cold"), true);
  assert.equal(candidateInSystem({ from: end(1, 0, feedLabel), to: tank }, "feed"), true);
  assert.equal(candidateInSystem({ from: end(1, 0), to: boiler }, "cold"), true);
  assert.equal(candidateInSystem({ from: end(1, 0), to: tank }, "hot"), false, "a rede continua sendo a do tubo");
  // reservatório como origem da água fria
  const scenario = tee();
  scenario.candidates.push({ key: "t", from: end(1, 0), to: tank });
  scenario.decisions.t = "Confirmada";
  scenario.boundary = { ...scenario.boundary, expressId: 70, type: "IfcTank", end: null };
  const flows = solveFlows(scenario);
  assert.equal(flows.totalLps, 0.5);
  assert.equal(flows.elevations[flows.source], 10);
});

test("erro de ciclo aponta o tubo que fecha o circuito", () => {
  // duas bombas em paralelo: tubos 2 e 3 ligam as mesmas peças por caminhos diferentes (via tubo 4)
  const records = [pipe(1, 0, 0), pipe(2, 0, 0), pipe(3, 0, 0), pipe(4, 0, 0)];
  const fit = id => part(id, "IfcPipeFitting", cold);
  const candidates = [
    { key: "a", from: end(1, 1), to: fit(50) }, { key: "b", from: end(2, 0), to: fit(50) }, { key: "c", from: end(3, 0), to: fit(50) },
    { key: "d", from: end(2, 1), to: fit(51) }, { key: "e", from: end(4, 0), to: fit(51) },
    { key: "f", from: end(3, 1), to: fit(52) }, { key: "g", from: end(4, 1), to: fit(52) }
  ];
  const base = { system: "cold", boundary: { expressId: 1, type: "IfcPipeSegment", end: 0 }, tankMode: false, records, candidates,
    decisions: confirm(candidates), terminals: [], demands: {} };
  const error = solveFlows(base).error;
  assert.match(error, /ciclo que fecha no tubo Express ID (2|3|4)/);
  // rejeitar o ramo reserva abre o ciclo; as pontas soltas passam a ser a pendência
  const opened = solveFlows({ ...base, decisions: { ...base.decisions, f: "Rejeitada" } }).error;
  assert.match(opened, /extremidade\(s\) de tubo sem conexão/);
});
