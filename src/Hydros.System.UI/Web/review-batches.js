const hasValue = value => String(value ?? "").trim() !== "";

const isPipe = item => item.type.toLowerCase() === "ifcpipesegment";
const endKey = item => `p:${item.expressId}:${item.end}`;

export function pendingConnectionsForBatch(candidates, decisions, inSystem, canConfirm, reserved) {
  // Peças candidatas em cada ponta de tubo. Duas pontas que chegam à mesma peça já formam o mesmo nó,
  // então o candidato tubo–tubo entre elas é redundante e não deve contar como disputa.
  const components = new Map();
  for (const { key, from, to } of candidates) {
    if (decisions[key] === "Rejeitada" || isPipe(to)) continue;
    if (!components.has(endKey(from))) components.set(endKey(from), new Set());
    components.get(endKey(from)).add(to.expressId);
  }
  const sharesComponent = (from, to) => {
    const other = components.get(endKey(to));
    return Boolean(other) && [...(components.get(endKey(from)) ?? [])].some(id => other.has(id));
  };
  const counts = new Map();
  const pending = [];
  for (const candidate of candidates) {
    const decision = decisions[candidate.key];
    if (decision === "Rejeitada") continue;
    const { from, to } = candidate;
    if (decision !== "Confirmada" && isPipe(to) && sharesComponent(from, to)) continue;
    const keys = [endKey(from)];
    if (isPipe(to)) keys.push(endKey(to));
    // As duas pontas do mesmo tubo no mesmo destino fechariam o tubo sobre si mesmo (ou em paralelo com outro).
    keys.push(`pair:${Math.min(from.expressId, to.expressId)}:${Math.max(from.expressId, to.expressId)}`);
    for (const endpoint of [from, to]) {
      if (endpoint.portId != null) keys.push(`port:${endpoint.portId}`);
    }
    const belongs = inSystem(candidate);
    if (belongs && to.type.toLowerCase() === "ifcsanitaryterminal") keys.push(`terminal:${to.expressId}`);
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (decision !== "Confirmada" && belongs && canConfirm(candidate)) pending.push({ candidate, keys });
  }
  return pending.filter(({ keys }) => keys.every(key => counts.get(key) === 1 && !reserved.has(key)))
    .map(({ candidate }) => candidate);
}

export function pipeBatchGroups(items, getInput) {
  const groups = new Map();
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.expressId)) continue;
    seen.add(item.expressId);
    const names = [...new Set((item.materials ?? []).map(value => String(value).trim()).filter(Boolean))].sort();
    const property = item.properties?.find(value => value.name === "Material" && hasValue(value.value));
    if (!names.length && property) names.push(String(property.value).trim());
    const material = names.join(" + ") || "Material IFC não identificado";
    const diameter = Number(getInput(item).diameterMm);
    const key = Number.isFinite(diameter) && diameter > 0 ? diameter.toFixed(6) : "missing";
    if (!groups.has(material)) groups.set(material, new Map());
    const diameters = groups.get(material);
    if (!diameters.has(key)) diameters.set(key, []);
    diameters.get(key).push(item.expressId);
  }
  return groups;
}

export function fillPipeBatch(ids, saved, fields) {
  const values = Object.entries({ roughnessMm: fields.roughnessMm, k: fields.k })
    .filter(([, value]) => hasValue(value));
  const source = String(fields.source ?? "").trim();
  if (!values.length || !source || values.some(([, value]) => !Number.isFinite(Number(value)) || Number(value) < 0)) {
    return { error: "Informe uma fonte e pelo menos um valor não negativo." };
  }
  const updates = new Map();
  for (const id of ids) {
    const input = saved[id] ?? {};
    if (hasValue(input.source) && input.source.trim() !== source) continue;
    const missing = values.filter(([field]) => !hasValue(input[field]));
    if (missing.length) updates.set(id, { ...input, ...Object.fromEntries(missing), source: hasValue(input.source) ? input.source : source });
  }
  return { updates };
}
