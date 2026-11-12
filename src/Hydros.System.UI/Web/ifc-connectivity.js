const value = item => item?.value ?? item ?? null;
const reference = item => item?.value ?? item?.expressID ?? null;
const types = { DOMESTICCOLDWATER: "Água fria", DOMESTICHOTWATER: "Água quente" };
const systemName = text => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

function namedSystem(name) {
  const text = systemName(name);
  if (/^(agua fria|domestic cold water|cold water)\b/.test(text)) return types.DOMESTICCOLDWATER;
  if (/^(agua quente|domestic hot water|hot water)\b/.test(text)) return types.DOMESTICHOTWATER;
  return /^(alimentacao|water supply)\b/.test(text) ? "Alimentação" : null;
}

const distance = (a, b) => a && b ? Math.hypot(...a.map((coordinate, index) => coordinate - b[index])) : null;
const pipe = item => item.type.toLowerCase() === "ifcpipesegment";
const labels = items => [...new Set(items.map(item => item.label))];

export function readIfcConnectivity(api, model, products, readPortPoint) {
  function* lines(name) {
    const type = api.GetTypeCodeFromName(name);
    const ids = type && api.GetLineIDsWithType(model, type);
    for (let i = 0; ids && i < ids.size(); i++) yield api.GetLine(model, ids.get(i), false);
  }

  const groups = new Map();
  for (const className of ["IfcSystem", "IfcDistributionSystem"]) {
    for (const group of lines(className.toUpperCase())) {
      const name = String(value(group.Name) || value(group.LongName) || "").trim();
      const named = namedSystem(name) || namedSystem(value(group.LongName));
      const typed = types[value(group.PredefinedType)];
      const label = named === "Alimentação" ? named : typed || named || name;
      if (label) groups.set(group.expressID, { label, source: `IfcRelAssignsToGroup · ${className} #${group.expressID}${name ? " · " + name : ""}` });
    }
  }
  const membership = new Map();
  for (const relation of lines("IFCRELASSIGNSTOGROUP")) {
    const group = groups.get(reference(relation.RelatingGroup));
    if (!group) continue;
    for (const related of relation.RelatedObjects ?? []) {
      const id = reference(related);
      const assigned = membership.get(id) ?? [];
      assigned.push(group);
      membership.set(id, assigned);
    }
  }
  for (const item of products.values()) {
    const assigned = membership.get(item.expressId) ?? [];
    const classified = assigned.filter(entry => namedSystem(entry.label));
    const explicit = classified.length ? classified : assigned;
    const legacy = item.systemLabel;
    const legacyKind = namedSystem(legacy);
    const primary = classified.find(entry => namedSystem(entry.label) === legacyKind) ?? classified[0];
    if (primary || (!legacy && explicit.length)) {
      item.systemLabel = (primary ?? explicit[0]).label;
      item.systemSource = explicit.map(entry => entry.source).join(" / ");
    }
    item.systemLabels = labels(explicit);
    if (legacy && (!classified.length || classified.some(entry => namedSystem(entry.label) === legacyKind)))
      item.systemLabels = [...new Set([legacy, ...item.systemLabels])];
  }

  const ports = new Map([...lines("IFCDISTRIBUTIONPORT")].map(port => [port.expressID, port]));
  const owners = new Map();
  const register = (portId, ownerId) => {
    if (!ports.has(portId)) return;
    if (!owners.has(portId)) owners.set(portId, ownerId);
    else if (owners.get(portId) !== ownerId) owners.set(portId, null);
  };
  for (const relation of lines("IFCRELNESTS")) {
    for (const child of relation.RelatedObjects ?? [])
      register(reference(child), reference(relation.RelatingObject));
  }
  for (const relation of lines("IFCRELCONNECTSPORTTOELEMENT"))
    register(reference(relation.RelatingPort), reference(relation.RelatedElement));

  const byPort = new Map(), byProduct = new Map();
  for (const [portId, port] of ports) {
    const item = products.get(owners.get(portId));
    if (!item) continue;
    const assigned = (membership.get(portId) ?? []).filter(entry => namedSystem(entry.label));
    const typed = types[value(port.SystemType)];
    const systemLabels = assigned.length ? labels(assigned) : typed ? [typed] : item.systemLabels;
    const record = {
      item, portId, end: null, point: readPortPoint(port),
      systemLabels, system: assigned.length || typed ? systemLabels[0] : item.systemLabel,
      portSystemExplicit: assigned.length > 0 || Boolean(typed)
    };
    byPort.set(portId, record);
    const records = byProduct.get(item.expressId) ?? [];
    records.push(record);
    byProduct.set(item.expressId, records);
  }
  for (const records of byProduct.values()) {
    const item = records[0].item;
    if (!pipe(item)) continue;
    const located = records.filter(port => port.point);
    if (!item.endpoints && records.length === 2 && located.length === 2 &&
        distance(located[0].point, located[1].point) > 1e-6) {
      located.sort((a, b) => a.portId - b.portId);
      item.endpoints = located.map(port => port.point);
    }
    if (!item.endpoints) continue;
    const closest = [[], []];
    for (const port of located) {
      const [first, last] = item.endpoints.map(point => distance(port.point, point));
      if (Math.min(first, last) > 0.05 || Math.abs(first - last) < 1e-6) continue;
      closest[first < last ? 0 : 1].push(port);
    }
    closest.forEach((matches, end) => { if (matches.length === 1) matches[0].end = end; });
  }
  const relations = [...lines("IFCRELCONNECTSPORTS")].map(line => ({
    id: line.expressID, fromId: reference(line.RelatingPort), toId: reference(line.RelatedPort)
  }));
  return { byPort, byProduct, relations, systemCount: groups.size };
}

