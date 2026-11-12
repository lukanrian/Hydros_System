import { calculatePipeLoss, waterProperties } from "./hydraulic-engine.js";

const gravity = 9.80665;

export function systemKind(label = "") {
  const normalized = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  if (/^agua fria(?:\s|$)/.test(normalized)) return "cold";
  if (/^agua quente(?:\s|$)/.test(normalized)) return "hot";
  if (/^alimentacao(?:\s|$)/.test(normalized)) return "feed";
  return "unknown";
}

const isPipe = item => item.type.toLowerCase() === "ifcpipesegment";
export const isSanitaryTerminal = item => item.type.toLowerCase() === "ifcsanitaryterminal";
const joinsNetworks = item => isSanitaryTerminal(item) || ["ifctank", "ifcboiler"].includes(item.type.toLowerCase());
const labelKinds = item => {
  const labels = [...new Set([...(item.systemLabels ?? []), item.systemLabel, item.system].filter(Boolean))];
  const kinds = [...new Set(labels.map(systemKind).filter(kind => kind !== "unknown"))];
  return kinds.length ? kinds : labels.some(label => /retorno|recircula|\b(?:aq|ida)\b/i.test(label)) ? ["hot"] : [];
};
const unambiguousSystem = (item, system) => {
  const kinds = labelKinds(item);
  return kinds.length === 1 && kinds[0] === system;
};
export function hotWaterPipeRole(item) {
  const labels = [...new Set([...(item.systemLabels ?? []), item.systemLabel, item.system].filter(Boolean))];
  const kinds = [...new Set(labels.map(systemKind).filter(kind => kind !== "unknown"))];
  if (kinds.length > 1) return "ambiguous";
  const hotLabels = labels.filter(label => systemKind(label) === "hot");
  if (!hotLabels.length) {
    if (kinds.length) return null;
    if (labels.some(label => /retorno|recircula/i.test(label))) return "return";
    return labels.some(label => /\b(?:aq|ida)\b/i.test(label)) ? "supply" : null;
  }
  const roles = new Set(hotLabels.map(label => /retorno|recircula/i.test(label) ? "return" : "supply"));
  if (hotLabels.length === 1 && roles.has("supply") && labels.some(label => systemKind(label) === "unknown" && /retorno|recircula/i.test(label))) {
    roles.delete("supply"); roles.add("return");
  }
  const result = [...roles];
  return result.length === 1 ? result[0] : result.length ? "ambiguous" : null;
}
export const pipeInSystem = (item, system) => item.kind === "pipe" &&
  (system === "hot" ? hotWaterPipeRole(item) === "supply" : unambiguousSystem(item, system));

export function candidateInSystem({ from, to }, system) {
  if (!unambiguousSystem(from, system)) return false;
  // Terminais, reservatórios e aquecedores ligam mais de uma rede; quem define a rede da ligação é o tubo.
  if (joinsNetworks(to)) return !to.portSystemExplicit || unambiguousSystem(to, system);
  // Conexões e equipamentos sem rede reconhecida entram pela rede do tubo: a ligação só conta depois de confirmada.
  return unambiguousSystem(to, system) || (!isPipe(to) && !labelKinds(to).length);
}

export function terminalsInSystem(terminals, candidates, system) {
  const connected = new Set(candidates.filter(candidate => isSanitaryTerminal(candidate.to) && candidateInSystem(candidate, system))
    .map(candidate => candidate.to.expressId));
  return terminals.filter(item => connected.has(item.expressId) || labelKinds(item).includes(system));
}

