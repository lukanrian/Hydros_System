import assert from "node:assert/strict";
import test from "node:test";
import { buildConnectionCandidates, readIfcConnectivity } from "../src/Hydros.System.UI/Web/ifc-connectivity.js";
import { solveFlows } from "../src/Hydros.System.UI/Web/network-solver.js";

const ref = id => ({ value: id });
// Substituto mínimo do web-ifc: linhas por classe, com expressID.
function fakeIfc(linesByType) {
  const byId = new Map(Object.values(linesByType).flat().map(line => [line.expressID, line]));
  return {
    GetTypeCodeFromName: name => name,
    GetLineIDsWithType: (_model, type) => { const lines = linesByType[type] ?? []; return { size: () => lines.length, get: i => lines[i].expressID }; },
    GetLine: (_model, id) => byId.get(id)
  };
}
const pipe = (id, from, to, extra = {}) => [id, { expressId: id, globalId: "g" + id, type: "IfcPipeSegment", systemLabel: null, endpoints: [from, to], origin: from, ...extra }];
const component = (id, type, origin, extra = {}) => [id, { expressId: id, globalId: "g" + id, type, systemLabel: null, endpoints: null, origin, ...extra }];
const empty = { byPort: new Map(), byProduct: new Map(), relations: [] };

test("sem portas IFC, os candidatos vêm da geometria com as chaves históricas", () => {
  const products = new Map([
    pipe(1, [0, 0, 0], [1, 0, 0]), pipe(2, [1.02, 0, 0], [2, 0, 0]), pipe(3, [5, 0, 0], [6, 0, 0]),
    component(5, "IfcPipeFitting", [1.01, 0, 0])
  ]);
  const { candidates, unresolvedRelations } = buildConnectionCandidates(products, empty);
  assert.equal(unresolvedRelations, 0);
  assert.deepEqual(candidates.map(candidate => candidate.key).sort(), ["1:1:2:0", "1:1:5:", "2:0:5:"]);
  assert.ok(candidates.every(candidate => candidate.source === "geometry" && candidate.distance_m <= 0.05));
  assert.deepEqual(candidates.map(candidate => candidate.distance_m), [...candidates.map(candidate => candidate.distance_m)].sort((a, b) => a - b));
});

test("extremidades a mais de 50 mm não viram candidatas", () => {
  const products = new Map([pipe(1, [0, 0, 0], [1, 0, 0]), pipe(2, [1.06, 0, 0], [2, 0, 0])]);
  assert.deepEqual(buildConnectionCandidates(products, empty).candidates, []);
});

function portModel() {
  const products = new Map([
    pipe(1, [0, 0, 0], [1, 0, 0]), pipe(2, [1.2, 0, 0], [2.2, 0, 0]),
    component(5, "IfcPipeFitting", [1.1, 0, 0]), component(9, "IfcSanitaryTerminal", [2.25, 0, 0])
  ]);
  const points = { 11: [0, 0, 0], 12: [1, 0, 0], 21: [1.2, 0, 0], 22: [2.2, 0, 0], 51: [1.02, 0, 0], 52: [1.18, 0, 0] };
  const port = id => ({ expressID: id });
  const api = fakeIfc({
    IFCDISTRIBUTIONSYSTEM: [{ expressID: 900, Name: ref("AF-01"), PredefinedType: ref("DOMESTICCOLDWATER") }],
    IFCRELASSIGNSTOGROUP: [{ expressID: 901, RelatingGroup: ref(900), RelatedObjects: [ref(1), ref(2), ref(5)] }],
    IFCDISTRIBUTIONPORT: [11, 12, 21, 22, 51, 52].map(port),
    IFCRELNESTS: [
      { expressID: 801, RelatingObject: ref(1), RelatedObjects: [ref(11), ref(12)] },
      { expressID: 802, RelatingObject: ref(2), RelatedObjects: [ref(21), ref(22)] },
      { expressID: 805, RelatingObject: ref(5), RelatedObjects: [ref(51), ref(52)] }
    ],
    IFCRELCONNECTSPORTS: [
      { expressID: 700, RelatingPort: ref(12), RelatedPort: ref(51) },
      { expressID: 701, RelatingPort: ref(52), RelatedPort: ref(21) }
    ]
  });
  return { products, api, readPortPoint: line => points[line.expressID] ?? null };
}