// Pontas de tubo sem peça candidata costumam terminar dentro de uma peça cuja origem fica longe (registros,
// bombas, conexões grandes). `boxes` traz a caixa envolvente da malha de cada produto no referencial do visor,
// deslocado em relação às coordenadas IFC; o deslocamento é medido nos próprios tubos e conferido antes do uso.
export function addVolumeCandidates(products, candidates, boxes, tolerance = 0.005) {
  const pipes = [...products.values()].filter(item => pipe(item) && item.endpoints?.length === 2 && boxes.has(item.expressId));
  const offsets = pipes.map(item => {
    const box = boxes.get(item.expressId);
    return [0, 1, 2].map(axis => (box[axis] + box[axis + 3]) / 2 - (item.endpoints[0][axis] + item.endpoints[1][axis]) / 2);
  });
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  // A mediana vem dos tubos retos (centro da malha = meio do eixo). A conferência vale também para tubos curvos:
  // com o deslocamento certo, as duas extremidades de cada tubo caem dentro da própria malha.
  const shift = [0, 1, 2].map(axis => offsets.length ? median(offsets.map(offset => offset[axis])) : 0);
  const inside = (point, box) => [0, 1, 2].every(axis =>
    point[axis] + shift[axis] >= box[axis] - tolerance && point[axis] + shift[axis] <= box[axis + 3] + tolerance);
  const consistent = pipes.filter(item => item.endpoints.every(point => inside(point, boxes.get(item.expressId)))).length;
  const result = { added: 0, calibrated: pipes.length >= 3 && consistent >= pipes.length * 0.9, consistent, pipes: pipes.length };
  if (!result.calibrated) return result;

  // Só pontas que ainda não chegam a nenhuma peça: um candidato tubo–tubo não diz qual registro ou conexão
  // está entre os dois tubos, e sem a peça dos dois lados a revisão em lote fica em disputa.
  const taken = new Set(), linked = new Set();
  for (const { from, to } of candidates) {
    if (to.type.toLowerCase() === "ifcpipesegment") continue;
    taken.add(`${from.expressId}:${from.end}`);
    linked.add(`${from.expressId}:${from.end}:${to.expressId}`);
  }
  const components = [...products.values()].filter(item => !pipe(item) && boxes.has(item.expressId));
  const endpoint = (item, end) => ({
    id: item.globalId, expressId: item.expressId, type: item.type, end, system: item.systemLabel ?? null,
    systemLabels: item.systemLabels, portId: null, portSystemExplicit: false
  });
  for (const item of pipes) item.endpoints.forEach((point, end) => {
    if (taken.has(`${item.expressId}:${end}`)) return;
    for (const target of components) {
      // a outra ponta deste tubo já chega a esta peça: as duas não podem estar ligadas ao mesmo lugar
      if (linked.has(`${item.expressId}:${1 - end}:${target.expressId}`)) continue;
      if (!inside(point, boxes.get(target.expressId))) continue;
      candidates.push({
        key: [item.expressId, end, target.expressId, ""].join(":"), from: endpoint(item, end), to: endpoint(target, null),
        distance_m: distance(point, target.origin), evidence: "Extremidade dentro do volume da peça", source: "geometry", decision: "Pendente"
      });
      result.added++;
    }
  });
  return result;
}

