import * as WebIFC from "./lib/web-ifc-api.js";
import { addVolumeCandidates, buildConnectionCandidates, readIfcConnectivity } from "./ifc-connectivity.js";

// Reservatórios e aquecedores entram como equipamentos: são onde as redes começam ou terminam.
const typeNames = ["IFCPIPESEGMENT", "IFCPIPEFITTING", "IFCVALVE", "IFCPUMP", "IFCFLOWTERMINAL", "IFCFLOWMETER", "IFCTANK", "IFCBOILER"];
const spatialTypes = ["IFCBUILDINGSTOREY", "IFCBUILDING", "IFCSITE"];
let modelVersion = 0;

function value(item) { return item?.value ?? item ?? null; }
function reference(item) { return item?.value ?? item?.expressID ?? null; }
function unitName(api, unit) {
  if (!unit) return "unidade não identificada";
  if (api.GetNameFromTypeCode(unit.type).toLowerCase() !== "ifcsiunit") return api.GetNameFromTypeCode(unit.type);
  const prefix = value(unit.Prefix), name = value(unit.Name);
  return `${prefix && prefix !== "NULL" ? prefix.toLowerCase() : ""}${String(name ?? "").toLowerCase()}`;
}
function unitToMetres(api, unit) {
  if (!unit || api.GetNameFromTypeCode(unit.type).toLowerCase() !== "ifcsiunit" || value(unit.UnitType) !== "LENGTHUNIT" || value(unit.Name) !== "METRE") return null;
  const scale = { NULL: 1, EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 };
  const factor = scale[value(unit.Prefix) ?? "NULL"];
  return factor == null ? null : factor;
}
function primitive(item) {
  if (item == null) return null;
  if (typeof item !== "object") return item;
  if ("value" in item) return item.value;
  return item.type ?? JSON.stringify(item);
}
const add = (a, b) => a.map((v, i) => v + b[i]);
const multiply = (v, n) => v.map(component => component * n);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = v => { const length = Math.hypot(...v); return length > 1e-12 ? multiply(v, 1 / length) : null; };
function makeEndpointReader(api, model) {
  const axisCache = new Map();
  function axisTransform(id, point) {
    if (!id) return null;
    let frame = axisCache.get(id);
    if (!frame) {
      const axis = api.GetLine(model, id, false), location = api.GetLine(model, reference(axis?.Location), false);
      const origin = location?.Coordinates?.map(value) ?? [0, 0, 0];
      const z = axis?.Axis ? normalize(api.GetLine(model, reference(axis.Axis), false)?.DirectionRatios?.map(value) ?? [0, 0, 1]) : [0, 0, 1];
      const rawX = axis?.RefDirection ? normalize(api.GetLine(model, reference(axis.RefDirection), false)?.DirectionRatios?.map(value) ?? [1, 0, 0]) : [1, 0, 0];
      if (!z || !rawX) return null;
      const x = normalize(rawX.map((component, i) => component - z[i] * dot(rawX, z))), y = x && normalize(cross(z, x));
      if (!x || !y) return null;
      frame = { origin, x, y, z }; axisCache.set(id, frame);
    }
    return add(frame.origin, add(multiply(frame.x, point[0]), add(multiply(frame.y, point[1]), multiply(frame.z, point[2]))));
  }
  function placementTransform(id, point, seen = new Set()) {
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const placement = api.GetLine(model, id, false);
    if (api.GetNameFromTypeCode(placement?.type).toLowerCase() !== "ifclocalplacement") return null;
    const placed = axisTransform(reference(placement.RelativePlacement), point);
    if (!placed) return null;
    return placement.PlacementRelTo ? placementTransform(reference(placement.PlacementRelTo), placed, seen) : placed;
  }
  function polylineEndpoints(id) {
    const curve = api.GetLine(model, id, false), type = api.GetNameFromTypeCode(curve?.type).toLowerCase();
    if (type === "ifcpolyline") {
      const points = curve.Points ?? [];
      if (points.length < 2) return null;
      const read = ref => api.GetLine(model, reference(ref), false)?.Coordinates?.map(value);
      return [read(points[0]), read(points[points.length - 1])];
    }
    if (type !== "ifccompositecurve" || !curve.Segments?.length) return null;
    const segmentPoints = segmentRef => {
      const segment = api.GetLine(model, reference(segmentRef), false), ends = polylineEndpoints(reference(segment?.ParentCurve));
      return ends && (value(segment?.SameSense) === false ? ends.reverse() : ends);
    };
    const first = segmentPoints(curve.Segments[0]), last = segmentPoints(curve.Segments[curve.Segments.length - 1]);
    return first && last ? [first[0], last[1]] : null;
  }
  const read = expressId => {
    const product = api.GetLine(model, expressId, false), placementId = reference(product?.ObjectPlacement);
    const shape = api.GetLine(model, reference(product?.Representation), false);
    const origin = placementTransform(placementId, [0, 0, 0]);
    for (const representationRef of shape?.Representations ?? []) {
      const representation = api.GetLine(model, reference(representationRef), false);
      for (const itemRef of representation?.Items ?? []) {
        const solid = api.GetLine(model, reference(itemRef), false);
        if (api.GetNameFromTypeCode(solid?.type).toLowerCase() === "ifcsweptdisksolid") {
          const points = polylineEndpoints(reference(solid.Directrix));
          const start = points?.[0]?.length >= 2 ? [...points[0], 0].slice(0, 3) : null;
          const end = points?.[1]?.length >= 2 ? [...points[1], 0].slice(0, 3) : null;
          const worldStart = start && placementTransform(placementId, start), worldEnd = end && placementTransform(placementId, end);
          if (worldStart && worldEnd) return { endpoints: [worldStart, worldEnd], origin };
        }
        if (api.GetNameFromTypeCode(solid?.type).toLowerCase() !== "ifcextrudedareasolid") continue;
        const direction = api.GetLine(model, reference(solid.ExtrudedDirection), false)?.DirectionRatios?.map(value);
        const depth = value(solid.Depth), positionId = reference(solid.Position);
        if (!direction || !Number.isFinite(depth)) continue;
        const start = axisTransform(positionId, [0, 0, 0]);
        const end = axisTransform(positionId, multiply(direction, depth));
        const worldStart = start && placementTransform(placementId, start), worldEnd = end && placementTransform(placementId, end);
        if (worldStart && worldEnd) return { endpoints: [worldStart, worldEnd], origin };
      }
    }
    return { endpoints: null, origin };
  };
  read.placementOrigin = placementId => placementTransform(placementId, [0, 0, 0]);
  return read;
}