export function solveFlows({ system, systemLabel, boundary, tankMode, refillHours, dailyVolumeL,
  buildingType, records, candidates, decisions, terminals, demands, closedEnds = new Set() }) {
  const error = message => ({ error: message });
  if (!boundary) return error("Defina a origem da rede ativa no modelo 3D.");
  const pipesById = new Map();
  for (const item of records) {
    if (pipeInSystem(item, system) && item.endpoints?.length === 2)
      pipesById.set(item.expressId, item);
  }
  const pipes = [...pipesById.values()];
  if (!pipes.length) return error("A rede ativa não tem tubos com endpoints geométricos.");
  const hours = Number(refillHours);
  const refillFlowLps = Number(dailyVolumeL) / (hours * 3600);
  const maxRefillHours = buildingType === "single" ? 3 : 6;
  if (tankMode && (!boundary.target || !["single", "other"].includes(buildingType) ||
    !Number.isFinite(refillFlowLps) || refillFlowLps <= 0 || hours <= 0 || hours > maxRefillHours))
    return error("Para alimentar o reservatório, informe a tipologia, volume diário e tempo positivos dentro do limite normativo, além da extremidade de chegada selecionada no 3D.");
  const parent = new Map(), find = key => { if (!parent.has(key)) parent.set(key, key); if (parent.get(key) !== key) parent.set(key, find(parent.get(key))); return parent.get(key); };
  const union = (a, b) => { const x = find(a), y = find(b); if (x === y) return false; parent.set(y, x); return true; };
  const pipeKey = (id, end) => "p:" + id + ":" + end, componentKey = id => "c:" + id;
  const portConnections = new Map(), terminalNodes = new Map(), filtered = [];
  const countPort = key => portConnections.set(key, (portConnections.get(key) ?? 0) + 1);
  for (const candidate of candidates) {
    if (decisions[candidate.key] !== "Confirmada" || !candidateInSystem(candidate, system)) continue;
    const { from, to } = candidate;
    const fromIsActivePipe = pipesById.has(from.expressId), toIsActivePipe = isPipe(to) && pipesById.has(to.expressId);
    if (!fromIsActivePipe) {
      if (system === "hot" && isPipe(from) && hotWaterPipeRole(from) === "return" && toIsActivePipe) countPort(pipeKey(to.expressId, to.end));
      continue;
    }
    if (isPipe(to) && !toIsActivePipe) {
      if (system === "hot" && hotWaterPipeRole(to) === "return") countPort(pipeKey(from.expressId, from.end));
      continue;
    }
    const fromKey = pipeKey(from.expressId, from.end), targetIsPipe = to.type.toLowerCase() === "ifcpipesegment", targetIsTerminal = to.type.toLowerCase() === "ifcsanitaryterminal";
    const toKey = targetIsPipe ? pipeKey(to.expressId, to.end) : componentKey(to.expressId);
    filtered.push([fromKey, toKey]);
    if (targetIsTerminal) {
      if (terminalNodes.has(to.expressId)) return error("Terminal " + to.expressId + ": há mais de uma ligação confirmada nesta rede.");
      terminalNodes.set(to.expressId, fromKey);
    }
    for (const key of [fromKey, ...(targetIsPipe ? [toKey] : [])]) countPort(key);
  }
  if ([...portConnections.values()].some(count => count !== 1)) return error("Há extremidades de tubo com mais de uma conexão confirmada; resolva as ambiguidades.");
  const keys = new Set();
  for (const pipe of pipes) { keys.add(pipeKey(pipe.expressId, 0)); keys.add(pipeKey(pipe.expressId, 1)); }
  for (const [a, b] of filtered) { keys.add(a); keys.add(b); }
  for (const [a, b] of filtered) { if (!union(a, b)) return error("A rede revisada contém um ciclo; esta versão só distribui vazões em árvores."); }
  const rootFor = key => find(key), graph = new Map();
  for (const key of keys) { const root = rootFor(key); if (!graph.has(root)) graph.set(root, new Set()); }
  const selfLoops = [], parallels = [], edgePipe = new Map();
  for (const pipe of pipes) {
    const a = rootFor(pipeKey(pipe.expressId, 0)), b = rootFor(pipeKey(pipe.expressId, 1));
    if (a === b) { selfLoops.push(pipe); continue; }
    if (graph.get(a).has(b)) parallels.push(pipe);
    graph.get(a).add(b); graph.get(b).add(a);
    edgePipe.set(a + "|" + b, pipe.expressId); edgePipe.set(b + "|" + a, pipe.expressId);
  }
  const sourceKey = boundary.type.toLowerCase() === "ifcpipesegment" ? pipeKey(boundary.expressId, boundary.end ?? 0) : componentKey(boundary.expressId), source = rootFor(sourceKey);
  const targetKey = tankMode ? pipeKey(boundary.target.expressId, boundary.target.end) : null, destination = targetKey ? rootFor(targetKey) : null;
  if (!graph.has(source)) return error("A origem selecionada não pertence à rede hidráulica classificada como " + (systemLabel ?? system) + ".");
  if (tankMode && (!graph.has(destination) || destination === source || portConnections.has(targetKey))) return error("A chegada ao reservatório deve ser outra extremidade de tubo aberta na rede ativa.");
  const parentNode = new Map([[source, null]]), order = [source];
  for (let i = 0; i < order.length; i++) for (const next of graph.get(order[i]) ?? []) {
    if (!parentNode.has(next)) { parentNode.set(next, order[i]); order.push(next); }
    else if (parentNode.get(order[i]) !== next) return error("A rede revisada contém um ciclo que fecha no tubo Express ID " + edgePipe.get(order[i] + "|" + next) + "; esta versão só distribui vazões em árvores. Rejeite a ligação do ramo reserva ou de bypass para abrir o ciclo.");
  }
  // O cálculo cobre a rede alimentada pela origem. Outras redes da mesma classe (reúso, outra prumada) ficam de
  // fora e são contadas no resultado; um ramal desligado por engano só passa se não tiver ponto de utilização no cenário.
  const reachedPipe = pipe => parentNode.has(rootFor(pipeKey(pipe.expressId, 0)));
  const reached = pipes.filter(reachedPipe);
  const selfLoop = selfLoops.find(reachedPipe), parallel = parallels.find(reachedPipe);
  if (selfLoop) return error("As conexões confirmadas fecham o tubo Express ID " + selfLoop.expressId + " sobre o próprio nó; revise as pontas confirmadas.");
  if (parallel) return error("A rede revisada contém trechos em paralelo no tubo Express ID " + parallel.expressId + "; esta versão só distribui vazões em árvores.");
  if (tankMode && !parentNode.has(destination)) return error("A chegada ao reservatório não está ligada à origem pelas conexões confirmadas.");
  const unconnected = reached.flatMap(pipe => [0, 1].map(end => pipeKey(pipe.expressId, end))).filter(key => !portConnections.has(key) && key !== sourceKey && key !== targetKey);
  const openPorts = unconnected.filter(key => !closedEnds.has(key));
  if (openPorts.length) return error("Há " + openPorts.length + " extremidade(s) de tubo sem conexão confirmada na rede alimentada pela origem; confirme a ligação ou declare a ponta sem vazão.");
  const active = tankMode ? [] : terminals.filter(item => demands[item.expressId]?.include === true &&
    (terminalNodes.has(item.expressId) || labelKinds(item).includes(system)));
  if (!tankMode && !active.length) return error("Marque ao menos um ponto de utilização no cenário da rede ativa.");
  const demandAt = new Map();
  if (tankMode) demandAt.set(destination, refillFlowLps);
  for (const terminal of active) {
    const values = demands[terminal.expressId], flow = Number(values.flowLps);
    if (!Number.isFinite(flow) || flow <= 0 || !String(values.source ?? "").trim()) return error("Cada ponto incluído precisa de vazão positiva e fonte do valor.");
    const key = terminalNodes.get(terminal.expressId);
    if (!key) return error("O terminal Express ID " + terminal.expressId + " não tem conexão confirmada no grafo.");
    const node = rootFor(key);
    if (!parentNode.has(node)) return error("O terminal Express ID " + terminal.expressId + " não é alcançado a partir da origem; revise as conexões ou retire-o do cenário.");
    demandAt.set(node, (demandAt.get(node) ?? 0) + flow);
  }
  const subtree = new Map(demandAt);
  for (const node of order.slice(1).reverse()) { const p = parentNode.get(node); subtree.set(p, (subtree.get(p) ?? 0) + (subtree.get(node) ?? 0)); }
  const byRoot = new Map();
  for (const pipe of reached) { const a = rootFor(pipeKey(pipe.expressId, 0)), b = rootFor(pipeKey(pipe.expressId, 1)); const child = parentNode.get(a) === b ? a : parentNode.get(b) === a ? b : null; if (child) byRoot.set(child, pipe.expressId); }
  const result = new Map(), paths = [];
  for (const [child, expressId] of byRoot) {
    result.set(expressId, subtree.get(child) ?? 0);
    paths.push({ expressId, upstream: parentNode.get(child), downstream: child });
  }
  if (result.size !== reached.length) return error("Não foi possível associar todos os tubos da rede à árvore de caminhos da origem.");
  if (tankMode && [...result.values()].some(flow => flow <= 0)) return error("A alimentação do reservatório deve formar um único caminho, sem ramais ativos fora do alimentador.");
  const declaredClosedEnds = unconnected.map(key => { const [, expressId, end] = key.split(":"); return { expressId: Number(expressId), end: Number(end) }; });
  const elevations = new Map();
  for (const pipe of reached) for (const end of [0, 1]) {
    const node = rootFor(pipeKey(pipe.expressId, end)), z = pipe.endpoints[end]?.[2];
    if (Number.isFinite(z)) { const entry = elevations.get(node) ?? { sum: 0, count: 0 }; entry.sum += z; entry.count++; elevations.set(node, entry); }
  }
  return { result, paths, elevations: Object.fromEntries([...elevations].map(([node, value]) => [node, value.sum / value.count])), terminalNodes: Object.fromEntries([...terminalNodes].map(([id, key]) => [id, rootFor(key)])), parentNode: Object.fromEntries(parentNode), order, source, destination, tankMode, totalLps: subtree.get(source) ?? 0, terminalCount: active.length, activeTerminalIds: active.map(item => item.expressId), unreachedPipes: pipes.length - reached.length, declaredClosedEnds, method: tankMode ? "Volume diário explicitamente informado dividido pelo tempo de reposição escolhido; vazão distribuída no caminho fonte-reservatório." : "Soma das vazões máximas explicitamente marcadas no cenário, agregadas a jusante em árvore radial." };
}
export function solvePressures({ flowCalculation, system, boundary, temperatureInput,
  utilityPressure, utilityStaticPressure, utilityFlow, pipeInputs, demands }) {
  if (!flowCalculation || flowCalculation.error) return { error: "Calcule primeiro as vazões no grafo revisado." };
  const temperature = Number(temperatureInput);
  if (String(temperatureInput ?? "").trim() === "") return { error: "Informe a temperatura da água para obter densidade e viscosidade." };
  let fluid;
  try { fluid = waterProperties(temperature); } catch (error) { return { error: error.message }; }
  const feed = system === "feed", sourcePressure = Number(feed ? utilityPressure : boundary?.headM), staticSourcePressure = Number(feed ? utilityStaticPressure : boundary?.staticHeadM), sourceElevation = Number(boundary?.elevationM);
  const sourcePressureInput = feed ? utilityPressure : boundary?.headM, staticPressureInput = feed ? utilityStaticPressure : boundary?.staticHeadM;
  if (!boundary || [sourcePressure, staticSourcePressure, sourceElevation].some(value => !Number.isFinite(value)) || [sourcePressureInput, staticPressureInput, boundary.elevationM].some(value => String(value ?? "").trim() === "")) return { error: "Informe a pressão dinâmica, pressão estática máxima e cota da origem." };
  if (sourcePressure < 0 || staticSourcePressure < sourcePressure) return { error: "As pressões de origem devem ser não negativas e a pressão estática máxima deve ser maior ou igual à dinâmica." };
  if (feed) {
    const referenceFlow = Number(utilityFlow);
    if (!Number.isFinite(referenceFlow) || referenceFlow <= 0) return { error: "Informe uma vazão de referência positiva para a pressão dinâmica da concessionária." };
    if (Math.abs(referenceFlow - flowCalculation.totalLps) > 0.0005) return { error: "A pressão da concessionária só pode ser usada quando sua vazão de referência coincide com a vazão total calculada; não há curva da rede pública para interpolar." };
  }
  const sourceIfcElevationM = flowCalculation.elevations[flowCalculation.source];
  if (!Number.isFinite(sourceIfcElevationM)) return { error: "Cota geométrica ausente no nó de origem. Verifique as conexões e as unidades do IFC." };
  const elevationOffsetM = sourceElevation - sourceIfcElevationM;
  const elevationAt = node => node === flowCalculation.source ? sourceElevation : flowCalculation.elevations[node] + elevationOffsetM;
  // Pressões em m.c.a. convencional (1 m.c.a. = 9,80665 kPa). Cotas e perdas são metros de coluna do fluido
  // na temperatura de cálculo, por isso cada conversão entre carga e pressão passa pela densidade.
  const mcaPerMetre = fluid.density / 1000, pressureAt = (head, elevation) => (head - elevation) * mcaPerMetre;
  const losses = {}, hgl = new Map([[flowCalculation.source, sourceElevation + sourcePressure / mcaPerMetre]]), pressureLimit = 10 / gravity, networkLimit = 5 / gravity, staticLimit = 400 / gravity, failures = [], pathByDownstream = new Map(flowCalculation.paths.map(item => [item.downstream, item]));
  for (const node of flowCalculation.order.slice(1)) {
    const upstream = flowCalculation.parentNode[node], path = pathByDownstream.get(node);
    if (!path || !Number.isFinite(hgl.get(upstream))) return { error: "O caminho de pressão não pôde ser associado a todos os trechos." };
    const input = pipeInputs.get(path.expressId);
    if (!input) return { error: "O tubo Express ID " + path.expressId + " não está disponível no modelo ativo." };
    if (!String(input.source ?? "").trim()) return { error: "Registre a fonte física do tubo Express ID " + path.expressId + "." };
    let loss;
    try { loss = calculatePipeLoss(flowCalculation.result.get(path.expressId), input, temperature); }
    catch (error) { return { error: "Tubo Express ID " + path.expressId + ": " + error.message }; }
    const elevation = elevationAt(node);
    if (!Number.isFinite(elevation)) return { error: "Cota geométrica ausente no nó a jusante do tubo Express ID " + path.expressId + "." };
    const downstreamHgl = hgl.get(upstream) - loss.totalLossM, dynamicPressure = pressureAt(downstreamHgl, elevation);
    hgl.set(node, downstreamHgl);
    const upstreamElevation = elevationAt(upstream);
    losses[path.expressId] = { ...loss, diameterMm: Number(input.diameterMm), lengthM: Number(input.lengthM), roughnessMm: Number(input.roughnessMm), localK: Number(input.k), dataSource: input.source, upstreamPressureMca: pressureAt(hgl.get(upstream), upstreamElevation), downstreamPressureMca: dynamicPressure, networkMinimumMca: networkLimit };
    if (loss.velocity > 3) failures.push("Tubo " + path.expressId + ": velocidade acima de 3 m/s; avaliar limites do projeto e golpe de aríete.");
    if (dynamicPressure < networkLimit) failures.push("Tubo " + path.expressId + ": pressão dinâmica abaixo de 5 kPa.");
  }
  const terminalsResult = [];
  for (const terminalId of flowCalculation.activeTerminalIds) {
    const node = flowCalculation.terminalNodes[terminalId], elevation = elevationAt(node);
    const available = pressureAt(hgl.get(node), elevation), demand = demands[terminalId];
    const pressureInput = String(demand.pressureMca ?? "").trim();
    if (pressureInput && (!Number.isFinite(Number(pressureInput)) || Number(pressureInput) < 0)) return { error: "Pressão requerida inválida no terminal Express ID " + terminalId + "." };
    const required = Math.max(pressureInput ? Number(pressureInput) : 0, pressureLimit), staticPressure = staticSourcePressure + (sourceElevation - elevation) * mcaPerMetre;
    if (!Number.isFinite(available)) return { error: "Pressão não determinável no terminal Express ID " + terminalId + "." };
    const dynamicOk = available >= required, staticOk = staticPressure <= staticLimit;
    const result = { expressId: terminalId, available, required, staticPressure,
      staticPressureKpa: staticPressure * gravity,
      specified: pressureInput !== "", passed: dynamicOk && staticOk };
    terminalsResult.push(result);
    if (!dynamicOk) failures.push("Terminal " + terminalId + ": pressão dinâmica abaixo da requerida.");
    if (!staticOk) failures.push("Terminal " + terminalId + ": pressão estática acima de 400 kPa.");
  }
  let destinationResult = null;
  if (flowCalculation.tankMode) {
    const node = flowCalculation.destination, elevation = elevationAt(node), available = pressureAt(hgl.get(node), elevation), staticPressure = staticSourcePressure + (sourceElevation - elevation) * mcaPerMetre;
    destinationResult = { available, staticPressure, elevation };
    if (!Number.isFinite(available)) return { error: "Pressão não determinável na chegada ao reservatório." };
    if (available < networkLimit) failures.push("Chegada ao reservatório: pressão dinâmica abaixo de 5 kPa.");
    if (staticPressure > staticLimit) failures.push("Chegada ao reservatório: pressão estática acima de 400 kPa.");
  }
  if (sourcePressure < networkLimit) failures.push("Pressão dinâmica na origem abaixo de 5 kPa.");
  if (system === "hot") failures.push("Resultado parcial: retorno e balanceamento da água quente não estão modelados e precisam ser verificados.");
  return { pipes: losses, terminals: terminalsResult, destination: destinationResult, sourcePressureMca: sourcePressure, staticSourcePressureMca: staticSourcePressure, sourceElevationM: sourceElevation, sourceIfcElevationM, elevationOffsetM, mcaPerMetre, failures, temperature, density: fluid.density, viscosity: fluid.viscosity, method: "Darcy–Weisbach com fator de atrito Churchill; perdas localizadas por K total informado; propriedades da água pela temperatura de entrada. Pressões em m.c.a. convencional (1 m.c.a. = 9,80665 kPa), convertidas de carga pela densidade na temperatura de cálculo." };
}