export function buildConnectionCandidates(products, { byPort, byProduct, relations }) {
  const searchRadius = 0.05, directTouch = 0.001;
  const candidates = new Map(), occupied = new Set(), cells = new Map();
  const endId = record => pipe(record.item) ? `${record.item.expressId}:${record.end}` : `port:${record.portId}`;
  const endpoint = record => ({
    id: record.item.globalId, expressId: record.item.expressId, type: record.item.type, end: record.end,
    system: record.system ?? null, systemLabels: record.systemLabels, portId: record.portId,
    portSystemExplicit: record.portSystemExplicit ?? false
  });
  function add(from, to, source, evidence) {
    const key = [from.item.expressId, from.end, to.item.expressId, to.end ?? "",
      ...(!pipe(to.item) && to.portId != null ? [`porta-${to.portId}`] : [])].join(":");
    if (!candidates.has(key))
      candidates.set(key, { key, from: endpoint(from), to: endpoint(to), distance_m: distance(from.point, to.point), evidence, source, decision: "Pendente" });
  }
  const isMappable = record => record && (!pipe(record.item) || record.end != null);
  let unresolvedRelations = 0;
  for (const relation of relations) {
    let from = byPort.get(relation.fromId), to = byPort.get(relation.toId);
    if (!from && !to) continue;
    for (const record of [from, to]) if (isMappable(record)) occupied.add(endId(record));
    if (!isMappable(from) || !isMappable(to) || from.item === to.item || (!pipe(from.item) && !pipe(to.item))) {
      unresolvedRelations++;
      continue;
    }
    if (!pipe(from.item) || (pipe(to.item) && from.item.expressId > to.item.expressId))
      [from, to] = [to, from];
    add(from, to, "ifc-ports", `IfcRelConnectsPorts #${relation.id} · portas #${from.portId} e #${to.portId}`);
  }

  const cell = point => point.map(coordinate => Math.floor(coordinate / searchRadius));
  function index(record) {
    if (occupied.has(endId(record))) return;
    const key = cell(record.point).join(":");
    const bucket = cells.get(key) ?? [];
    bucket.push(record);
    cells.set(key, bucket);
  }
  for (const item of products.values()) {
    const records = byProduct.get(item.expressId) ?? [];
    const defaults = { item, end: null, portId: null, system: item.systemLabel, systemLabels: item.systemLabels };
    if (pipe(item)) {
      item.endpoints?.forEach((point, end) => index({
        ...(records.find(record => record.end === end) ?? defaults), end, point
      }));
    } else {
      const located = records.filter(record => record.point);
      for (const record of located) index(record);
      // shortcut: fittings without placed IFC ports still use their origin, until a reliable opening can be extracted.
      if (!located.length && item.origin && !records.some(record => occupied.has(endId(record))))
        index({ ...defaults, point: item.origin });
    }
  }
  const adjacent = [-1, 0, 1];
  for (const bucket of cells.values()) for (const from of bucket.filter(record => pipe(record.item))) {
    const [x, y, z] = cell(from.point);
    for (const dx of adjacent) for (const dy of adjacent) for (const dz of adjacent) {
      const nearby = cells.get([x + dx, y + dy, z + dz].join(":")) ?? [];
      for (const to of nearby) {
        if (from.item === to.item || (pipe(to.item) && from.item.expressId > to.item.expressId)) continue;
        const separation = distance(from.point, to.point);
        if (separation > searchRadius) continue;
        const evidence = pipe(to.item)
          ? separation <= directTouch ? "Extremidades em contato geométrico" : "Extremidades próximas"
          : to.portId != null ? `Extremidade próxima à porta IFC #${to.portId}` : "Extremidade próxima à origem do componente";
        add(from, to, "geometry", evidence);
      }
    }
  }
  // Um tubo mais curto que o raio de busca fica com as duas pontas perto da mesma peça, mas só uma pode estar
  // ligada a ela. Fica a ponta mais próxima; com distâncias praticamente iguais as duas seguem para a revisão.
  const byPair = new Map();
  for (const candidate of candidates.values()) {
    if (candidate.source !== "geometry" || pipe(candidate.to)) continue;
    const pair = `${candidate.from.expressId}>${candidate.to.expressId}`;
    if (!byPair.has(pair)) byPair.set(pair, []);
    byPair.get(pair).push(candidate);
  }
  for (const group of byPair.values()) {
    const nearest = end => Math.min(...group.filter(candidate => candidate.from.end === end).map(candidate => candidate.distance_m));
    const [first, second] = [nearest(0), nearest(1)];
    if (!Number.isFinite(first) || !Number.isFinite(second) || Math.abs(first - second) <= 0.005) continue;
    const farther = first > second ? 0 : 1;
    for (const candidate of group) if (candidate.from.end === farther) candidates.delete(candidate.key);
  }
  return {
    unresolvedRelations,
    candidates: [...candidates.values()].sort((a, b) =>
      (a.source === b.source ? 0 : a.source === "ifc-ports" ? -1 : 1) ||
      (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity) || a.key.localeCompare(b.key))
  };
}