test("sistemas e portas explícitos do IFC classificam a rede e geram as ligações", () => {
  const { products, api, readPortPoint } = portModel();
  const connectivity = readIfcConnectivity(api, null, products, readPortPoint);
  assert.equal(connectivity.systemCount, 1);
  assert.equal(connectivity.relations.length, 2);
  assert.equal(products.get(1).systemLabel, "Água fria");
  assert.match(products.get(1).systemSource, /IfcDistributionSystem #900/);
  assert.deepEqual(products.get(5).systemLabels, ["Água fria"]);
  assert.equal(products.get(9).systemLabel, null);

  const { candidates, unresolvedRelations } = buildConnectionCandidates(products, connectivity);
  assert.equal(unresolvedRelations, 0);
  const ports = candidates.filter(candidate => candidate.source === "ifc-ports");
  assert.deepEqual(ports.map(candidate => candidate.key).sort(), ["1:1:5::porta-51", "2:0:5::porta-52"]);
  assert.ok(ports.every(candidate => candidate.to.type === "IfcPipeFitting" && /IfcRelConnectsPorts/.test(candidate.evidence)));
  // a ponta livre do tubo 2 ainda recebe o candidato geométrico do terminal
  assert.deepEqual(candidates.filter(candidate => candidate.source === "geometry").map(candidate => candidate.key), ["2:1:9:"]);
  assert.equal(candidates[0].source, "ifc-ports", "ligações explícitas vêm primeiro na revisão");
});

test("candidatos por porta alimentam o cálculo de vazões", () => {
  const { products, api, readPortPoint } = portModel();
  const { candidates } = buildConnectionCandidates(products, readIfcConnectivity(api, null, products, readPortPoint));
  const records = [...products.values()].map(item => ({ ...item, kind: item.type === "IfcPipeSegment" ? "pipe" : "other" }));
  const flows = solveFlows({
    system: "cold", boundary: { expressId: 1, type: "IfcPipeSegment", end: 0 }, tankMode: false, records, candidates,
    decisions: Object.fromEntries(candidates.map(candidate => [candidate.key, "Confirmada"])),
    terminals: [{ expressId: 9, type: "IfcSanitaryTerminal", systemLabel: null }],
    demands: { 9: { include: true, flowLps: "0.25", source: "ficha" } }
  });
  assert.equal(flows.error, undefined);
  assert.deepEqual([...flows.result].sort(([a], [b]) => a - b), [[1, 0.25], [2, 0.25]]);
});

test("rótulo em propriedade continua valendo quando o IfcSystem não tem nome reconhecido", () => {
  const products = new Map([pipe(1, [0, 0, 0], [1, 0, 0], { systemLabel: "Água quente" })]);
  const api = fakeIfc({
    IFCSYSTEM: [{ expressID: 900, Name: ref("Prumada 3") }],
    IFCRELASSIGNSTOGROUP: [{ expressID: 901, RelatingGroup: ref(900), RelatedObjects: [ref(1)] }]
  });
  readIfcConnectivity(api, null, products, () => null);
  assert.equal(products.get(1).systemLabel, "Água quente");
  assert.deepEqual(products.get(1).systemLabels, ["Água quente", "Prumada 3"]);
});

test("tubo sem endpoints extraídos recebe as extremidades das duas portas posicionadas", () => {
  const products = new Map([pipe(1, null, null, { endpoints: null, origin: null })]);
  const points = { 11: [0, 0, 3], 12: [0, 0, 0] };
  const api = fakeIfc({
    IFCDISTRIBUTIONPORT: [{ expressID: 11 }, { expressID: 12 }],
    IFCRELCONNECTSPORTTOELEMENT: [
      { expressID: 801, RelatingPort: ref(11), RelatedElement: ref(1) },
      { expressID: 802, RelatingPort: ref(12), RelatedElement: ref(1) }
    ]
  });
  readIfcConnectivity(api, null, products, line => points[line.expressID]);
  assert.deepEqual(products.get(1).endpoints, [[0, 0, 3], [0, 0, 0]]);
});

test("relação de portas que não mapeia para uma ponta de tubo é contada como não resolvida", () => {
  const products = new Map([pipe(1, [0, 0, 0], [1, 0, 0]), component(5, "IfcPipeFitting", [1.01, 0, 0])]);
  const api = fakeIfc({
    IFCDISTRIBUTIONPORT: [{ expressID: 12 }, { expressID: 51 }],
    IFCRELNESTS: [
      { expressID: 801, RelatingObject: ref(1), RelatedObjects: [ref(12)] },
      { expressID: 805, RelatingObject: ref(5), RelatedObjects: [ref(51)] }
    ],
    IFCRELCONNECTSPORTS: [{ expressID: 700, RelatingPort: ref(12), RelatedPort: ref(51) }]
  });
  // a porta do tubo não tem posição: não dá para saber qual extremidade ela representa
  const { candidates, unresolvedRelations } = buildConnectionCandidates(products, readIfcConnectivity(api, null, products, () => null));
  assert.equal(unresolvedRelations, 1);
  assert.ok(candidates.every(candidate => candidate.source === "geometry"));
});

test("ponta sem candidato dentro do volume de uma peça vira candidata", async () => {
  const { addVolumeCandidates } = await import("../src/Hydros.System.UI/Web/ifc-connectivity.js");
  // malhas deslocadas (-10, -20, -5) em relação às coordenadas IFC, como faz o visor
  const shift = [-10, -20, -5], around = (from, to, r = 0.02) => [0, 1, 2].map(k => Math.min(from[k], to[k]) - r + shift[k]).concat([0, 1, 2].map(k => Math.max(from[k], to[k]) + r + shift[k]));
  const products = new Map([
    pipe(1, [0, 0, 0], [1, 0, 0]), pipe(2, [1.3, 0, 0], [2, 0, 0]), pipe(3, [2, 0.3, 0], [2, 1, 0]), pipe(4, [5, 5, 5], [6, 5, 5]),
    component(50, "IfcValve", [1.15, 0, 0]), component(60, "IfcTank", [9, 9, 9])
  ]);
  const boxes = new Map([...products.values()].filter(item => item.endpoints).map(item => [item.expressId, around(...item.endpoints)]));
  boxes.set(50, around([0.98, 0, 0], [1.32, 0, 0], 0.05));   // registro comprido: origem a 150 mm das duas pontas
  boxes.set(60, around([8, 8, 8], [10, 10, 10], 0));
  const { candidates } = buildConnectionCandidates(products, empty);
  assert.deepEqual(candidates, [], "nada dentro de 50 mm");
  const result = addVolumeCandidates(products, candidates, boxes);
  assert.deepEqual({ calibrated: result.calibrated, added: result.added }, { calibrated: true, added: 2 });
  assert.deepEqual(candidates.map(candidate => candidate.key).sort(), ["1:1:50:", "2:0:50:"]);
  assert.ok(candidates.every(candidate => candidate.source === "geometry" && /volume da peça/.test(candidate.evidence) && Math.abs(candidate.distance_m - 0.15) < 1e-9));

  // pontas que já têm candidato não recebem outro
  const before = candidates.length;
  assert.equal(addVolumeCandidates(products, candidates, boxes).added, 0);
  assert.equal(candidates.length, before);
});

test("sem conferência do referencial das malhas, nenhum candidato por volume é criado", async () => {
  const { addVolumeCandidates } = await import("../src/Hydros.System.UI/Web/ifc-connectivity.js");
  const products = new Map([pipe(1, [0, 0, 0], [1, 0, 0]), pipe(2, [2, 0, 0], [3, 0, 0]), pipe(3, [4, 0, 0], [5, 0, 0]), component(50, "IfcValve", [1.5, 0, 0])]);
  // cada tubo com um deslocamento diferente: malhas e eixos não concordam
  const boxes = new Map([[1, [0, 0, 0, 1, 0, 0]], [2, [7, 0, 0, 8, 0, 0]], [3, [-3, 4, 0, -2, 4, 0]], [50, [0.9, -1, -1, 2.1, 1, 1]]]);
  const candidates = [];
  const result = addVolumeCandidates(products, candidates, boxes);
  assert.equal(result.calibrated, false);
  assert.deepEqual(candidates, []);
});

test("ponta que só tem candidato tubo–tubo também recebe a peça que a envolve", async () => {
  const { addVolumeCandidates } = await import("../src/Hydros.System.UI/Web/ifc-connectivity.js");
  // registro entre dois tubos: a origem fica a 40 mm do tubo 1 e a 70 mm do tubo 2; as pontas distam 30 mm entre si
  const products = new Map([
    pipe(1, [0, 0, 0], [1, 0, 0]), pipe(2, [1.03, 0, 0], [2, 0, 0]), pipe(3, [3, 0, 0], [4, 0, 0]),
    component(50, "IfcValve", [0.96, 0, 0])
  ]);
  const box = (from, to, r) => [0, 1, 2].map(k => Math.min(from[k], to[k]) - r).concat([0, 1, 2].map(k => Math.max(from[k], to[k]) + r));
  const boxes = new Map([[1, box([0, 0, 0], [1, 0, 0], 0.02)], [2, box([1.03, 0, 0], [2, 0, 0], 0.02)], [3, box([3, 0, 0], [4, 0, 0], 0.02)], [50, box([0.9, 0, 0], [1.05, 0, 0], 0.04)]]);
  const { candidates } = buildConnectionCandidates(products, empty);
  assert.deepEqual(candidates.map(candidate => candidate.key).sort(), ["1:1:2:0", "1:1:50:"]);
  assert.equal(addVolumeCandidates(products, candidates, boxes).added, 1);
  assert.deepEqual(candidates.map(candidate => candidate.key).sort(), ["1:1:2:0", "1:1:50:", "2:0:50:"]);
  // com a peça dos dois lados, o lote confirma as duas ligações ao registro e ignora a ligação direta
  const { pendingConnectionsForBatch } = await import("../src/Hydros.System.UI/Web/review-batches.js");
  assert.deepEqual(pendingConnectionsForBatch(candidates, {}, () => true, () => true, new Set()).map(candidate => candidate.key).sort(), ["1:1:50:", "2:0:50:"]);
});

test("tubo curto só fica candidato à peça pela ponta mais próxima", async () => {
  const { addVolumeCandidates } = await import("../src/Hydros.System.UI/Web/ifc-connectivity.js");
  // nípel de 29 mm ao lado de um registro: as duas pontas ficam a menos de 50 mm da origem da peça
  const products = new Map([
    pipe(1, [0.019, 0, 0], [0.048, 0, 0]), pipe(2, [-0.019, 0, 0], [-1, 0, 0]), pipe(3, [3, 0, 0], [4, 0, 0]),
    component(50, "IfcValve", [0, 0, 0]), component(51, "IfcPipeFitting", [0.07, 0, 0])
  ]);
  const { candidates } = buildConnectionCandidates(products, empty);
  const keys = candidates.map(candidate => candidate.key).sort();
  assert.ok(keys.includes("1:0:50:"), "ponta a 19 mm continua candidata ao registro");
  assert.ok(!keys.includes("1:1:50:"), "ponta a 48 mm do registro sai da lista");
  assert.ok(keys.includes("1:1:51:"), "a ponta distante segue candidata à conexão vizinha");
  // a busca por volume não devolve a ponta descartada, mesmo estando dentro da malha do registro
  const box = (from, to, r) => [0, 1, 2].map(k => Math.min(from[k], to[k]) - r).concat([0, 1, 2].map(k => Math.max(from[k], to[k]) + r));
  const boxes = new Map([[1, box([0.019, 0, 0], [0.048, 0, 0], 0.01)], [2, box([-0.019, 0, 0], [-1, 0, 0], 0.01)], [3, box([3, 0, 0], [4, 0, 0], 0.01)], [50, box([-0.06, 0, 0], [0.06, 0, 0], 0.03)]]);
  const withoutFitting = candidates.filter(candidate => candidate.to.expressId !== 51);
  addVolumeCandidates(products, withoutFitting, boxes);
  assert.ok(!withoutFitting.some(candidate => candidate.key === "1:1:50:"));
});

test("pontas equidistantes da mesma peça seguem as duas para a revisão", () => {
  const products = new Map([pipe(1, [-0.02, 0, 0], [0.02, 0, 0]), component(50, "IfcValve", [0, 0.01, 0])]);
  const keys = buildConnectionCandidates(products, empty).candidates.map(candidate => candidate.key).sort();
  assert.deepEqual(keys, ["1:0:50:", "1:1:50:"]);
});
