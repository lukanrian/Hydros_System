import { calculatePipeLoss, waterProperties } from "./hydraulic-engine.js";
import { hotWaterPipeRole } from "./network-solver.js";

const cp = 4186;
const isPipe = item => item?.type?.toLowerCase() === "ifcpipesegment";
const pipeKey = (id, end) => `p:${id}:${end}`;
const componentKey = id => `c:${id}`;

function path(graph, source, target) {
  if (source === target) return [];
  const previous = new Map([[source, null]]), queue = [source];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const { node, expressId } of graph.get(current) ?? []) {
      if (previous.has(node)) continue;
      previous.set(node, { parent: current, expressId });
      if (node === target) {
        const ids = [];
        for (let at = target; at !== source;) { const step = previous.get(at); ids.push(step.expressId); at = step.parent; }
        return ids.reverse();
      }
      queue.push(node);
    }
  }
  return null;
}

function reachable(graph, source) {
  const seen = new Set(graph.has(source) ? [source] : []), stack = [...seen];
  while (stack.length) for (const { node } of graph.get(stack.pop()) ?? []) if (!seen.has(node)) { seen.add(node); stack.push(node); }
  return seen;
}

function connectedTree(graph, source) {
  if (!graph.has(source)) return false;
  const seen = new Set([source]), stack = [source];
  while (stack.length) for (const { node } of graph.get(stack.pop()) ?? []) if (!seen.has(node)) { seen.add(node); stack.push(node); }
  let edges = 0;
  for (const node of seen) edges += (graph.get(node) ?? []).filter(edge => seen.has(edge.node)).length;
  return edges / 2 === seen.size - 1;
}

