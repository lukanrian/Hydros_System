import assert from "node:assert/strict";
import test from "node:test";
import { fillPipeBatch, pendingConnectionsForBatch, pipeBatchGroups } from "../src/Hydros.System.UI/Web/review-batches.js";

const pipeEnd = (id, end) => ({ expressId: id, end, type: "IfcPipeSegment" });
const terminal = id => ({ expressId: id, end: null, type: "IfcSanitaryTerminal" });
const keys = list => list.map(candidate => candidate.key);
const all = () => true;

test("lote de conexões só propõe ligações sem disputa de extremidade", () => {
  const candidates = [
    { key: "x", from: pipeEnd(1, 1), to: pipeEnd(2, 0) },
    { key: "y", from: pipeEnd(1, 1), to: pipeEnd(3, 0) },
    { key: "z", from: pipeEnd(2, 1), to: terminal(9) }
  ];
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, {}, all, all, new Set())), ["z"]);
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, { y: "Rejeitada" }, all, all, new Set())), ["x", "z"]);
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, { y: "Rejeitada", x: "Confirmada" }, all, all, new Set())), ["z"]);
});

test("lote respeita rede ativa, extremidades reservadas e terminal com duas ligações", () => {
  const candidates = [
    { key: "a", from: pipeEnd(1, 0), to: pipeEnd(2, 0) },
    { key: "b", from: pipeEnd(3, 1), to: terminal(9) },
    { key: "c", from: pipeEnd(4, 1), to: terminal(9) },
    { key: "d", from: pipeEnd(5, 1), to: pipeEnd(6, 0) }
  ];
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, {}, all, all, new Set(["p:1:0"]))), ["d"]);
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, {}, candidate => candidate.key !== "d", all, new Set())), ["a"]);
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, {}, all, candidate => candidate.key === "a", new Set())), ["a"]);
});

test("portas IFC compartilhadas também contam como disputa", () => {
  const candidates = [
    { key: "a", from: { ...pipeEnd(1, 1), portId: 11 }, to: { expressId: 5, end: null, type: "IfcPipeFitting", portId: 51 } },
    { key: "b", from: { ...pipeEnd(2, 0), portId: 21 }, to: { expressId: 5, end: null, type: "IfcPipeFitting", portId: 51 } },
    { key: "c", from: { ...pipeEnd(3, 0), portId: 31 }, to: { expressId: 5, end: null, type: "IfcPipeFitting", portId: 53 } }
  ];
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, {}, all, all, new Set())), ["c"]);
});

test("candidato tubo–tubo é redundante quando as duas pontas chegam à mesma peça", () => {
  const fitting = id => ({ expressId: id, end: null, type: "IfcPipeFitting" });
  const candidates = [
    { key: "a", from: pipeEnd(1, 1), to: fitting(50) },
    { key: "b", from: pipeEnd(2, 0), to: fitting(50) },
    { key: "ab", from: pipeEnd(1, 1), to: pipeEnd(2, 0) },
    { key: "c", from: pipeEnd(3, 0), to: fitting(60) },
    { key: "d", from: pipeEnd(4, 0), to: fitting(61) },
    { key: "cd", from: pipeEnd(3, 0), to: pipeEnd(4, 0) }
  ];
  // 1 e 2 chegam à peça 50: a ligação direta entre eles não disputa as pontas. 3 e 4 chegam a peças diferentes.
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, {}, all, all, new Set())), ["a", "b"]);
  // se o projetista já confirmou a ligação direta, as pontas ficam ocupadas
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, { ab: "Confirmada" }, all, all, new Set())), []);
  // rejeitar a peça 50 numa ponta devolve a disputa à revisão individual
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, { b: "Rejeitada" }, all, all, new Set())), []);
});

test("tubo curto com as duas pontas na mesma peça não é confirmado em lote", () => {
  const fitting = { expressId: 50, end: null, type: "IfcPipeFitting" };
  const candidates = [
    { key: "a", from: pipeEnd(1, 0), to: fitting },
    { key: "b", from: pipeEnd(1, 1), to: fitting },
    { key: "c", from: pipeEnd(2, 0), to: fitting }
  ];
  assert.deepEqual(keys(pendingConnectionsForBatch(candidates, {}, all, all, new Set())), ["c"]);
});

test("tubos são agrupados por material e diâmetro interno", () => {
  const items = [
    { expressId: 1, materials: ["PVC", "PVC"] }, { expressId: 2, materials: ["PVC"] }, { expressId: 2, materials: ["PVC"] },
    { expressId: 3, materials: [], properties: [{ name: "Material", value: "CPVC" }] }, { expressId: 4 }
  ];
  const groups = pipeBatchGroups(items, item => ({ diameterMm: item.expressId === 2 ? 27.8 : item.expressId === 4 ? "" : 21.6 }));
  assert.deepEqual([...groups.keys()], ["PVC", "CPVC", "Material IFC não identificado"]);
  assert.deepEqual([...groups.get("PVC")], [["21.600000", [1]], ["27.800000", [2]]]);
  assert.deepEqual([...groups.get("Material IFC não identificado")], [["missing", [4]]]);
});

test("preenchimento em lote só completa campos vazios e preserva outra fonte", () => {
  const saved = { 2: { roughnessMm: "0.01", source: "outra" }, 3: { k: "1" }, 4: { roughnessMm: "0.2", k: "3", source: "Fab" } };
  const { updates } = fillPipeBatch([1, 2, 3, 4], saved, { roughnessMm: "0.0015", k: "0", source: " Fab " });
  assert.deepEqual([...updates], [
    [1, { roughnessMm: "0.0015", k: "0", source: "Fab" }],
    [3, { k: "1", roughnessMm: "0.0015", source: "Fab" }]
  ]);
  assert.deepEqual(saved[3], { k: "1" }, "entrada original não é alterada");
});

test("preenchimento em lote exige fonte e valores válidos; zero é aceito", () => {
  assert.ok(fillPipeBatch([1], {}, { roughnessMm: "0.1", k: "", source: "" }).error);
  assert.ok(fillPipeBatch([1], {}, { roughnessMm: "", k: "", source: "Fab" }).error);
  assert.ok(fillPipeBatch([1], {}, { roughnessMm: "-1", k: "", source: "Fab" }).error);
  assert.ok(fillPipeBatch([1], {}, { roughnessMm: "abc", k: "", source: "Fab" }).error);
  assert.deepEqual([...fillPipeBatch([1], {}, { roughnessMm: "", k: "0", source: "Fab" }).updates], [[1, { k: "0", source: "Fab" }]]);
});