self.onmessage = async ({ data }) => {
  if (data.type !== "load") return;
  const version = ++modelVersion;
  try {
    self.postMessage({ type: "status", text: "Lendo arquivo IFC…", progress: 0 });
    const response = await fetch("https://ifc.hydros/model.ifc", { cache: "no-store" });
    if (!response.ok) throw new Error("Não foi possível ler o arquivo IFC selecionado.");
    const reader = response.body.getReader(), chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      chunks.push(value); received += value.byteLength;
      if (version !== modelVersion) return;
      self.postMessage({ type: "status", text: "Carregando o arquivo IFC…", progress: Math.min(25, Math.round(received / Number(response.headers.get("content-length") || received) * 25)) });
    }
    let bytes = new Uint8Array(received); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    chunks.length = 0;
    self.postMessage({ type: "status", text: "Interpretando elementos hidráulicos…", progress: 26 });
    const api = new WebIFC.IfcAPI(); api.SetWasmPath(new URL("./lib/", self.location.href).href); await api.Init();
    const model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true }); bytes = null;
    self.postMessage({ type: "status", text: "Auditando unidades e relações IFC…", progress: 28 });
    const schema = api.GetModelSchema(model);
    const getIds = name => { const type = api.GetTypeCodeFromName(name); return type ? api.GetLineIDsWithType(model, type) : null; };
    const readGeometryData = makeEndpointReader(api, model);
    const descendants = name => {
      const type = api.GetTypeCodeFromName(name), ids = type ? api.GetLineIDsWithType(model, type, true) : null, result = new Set();
      for (let i = 0; ids && i < ids.size(); i++) result.add(api.GetLineType(model, ids.get(i)));
      return [...result];
    };
    const unitAssignmentId = getIds("IFCUNITASSIGNMENT");
    const unitAssignment = unitAssignmentId?.size() ? api.GetLine(model, unitAssignmentId.get(0), true) : null;
    const lengthUnit = unitAssignment?.Units?.find(unit => value(unit.UnitType) === "LENGTHUNIT") ?? null;
    const metresPerUnit = unitToMetres(api, lengthUnit);
    const projectId = getIds("IFCPROJECT");
    const project = projectId?.size() ? api.GetLine(model, projectId.get(0), false) : null;
    const storeyMap = new Map(), storeyCounts = {};
    for (const name of spatialTypes) {
      const ids = getIds(name); if (!ids) continue;
      for (let i = 0; i < ids.size(); i++) {
        const id = ids.get(i), spatial = api.GetLine(model, id, false);
        const label = value(spatial?.Name) || value(spatial?.LongName) || `${name} ${id}`;
        storeyMap.set(id, { id, name, label });
        if (name === "IFCBUILDINGSTOREY") storeyCounts[label] = (storeyCounts[label] ?? 0) + 1;
      }
    }
    const productMetadata = new Map(), globalIds = new Map(), missingGlobalIds = [], duplicateGlobalIds = [], systemCounts = {};
    const warnings = [], productIds = new Set(), metadataTypes = [...new Set([...typeNames.map(name => api.GetTypeCodeFromName(name)), ...descendants("IFCFLOWTERMINAL")])].filter(Boolean);
    for (const type of metadataTypes) {
      const ids = api.GetLineIDsWithType(model, type);
      for (let i = 0; i < ids.size(); i++) {
        const expressId = ids.get(i), line = api.GetLine(model, expressId, false), globalId = value(line?.GlobalId);
        productIds.add(expressId);
        if (!globalId) missingGlobalIds.push({ expressId, type: api.GetNameFromTypeCode(type) });
        else {
          const previous = globalIds.get(globalId);
          if (previous != null) duplicateGlobalIds.push({ id: globalId, expressIds: [previous, expressId] });
          else globalIds.set(globalId, expressId);
        }
        const ifcType = api.GetNameFromTypeCode(type), normalizedType = ifcType.toLowerCase();
        const geometric = normalizedType === "ifcpipesegment" || normalizedType === "ifcpipefitting" || normalizedType === "ifcvalve" || normalizedType === "ifcpump" || normalizedType === "ifcflowmeter" || api.IsIfcElement(type)
          ? readGeometryData(expressId) : { endpoints: null, origin: null };
        productMetadata.set(expressId, { expressId, globalId, name: value(line?.Name) ?? "", type: ifcType, storey: null, systemLabel: null, systemSource: null, materials: [], properties: [], endpoints: metresPerUnit == null ? null : geometric.endpoints?.map(point => multiply(point, metresPerUnit)) ?? null, origin: metresPerUnit == null ? null : geometric.origin?.map(component => component * metresPerUnit) ?? null });
      }
    }
    const containmentIds = getIds("IFCRELCONTAINEDINSPATIALSTRUCTURE");
    for (let i = 0; containmentIds && i < containmentIds.size(); i++) {
      const relation = api.GetLine(model, containmentIds.get(i), false), storey = storeyMap.get(reference(relation?.RelatingStructure));
      if (!storey) continue;
      for (const related of relation.RelatedElements ?? []) {
        const item = productMetadata.get(reference(related));
        if (item && !item.storey) item.storey = storey.label;
      }
    }
    const relevantProperties = new Set(["Nome", "Classe", "Tipo", "Rede", "Aplicação", "Indicação", "Material", "Diâmetro", "Diâmetro interno", "Comprimento", "Comprimento máximo", "Fabricante", "Modelo", "Vazão", "Pressão", "K"]);
    const propertyRelations = getIds("IFCRELDEFINESBYPROPERTIES");
    for (let i = 0; propertyRelations && i < propertyRelations.size(); i++) {
      const relation = api.GetLine(model, propertyRelations.get(i), false);
      const relatedProducts = (relation?.RelatedObjects ?? []).map(reference).filter(id => productIds.has(id));
      if (!relatedProducts.length || !relation.RelatingPropertyDefinition) continue;
      const set = api.GetLine(model, reference(relation.RelatingPropertyDefinition), false);
      if (!set || api.GetNameFromTypeCode(set.type).toLowerCase() !== "ifcpropertyset") continue;
      const setName = value(set.Name) ?? "Property set", extracted = [];
      for (const propertyRef of set.HasProperties ?? []) {
        const property = api.GetLine(model, reference(propertyRef), false), propertyName = value(property.Name) ?? "Propriedade";
        if (!relevantProperties.has(propertyName)) continue;
        const nominal = property.NominalValue, propertyValue = primitive(nominal);
        const unit = property.Unit ? api.GetLine(model, reference(property.Unit), false) : null;
        const factor = unit ? unitToMetres(api, unit) : metresPerUnit;
        const valueType = nominal?.name ?? (nominal?.type ? api.GetNameFromTypeCode(nominal.type) : null);
        const isLength = /lengthmeasure$/i.test(valueType ?? "");
        const normalizedValue = isLength && factor != null && typeof propertyValue === "number" ? propertyValue * factor : null;
        extracted.push({ set: setName, name: propertyName, value: propertyValue, valueType, sourceUnit: isLength ? unitName(api, unit ?? lengthUnit) : null, normalizedValue, normalizedUnit: normalizedValue == null ? null : "m" });
      }
      for (const expressId of relatedProducts) {
        const item = productMetadata.get(expressId);
        item.properties.push(...extracted);
        const network = extracted.find(property => setName === "Identificação_Elemento" && property.name === "Rede");
        if (network && network.value != null) { item.systemLabel = String(network.value); item.systemSource = setName + ".Rede"; }
      }
      if (i && i % 10000 === 0) self.postMessage({ type: "status", text: "Lendo property sets IFC… " + i.toLocaleString("pt-BR") + " relações", progress: 28 + Math.min(10, Math.round(i / propertyRelations.size() * 10)) });
    }
    function readMaterialNames(id, seen = new Set()) {
      if (!id || seen.has(id)) return [];
      seen.add(id);
      const material = api.GetLine(model, id, false), type = api.GetNameFromTypeCode(material?.type).toLowerCase();
      const names = type === "ifcmaterial" && value(material?.Name) ? [String(value(material.Name))] : [];
      for (const field of ["Material", "Materials", "MaterialLayers", "MaterialConstituents", "MaterialProfiles", "ForProfileSet"]) {
        const child = material?.[field];
        for (const ref of Array.isArray(child) ? child : child == null ? [] : [child]) names.push(...readMaterialNames(reference(ref), seen));
      }
      return names;
    }
    const materialRelations = getIds("IFCRELASSOCIATESMATERIAL");
    for (let i = 0; materialRelations && i < materialRelations.size(); i++) {
      const relation = api.GetLine(model, materialRelations.get(i), false), names = [...new Set(readMaterialNames(reference(relation?.RelatingMaterial)))];
      if (!names.length) continue;
      for (const related of relation.RelatedObjects ?? []) {
        const item = productMetadata.get(reference(related));
        if (item) item.materials.push(...names);
      }
    }
    // Portas e sistemas explícitos do IFC têm prioridade; a geometria só sugere o que as relações não cobrem.
    const readPortPoint = port => {
      const point = metresPerUnit == null ? null : readGeometryData.placementOrigin(reference(port?.ObjectPlacement));
      return point ? multiply(point, metresPerUnit) : null;
    };
    const connectivity = readIfcConnectivity(api, model, productMetadata, readPortPoint);
    for (const item of productMetadata.values()) if (item.systemLabel) systemCounts[item.systemLabel] = (systemCounts[item.systemLabel] ?? 0) + 1;
    const { candidates, unresolvedRelations } = buildConnectionCandidates(productMetadata, connectivity);
    const types = metadataTypes;
    if (!types.length) throw new Error("O leitor IFC não reconheceu as classes hidráulicas do arquivo.");
    const counts = Object.fromEntries(typeNames.map(name => [name, 0]));
    for (const item of productMetadata.values()) {
      const type = item.type.toUpperCase();
      counts[type] = (counts[type] ?? 0) + 1;
    }
    const total = productMetadata.size;
    self.postMessage({ type: "status", text: "Convertendo geometria IFC…", progress: 38 });
    let batch = [], processed = 0, sent = 0;
    const boxes = new Map();
    const flush = () => {
      if (!batch.length) return;
      const transfer = [];
      for (const item of batch) for (const part of item.parts) transfer.push(part.vertices, part.normals, part.indices);
      self.postMessage({ type: "geometry", items: batch }, transfer); sent += batch.length; batch = [];
    };
    api.StreamAllMeshesWithTypes(model, types, flat => {
      if (version !== modelVersion) return;
      processed++;
      const metadata = productMetadata.get(flat.expressID);
      const line = metadata ?? api.GetLine(model, flat.expressID);
      const globalId = metadata?.globalId ?? line?.GlobalId?.value ?? line?.GlobalId;
      const ifcType = api.GetNameFromTypeCode(api.GetLineType(model, flat.expressID));
      const parts = [];
      for (let i = 0; i < flat.geometries.size(); i++) {
        const placed = flat.geometries.get(i), geometry = api.GetGeometry(model, placed.geometryExpressID);
        const raw = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
        const vertices = new Float32Array(raw.length / 2), normals = new Float32Array(raw.length / 2);
        // Caixa envolvente no referencial do visor (Z para cima, como no IFC), usada para achar pontas dentro das peças.
        const box = metadata ? boxes.get(flat.expressID) ?? [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] : null, m = placed.flatTransformation;
        for (let k = 0, j = 0; k < raw.length; k += 6, j += 3) {
          const x = raw[k], y = raw[k + 1], z = raw[k + 2];
          vertices[j] = x; vertices[j + 1] = y; vertices[j + 2] = z; normals[j] = raw[k + 3]; normals[j + 1] = raw[k + 4]; normals[j + 2] = raw[k + 5];
          if (!box) continue;
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          if (wx < box[0]) box[0] = wx; if (wx > box[3]) box[3] = wx;
          if (-wz < box[1]) box[1] = -wz; if (-wz > box[4]) box[4] = -wz;
          if (wy < box[2]) box[2] = wy; if (wy > box[5]) box[5] = wy;
        }
        if (box && raw.length) boxes.set(flat.expressID, box);
        const indices = new Uint32Array(api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize()));
        geometry.delete();
        if (vertices.length && indices.length) parts.push({ vertices: vertices.buffer, normals: normals.buffer, indices: indices.buffer, transform: Array.from(placed.flatTransformation) });
      }
      const itemMetadata = metadata ?? { storey: null, systemLabel: null, systemSource: null, properties: [], endpoints: null };
      if (parts.length) batch.push({ id: globalId ?? null, expressId: flat.expressID, type: ifcType, name: metadata?.name ?? line?.Name?.value ?? line?.Name ?? "", storey: itemMetadata.storey, systemLabel: itemMetadata.systemLabel, systemLabels: itemMetadata.systemLabels ?? [], systemSource: itemMetadata.systemSource, materials: itemMetadata.materials ?? [], properties: itemMetadata.properties, endpoints: itemMetadata.endpoints, parts });
      if (batch.length >= 40) flush();
      if (processed % 250 === 0) self.postMessage({ type: "status", text: `Convertendo geometria IFC… ${processed.toLocaleString("pt-BR")} elementos`, progress: 38 + Math.min(58, Math.round(processed / Math.max(total, 1) * 58)) });
    });
    flush();
    const volume = addVolumeCandidates(productMetadata, candidates, boxes);
    const explicitSystems = connectivity.systemCount;
    const portRelations = connectivity.relations.length, portCandidates = candidates.filter(candidate => candidate.source === "ifc-ports").length;
    api.CloseModel(model);
    if (!sent) throw new Error("Nenhum elemento hidráulico com geometria foi encontrado no IFC.");
    const units = unitAssignment?.Units?.map(unit => ({ type: value(unit.UnitType), name: unitName(api, unit), expressType: api.GetNameFromTypeCode(unit.type) })) ?? [];
    if (!metresPerUnit) warnings.push("Unidade de comprimento não reconhecida; dimensões não podem ser normalizadas com segurança.");
    if (!storeyMap.size) warnings.push("O modelo não contém estrutura espacial reconhecida (IfcSite/IfcBuilding/IfcBuildingStorey).");
    if (missingGlobalIds.length) warnings.push(`${missingGlobalIds.length} elemento(s) hidráulico(s) sem GlobalId; a seleção usa o Express ID do arquivo.`);
    if (duplicateGlobalIds.length) warnings.push(`${duplicateGlobalIds.length} GlobalId(s) duplicado(s); a seleção usa o Express ID para distinguir os elementos.`);
    const noStorey = [...productMetadata.values()].filter(item => !item.storey).length;
    if (noStorey) warnings.push(`${noStorey} elemento(s) hidráulico(s) sem pavimento explicitamente associado.`);
    const withoutProperties = [...productMetadata.values()].filter(item => !item.properties.length).length;
    if (withoutProperties) warnings.push(`${withoutProperties} elemento(s) hidráulico(s) sem property sets anexados.`);
    const withoutSystem = [...productMetadata.values()].filter(item => !item.systemLabel).length;
    if (withoutSystem) warnings.push(withoutSystem + " elemento(s) hidráulico(s) sem rede explícita (IfcSystem/IfcDistributionSystem ou Identificação_Elemento.Rede).");
    const withoutMaterial = [...productMetadata.values()].filter(item => item.type.toLowerCase() === "ifcpipesegment" && !item.materials.length && !item.properties.some(property => property.name === "Material" && property.value != null)).length;
    if (withoutMaterial) warnings.push(withoutMaterial + " tubo(s) sem material explícito no IFC; a rugosidade não será presumida.");
    const pipes = [...productMetadata.values()].filter(item => item.type.toLowerCase() === "ifcpipesegment");
    const withInternalDiameter = item => item.properties.some(property => property.name === "Diâmetro interno" && typeof property.normalizedValue === "number" && property.normalizedValue > 0);
    const withLength = item => item.properties.some(property => property.name === "Comprimento" && typeof property.normalizedValue === "number" && property.normalizedValue > 0);
    const missingInternalDiameter = pipes.filter(item => !withInternalDiameter(item)).length, missingLength = pipes.filter(item => !withLength(item)).length;
    if (missingInternalDiameter) warnings.push(missingInternalDiameter + " tubo(s) sem diâmetro interno explícito, positivo e normalizado; o nominal não será convertido em diâmetro útil.");
    if (missingLength) warnings.push(missingLength + " tubo(s) sem comprimento explícito normalizado em metros; a geometria não será usada como comprimento hidráulico sem revisão.");
    const pipeCount = [...productMetadata.values()].filter(item => item.type.toLowerCase() === "ifcpipesegment").length;
    const withoutEndpoints = [...productMetadata.values()].filter(item => item.type.toLowerCase() === "ifcpipesegment" && !item.endpoints).length;
    if (withoutEndpoints) warnings.push(withoutEndpoints + " de " + pipeCount + " tubos sem endpoints extraíveis das representações suportadas (IfcExtrudedAreaSolid/IfcSweptDiskSolid) nem de duas portas IFC posicionadas; fora da lista de candidatos.");
    if (!explicitSystems && !Object.keys(systemCounts).length) warnings.push("Nenhuma entidade IfcSystem ou propriedade de rede explícita foi encontrada; a classificação permanece não identificada.");
    if (!portRelations) warnings.push("Nenhuma relação IfcRelConnectsPorts foi encontrada; conexões por geometria serão apenas candidatas revisáveis.");
    if (unresolvedRelations) warnings.push(unresolvedRelations + " relação(ões) IfcRelConnectsPorts não puderam ser associadas a uma extremidade de tubo reconhecida; essas ligações dependem da revisão geométrica.");
    if (metresPerUnit == null) warnings.push("Unidade não suportada: candidatos de conexão não foram gerados.");
    else if (!volume.calibrated && volume.pipes) warnings.push("A posição das malhas não pôde ser conferida contra os eixos dos tubos (" + volume.consistent + " de " + volume.pipes + " coerentes); pontas sem candidato não foram procuradas dentro do volume das peças.");
    const withoutGeometry = Math.max(0, total - sent);
    if (withoutGeometry) warnings.push(withoutGeometry + " elemento(s) hidráulico(s) reconhecido(s) não possuem geometria exibível.");
    const terminals = [...productMetadata.values()].filter(item => item.type.toLowerCase() === "ifcsanitaryterminal").map(({ expressId, globalId, name, type, storey, systemLabel, systemLabels }) => ({ expressId, globalId, name, type, storey, systemLabel, systemLabels: systemLabels ?? [] }));
    self.postMessage({ type: "done", counts, elements: sent, schema, projectName: value(project?.Name), units, metresPerUnit, storeys: storeyCounts, systemCounts, warnings, missingGlobalIds, duplicateGlobalIds, explicitSystems, portRelations, portCandidates, volumeCandidates: volume.added, pipeCount, pipesWithEndpoints: pipeCount - withoutEndpoints, pipesMissingInternalDiameter: missingInternalDiameter, pipesMissingLength: missingLength, candidates, terminals });
  } catch (error) {
    self.postMessage({ type: "error", text: error?.message ?? String(error) });
  }
};