export function calculateHotWaterReturn({ records, candidates, decisions, boundary, deltaTC, temperatureC, pipeInputs }) {
  const error = message => ({ error: message });
  const pipes = new Map(records.filter(isPipe).map(item => [item.expressId, item]));
  const roles = new Map([...pipes].map(([id, item]) => [id, hotWaterPipeRole(item)]));
  if ([...roles.values()].includes("ambiguous")) return error("O IFC atribui o mesmo tubo de água quente a redes de distribuição e retorno; corrija a classificação explícita.");
  const hotPipes = new Map([...pipes].filter(([id]) => roles.get(id)));
  const supply = new Set([...hotPipes].filter(([id]) => roles.get(id) === "supply").map(([id]) => id));
  const returned = new Set([...hotPipes].filter(([id]) => roles.get(id) === "return").map(([id]) => id));
  if (!supply.size || !returned.size) return error("O IFC precisa identificar explicitamente tubos de distribuição de água quente e tubos de retorno/recirculação.");
  if (!boundary || boundary.type?.toLowerCase() !== "ifcboiler") return error("Selecione o aquecedor IFC como origem para fechar os circuitos de retorno.");
  const delta = Number(deltaTC), temperature = Number(temperatureC);
  if (!Number.isFinite(delta) || delta <= 0) return error("Informe um ΔT positivo entre a saída do aquecedor e o retorno.");
  let density;
  try { density = waterProperties(temperature).density; } catch (e) { return error(e.message); }

  const parent = new Map(), find = key => { if (!parent.has(key)) parent.set(key, key); if (parent.get(key) !== key) parent.set(key, find(parent.get(key))); return parent.get(key); };
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
  for (const id of hotPipes.keys()) { find(pipeKey(id, 0)); find(pipeKey(id, 1)); }
  for (const { key, from, to } of candidates) {
    if (decisions[key] !== "Confirmada" || !hotPipes.has(from.expressId)) continue;
    const toIsPipe = isPipe(to);
    if (toIsPipe && !hotPipes.has(to.expressId)) continue;
    union(pipeKey(from.expressId, from.end), toIsPipe ? pipeKey(to.expressId, to.end) : componentKey(to.expressId));
  }

  const graphs = { supply: new Map(), return: new Map() }, edgeByPipe = new Map(), componentsByNode = new Map();
  for (const { key, from, to } of candidates) if (decisions[key] === "Confirmada" && hotPipes.has(from.expressId) && !isPipe(to)) {
    const node = find(componentKey(to.expressId));
    if (!componentsByNode.has(node)) componentsByNode.set(node, new Set());
    componentsByNode.get(node).add(to.expressId);
  }
  for (const [id, item] of hotPipes) {
    const graph = graphs[roles.get(id)], a = find(pipeKey(id, 0)), b = find(pipeKey(id, 1));
    if (a === b) return error(`O IFC fecha o tubo Express ID ${id} sobre o próprio nó; revise a conectividade do retorno.`);
    for (const node of [a, b]) if (!graph.has(node)) graph.set(node, []);
    graph.get(a).push({ node: b, expressId: id }); graph.get(b).push({ node: a, expressId: id });
    edgeByPipe.set(id, { a, b });
  }
  const source = find(componentKey(boundary.expressId));
  for (const kind of ["supply", "return"]) {
    if (!connectedTree(graphs[kind], source)) return error(`As conexões confirmadas do IFC não formam uma árvore contínua de ${kind === "supply" ? "distribuição" : "retorno"} até o aquecedor.`);
  }
  const supplyReach = reachable(graphs.supply, source), returnReach = reachable(graphs.return, source);
  const junctions = [...supplyReach].filter(node => node !== source && returnReach.has(node));
  if (!junctions.length) return error("Nenhum ramal de recirculação foi identificado: o IFC precisa ligar a distribuição ao retorno em cada alça.");
  const branches = junctions.map((node, index) => {
    const supplyPipeIds = path(graphs.supply, source, node), returnPipeIds = path(graphs.return, node, source);
    return { id: index + 1, node, junctionExpressId: [...(componentsByNode.get(node) ?? [])][0] ?? null, supplyPipeIds, returnPipeIds,
      pipeIds: [...new Set([...(supplyPipeIds ?? []), ...(returnPipeIds ?? [])])] };
  });
  if (branches.some(item => !item.supplyPipeIds?.length || !item.returnPipeIds?.length)) return error("Há uma interligação de ida/retorno sem tubos nos dois lados; revise as alças IFC.");

  const serves = new Map([...hotPipes.keys()].map(id => [id, new Set()]));
  for (const branch of branches) for (const id of branch.pipeIds) serves.get(id)?.add(branch.id);
  const circulating = [...serves].filter(([, branchIds]) => branchIds.size).map(([id]) => id);
  if ([...returned].some(id => !serves.get(id).size)) return error("Há tubo marcado como retorno no IFC fora de qualquer alça ligada ao aquecedor; revise as conexões confirmadas.");
  const thermal = new Map();
  for (const id of circulating) {
    const input = pipeInputs.get(id), loss = Number(input?.thermalLossWm), length = Number(input?.lengthM);
    if (!input || String(input.thermalLossWm ?? "").trim() === "" || !Number.isFinite(loss) || loss < 0 || !Number.isFinite(length) || length <= 0 || !String(input.thermalSource ?? "").trim())
      return error(`Tubo Express ID ${id}: informe perda térmica em W/m, comprimento positivo e fonte térmica para o circuito.`);
    thermal.set(id, loss * length);
  }
  const exclusiveLoss = new Map(branches.map(branch => [branch.id, 0]));
  let sharedLossW = 0;
  for (const [id, power] of thermal) {
    const branchIds = serves.get(id);
    if (branchIds.size === 1) exclusiveLoss.set([...branchIds][0], exclusiveLoss.get([...branchIds][0]) + power);
    else sharedLossW += power;
  }
  const exclusiveTotalW = [...exclusiveLoss.values()].reduce((sum, value) => sum + value, 0);
  if (branches.some(branch => exclusiveLoss.get(branch.id) <= 0) || exclusiveTotalW <= 0) return error("Cada alça precisa de perda térmica exclusiva para ratear a perda dos troncos comuns.");
  for (const branch of branches) branch.heatLossW = exclusiveLoss.get(branch.id) + sharedLossW * exclusiveLoss.get(branch.id) / exclusiveTotalW;
  const totalHeatLossW = [...thermal.values()].reduce((sum, value) => sum + value, 0);
  for (const branch of branches) branch.flowLps = branch.heatLossW / (cp * delta) / density * 1000;
  const flowByPipe = Object.fromEntries(circulating.map(id => [id, [...serves.get(id)].reduce((sum, branchId) => sum + branches[branchId - 1].flowLps, 0)]));
  const pipeLosses = {};
  try {
    for (const id of circulating) pipeLosses[id] = calculatePipeLoss(flowByPipe[id], pipeInputs.get(id), temperature);
  } catch (e) { return error(e.message); }
  for (const branch of branches) {
    branch.loopHeadFluidM = branch.pipeIds.reduce((sum, id) => sum + pipeLosses[id].totalLossM, 0);
    branch.loopHeadM = branch.loopHeadFluidM * density / 1000;
    branch.additionalBalancingHeadM = 0;
  }
  const requiredHeadM = Math.max(...branches.map(item => item.loopHeadM));
  const requiredHeadFluidM = Math.max(...branches.map(item => item.loopHeadFluidM));
  for (const branch of branches) branch.additionalBalancingHeadM = requiredHeadM - branch.loopHeadM;
  return { branches, totalHeatLossW, sharedLossW, totalFlowLps: branches.reduce((sum, branch) => sum + branch.flowLps, 0), requiredHeadM, requiredHeadFluidM,
    flowByPipe, pipeLosses, thermalLossWByPipe: Object.fromEntries(thermal), sharedPipeIds: [...serves].filter(([, ids]) => ids.size > 1).map(([id]) => id),
    unservedPipeIds: [...hotPipes.keys()].filter(id => !serves.get(id).size), deltaTC: delta, temperatureC: temperature, cpJkgK: cp,
    method: "Perda térmica por tubo (W/m × comprimento); vazão por alça = potência térmica/(ρ·cp·ΔT). Perdas comuns rateadas proporcionalmente às perdas exclusivas; vazões somadas nos trechos comuns. Perda de carga por Darcy–Weisbach; altura de bomba pela alça crítica, convertida de metros do fluido para m.c.a. pela densidade na temperatura informada. A perda adicional indicada é o ajuste hidráulico necessário nos ramais de menor perda." };
}
