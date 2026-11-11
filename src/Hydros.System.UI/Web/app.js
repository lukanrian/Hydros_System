import * as THREE from "three";
import CameraControls from "./lib/camera-controls.module.js";
import { calculatePipeLoss, waterProperties } from "./hydraulic-engine.js";
import { evaluatePump, pumpCurves } from "./pump-catalog.js";

const $ = id => document.getElementById(id);
const host = window.chrome?.webview;
const viewport = $("viewport"), scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); viewport.appendChild(renderer.domElement);
const perspective = new THREE.PerspectiveCamera(45, 1, 0.05, 100000); perspective.up.set(0, 0, 1);
const ortho = new THREE.OrthographicCamera(-50, 50, 50, -50, -100000, 100000); ortho.up.set(0, 1, 0);
CameraControls.install({ THREE });
function makeControls(camera, top) {
  const c = new CameraControls(camera, renderer.domElement), A = CameraControls.ACTION;
  c.mouseButtons.left = top ? A.TRUCK : A.ROTATE; c.mouseButtons.middle = A.TRUCK; c.mouseButtons.right = A.NONE;
  c.mouseButtons.wheel = top ? A.ZOOM : A.DOLLY; c.dollyToCursor = true; c.infinityDolly = !top;
  c.minDistance = 0.3; c.smoothTime = 0.2; c.draggingSmoothTime = 0.125;
  if (top) { c.azimuthRotateSpeed = 0; c.polarRotateSpeed = 0; c.minZoom = 0.02; c.maxZoom = 500; }
  return c;
}
const controls3d = makeControls(perspective, false), controlsTop = makeControls(ortho, true);
let controls = controls3d, camera = perspective, topView = false;
const world = new THREE.Group(); scene.add(world);
scene.add(new THREE.HemisphereLight(0xffffff, 0x9299a3, 2.0));
const light = new THREE.DirectionalLight(0xffffff, 1.5); light.position.set(40, -30, 80); scene.add(light);
let worker = null, selected = null, modelName = "", pendingName = "", activeFileKey = "", pendingFileKey = "", loadingToken = 0, pendingGroup = null;
let importedCandidates = [], terminals = [], reviewDecisions = {}, projectInputs = {}, reviewPage = 0, demandPage = 0;
const reviewPageSize = 50;
const demandPageSize = 30;
let flowResults = new Map(), flowCalculation = null, hydraulicResults = null, pumpResult = null;
const batches = [], pendingBatches = [], outputLines = [];
const colors = { pipe: 0x3d78c5, fitting: 0x8292a6, valve: 0xe5a03c, pump: 0x9a66bb, terminal: 0x39a487, meter: 0x35a8b4, other: 0x8993a1 };
const axis = new THREE.Matrix4().set(1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1);
function typeKind(type = "") {
  const t = type.toLowerCase();
  if (t.includes("pipesegment")) return "pipe";
  if (t.includes("pipefitting")) return "fitting";
  if (t.includes("valve")) return "valve";
  if (t.includes("pump")) return "pump";
  if (t.includes("flowmeter")) return "meter";
  if (t.includes("flowterminal")) return "terminal";
  return "other";
}
function systemKind(label = "") {
  const normalized = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/^agua fria(?:\s|$)/.test(normalized)) return "cold";
  if (/^agua quente(?:\s|$)/.test(normalized)) return "hot";
  if (/^alimentacao(?:\s|$)/.test(normalized)) return "feed";
  return "unknown";
}
const systemColors = { cold: 0x3985d4, hot: 0xe85a42, feed: 0x3ca785, unknown: 0x8993a1 };
function displayColor(item) { return $("colorMode").value === "system" ? systemColors[systemKind(item.systemLabel)] : item.color; }
function log(text) { outputLines.unshift(`${new Date().toLocaleTimeString("pt-BR")}  ${text}`); $("output").innerHTML = outputLines.slice(0, 100).map(x => `<div>${escapeHtml(x)}</div>`).join(""); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function status(text) { $("status").textContent = text; }
function resize() {
  const w = viewport.clientWidth, h = Math.max(viewport.clientHeight, 1); renderer.setSize(w, h, false);
  perspective.aspect = w / h; perspective.updateProjectionMatrix();
  const half = Math.max((ortho.top - ortho.bottom) / 2, 1), cx = (ortho.left + ortho.right) / 2, cy = (ortho.top + ortho.bottom) / 2;
  ortho.left = cx - half * w / h; ortho.right = cx + half * w / h; ortho.top = cy + half; ortho.bottom = cy - half; ortho.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport); resize();
const clock = new THREE.Clock();
(function animate() { requestAnimationFrame(animate); controls.update(clock.getDelta()); renderer.render(scene, camera); })();
function discardPending() {
  if (pendingGroup) { scene.remove(pendingGroup); pendingGroup.clear(); }
  for (const batch of pendingBatches) { batch.mesh.dispose(); batch.mesh.material.dispose(); }
  pendingBatches.length = 0; pendingGroup = null;
}
function discardActive() {
  for (const batch of batches) { batch.mesh.dispose(); batch.mesh.material.dispose(); }
  batches.length = 0; world.clear(); selected = null; flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; showProperties(null);
}
function commitPending() {
  discardActive();
  world.add(pendingGroup); batches.push(...pendingBatches); pendingBatches.length = 0; pendingGroup = null;
  modelName = pendingName; activeFileKey = pendingFileKey; pendingFileKey = ""; loadReviewDecisions(activeFileKey); loadProjectInputs(activeFileKey); $("fileName").textContent = modelName; host?.postMessage({ type: "modelAccepted" });
}
function renderChunk(items, targetBatches = batches, targetGroup = world) {
  const geometries = [], instanceData = [];
  for (const item of items) for (const part of item.parts) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(part.vertices), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(part.normals), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(part.indices), 1));
    geo.applyMatrix4(axis.clone().multiply(new THREE.Matrix4().fromArray(part.transform)));
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    geometries.push(geo); instanceData.push({ ...item, kind: typeKind(item.type) });
  }
  if (!geometries.length) return;
  const vertexCount = geometries.reduce((n, g) => n + g.attributes.position.count, 0);
  const indexCount = geometries.reduce((n, g) => n + (g.index?.count ?? 0), 0);
  const mesh = new THREE.BatchedMesh(geometries.length, vertexCount, indexCount, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }));
  mesh.sortObjects = false;
  const records = [];
  geometries.forEach((geo, i) => {
    const geometryId = mesh.addGeometry(geo), batchId = mesh.addInstance(geometryId), data = instanceData[i];
    const color = colors[data.kind] ?? colors.other; mesh.setColorAt(batchId, new THREE.Color(color));
    records[batchId] = { ...data, color, box: geo.boundingBox.clone() };
    geo.dispose();
  });
  targetGroup.add(mesh); targetBatches.push({ mesh, records });
}
function fit(box = new THREE.Box3().setFromObject(world), padding = 1.2) {
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  if (camera.isOrthographicCamera) {
    const half = Math.max(size.y / 2, size.x / 2 * viewport.clientHeight / Math.max(viewport.clientWidth, 1), 0.5) * padding;
    ortho.top = half; ortho.bottom = -half; ortho.left = -half * viewport.clientWidth / viewport.clientHeight; ortho.right = half * viewport.clientWidth / viewport.clientHeight; ortho.updateProjectionMatrix();
    controlsTop.zoomTo(1, false); controlsTop.setLookAt(center.x, center.y, center.z + Math.max(size.z * 4, 50), center.x, center.y, center.z, false); return;
  }
  const direction = new THREE.Vector3(1, -1, 0.8).normalize();
  const radius = Math.max(size.length() / 2, 0.5);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(perspective.fov / 2)) * padding;
  controls3d.setLookAt(center.x + direction.x * distance, center.y + direction.y * distance, center.z + direction.z * distance, center.x, center.y, center.z, true);
}
function switchView(top) {
  topView = top; controls.enabled = false; camera = top ? ortho : perspective; controls = top ? controlsTop : controls3d; controls.enabled = true;
  document.querySelectorAll("[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === (top ? "top" : "3d")));
  if (batches.length) fit();
}
function showProperties(item) {
  if (!item) { $("properties").className = "summary empty"; $("properties").textContent = "Selecione um elemento no modelo."; return; }
  $("properties").className = "summary";
  const properties = (item.properties ?? []).slice(0, 80);
  const propertyHtml = properties.map(property => "<div><strong>" + escapeHtml(property.set) + " · " + escapeHtml(property.name) + "</strong><span>" + escapeHtml(property.value ?? "sem valor") + (property.sourceUnit ? " " + escapeHtml(property.sourceUnit) : "") + (property.valueType ? " (" + escapeHtml(property.valueType) + ")" : "") + (property.normalizedValue == null ? "" : " · " + property.normalizedValue.toLocaleString("pt-BR", { maximumFractionDigits: 6 }) + " m") + "</span></div>").join("");
  const system = item.systemLabel ? escapeHtml(item.systemLabel) + " · fonte: " + escapeHtml(item.systemSource) : "não informado no IFC";
  const materials = item.materials?.length ? escapeHtml([...new Set(item.materials)].join(", ")) + " · IfcRelAssociatesMaterial" : "não informado por relação de material IFC";
  const calculatedFlow = flowResults.get(item.expressId);
  const hydraulic = hydraulicResults?.pipes?.[item.expressId], flowRow = calculatedFlow == null ? "" : "<dt>Vazão neste cenário</dt><dd>" + calculatedFlow.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) + " L/s · soma a jusante</dd>";
  const hydraulicRow = hydraulic ? "<dt>Velocidade</dt><dd>" + hydraulic.velocity.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m/s</dd><dt>Perda total</dt><dd>" + hydraulic.totalLossM.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a.</dd><dt>Pressão no nó jusante</dt><dd>" + hydraulic.downstreamPressureMca.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a.</dd>" : "";
  const pipeInput = item.kind === "pipe" ? (() => {
    const saved = projectInputs.pipeHydraulics?.[item.expressId] ?? {}, property = name => item.properties?.find(value => value.name === name && Number.isFinite(value.normalizedValue) && value.normalizedValue > 0)?.normalizedValue;
    const diameter = saved.diameterMm ?? (property("Diâmetro interno") == null ? "" : property("Diâmetro interno") * 1000), length = saved.lengthM ?? (property("Comprimento") ?? "");
    return "<details class=\"metadata-block\" open><summary>Dados hidráulicos do tubo</summary><div class=\"demand-fields\"><label>Diâmetro interno (mm)<input type=\"number\" min=\"0\" step=\"any\" data-pipe=\"diameterMm\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(diameter) + "\"></label><label>Comprimento (m)<input type=\"number\" min=\"0\" step=\"any\" data-pipe=\"lengthM\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(length) + "\"></label><label>Rugosidade absoluta (mm)<input type=\"number\" min=\"0\" step=\"any\" data-pipe=\"roughnessMm\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(saved.roughnessMm ?? "") + "\"></label><label>Soma dos K localizados<input type=\"number\" min=\"0\" step=\"any\" data-pipe=\"k\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(saved.k ?? "") + "\"></label><label>Fonte dos dados<input type=\"text\" maxlength=\"160\" data-pipe=\"source\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(saved.source ?? "") + "\" placeholder=\"Fabricante, ficha técnica ou medição\"></label></div></details>";
  })() : "";
  $("properties").innerHTML = "<h3>" + escapeHtml(item.name || item.type) + "</h3><dl><dt>Classe IFC</dt><dd>" + escapeHtml(item.type) + "</dd><dt>GlobalId</dt><dd>" + escapeHtml(item.id ?? "não informado") + "</dd><dt>Express ID</dt><dd>" + item.expressId + "</dd><dt>Pavimento IFC</dt><dd>" + escapeHtml(item.storey ?? "não associado") + "</dd><dt>Rede IFC</dt><dd>" + system + "</dd><dt>Material IFC</dt><dd>" + materials + "</dd>" + flowRow + hydraulicRow + "</dl>" + pipeInput + (properties.length ? "<details class=\"metadata-block\"><summary>Propriedades IFC (" + item.properties.length + ")</summary><div class=\"metadata-list\">" + propertyHtml + (item.properties.length > 80 ? "<div>Mostrando 80 de " + item.properties.length + " propriedades.</div>" : "") + "</div></details>" : "<div class=\"warning\">Sem property sets IFC associados.</div>");
}
function loadReviewDecisions(fileKey) {
  try { const saved = JSON.parse(localStorage.getItem("hydros:reviews:" + fileKey) || "{}"); reviewDecisions = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}; }
  catch { reviewDecisions = {}; }
}
function loadProjectInputs(fileKey) {
  let saved = {};
  try { const value = JSON.parse(localStorage.getItem("hydros:inputs:" + fileKey) || "{}"); if (value && typeof value === "object" && !Array.isArray(value)) saved = value; }
  catch { log("As entradas salvas do projeto não puderam ser lidas; usando campos vazios."); }
  const boundaries = {};
  for (const system of ["cold", "hot", "feed"]) {
    const boundary = saved.boundaries?.[system];
    if (boundary && typeof boundary === "object" && !Array.isArray(boundary) && Number.isInteger(boundary.expressId) && typeof boundary.type === "string") {
      const target = boundary.target && Number.isInteger(boundary.target.expressId) && typeof boundary.target.type === "string" ? { expressId: boundary.target.expressId, type: boundary.target.type, end: boundary.target.end === 1 ? 1 : 0 } : null;
      boundaries[system] = { ...boundary, target, end: boundary.end === 1 ? 1 : boundary.end === 0 ? 0 : null, headM: typeof boundary.headM === "string" ? boundary.headM : "", staticHeadM: typeof boundary.staticHeadM === "string" ? boundary.staticHeadM : "", elevationM: typeof boundary.elevationM === "string" ? boundary.elevationM : "" };
    }
  }
  projectInputs = { ...saved, demands: saved.demands && typeof saved.demands === "object" && !Array.isArray(saved.demands) ? saved.demands : {}, pipeHydraulics: saved.pipeHydraulics && typeof saved.pipeHydraulics === "object" && !Array.isArray(saved.pipeHydraulics) ? saved.pipeHydraulics : {}, boundaries };
  if (["cold", "hot", "feed"].includes(saved.system)) $("system").value = saved.system;
  $("utilityPressure").value = typeof saved.utilityPressure === "string" ? saved.utilityPressure : "";
  $("utilityFlowLps").value = typeof saved.utilityFlowLps === "string" ? saved.utilityFlowLps : "";
  $("utilityPressureMax").value = typeof saved.utilityPressureMax === "string" ? saved.utilityPressureMax : "";
  $("destination").value = saved.destination === "direct" ? "direct" : "tank";
  $("dailyVolumeL").value = typeof saved.dailyVolumeL === "string" ? saved.dailyVolumeL : "";
  $("refillHours").value = typeof saved.refillHours === "string" ? saved.refillHours : "";
  $("tankBuildingType").value = saved.tankBuildingType === "single" ? "single" : saved.tankBuildingType === "other" ? "other" : "";
  $("waterTemperature").value = typeof saved.waterTemperature === "string" ? saved.waterTemperature : "";
  updateBoundaryFields();
}
function updateBoundaryFields() {
  const system = $("system").value, boundary = projectInputs.boundaries?.[system];
  $("feedFields").hidden = system !== "feed";
  $("tankFields").hidden = system !== "feed" || $("destination").value !== "tank";
  $("sourceHeadField").hidden = system === "feed";
  $("sourceStaticField").hidden = system === "feed";
  $("sourceHeadHint").hidden = system === "feed";
  $("sourceEndField").hidden = !boundary || typeof boundary.type !== "string" || boundary.type.toLowerCase() !== "ifcpipesegment";
  $("sourceEnd").value = String(boundary?.end ?? 0);
  $("sourceHead").value = typeof boundary?.headM === "string" ? boundary.headM : "";
  $("sourceStaticHead").value = typeof boundary?.staticHeadM === "string" ? boundary.staticHeadM : "";
  $("sourceElevation").value = typeof boundary?.elevationM === "string" ? boundary.elevationM : "";
  $("sourceElevationField").hidden = false;
  $("sourceLabel").textContent = boundary ? boundary.type + " · Express ID " + boundary.expressId + (boundary.end == null ? " · nó do componente" : " · extremidade " + (boundary.end + 1)) : "Origem não selecionada para este sistema.";
  $("tankEndLabel").textContent = boundary?.target ? boundary.target.type + " · Express ID " + boundary.target.expressId + " · extremidade " + (boundary.target.end + 1) : "Extremidade do alimentador junto ao reservatório não selecionada.";
  $("tankEnd").value = String(boundary?.target?.end ?? 0);
  const selectedItem = batches.flatMap(batch => batch.records).find(item => item.expressId === selected);
  $("btnSetTankEnd").disabled = !selectedItem || selectedItem.kind !== "pipe" || system !== "feed" || $("destination").value !== "tank";
}
function saveProjectInputs() {
  if (!activeFileKey) return;
  projectInputs = { ...projectInputs, system: $("system").value, utilityPressure: $("utilityPressure").value, utilityFlowLps: $("utilityFlowLps").value, utilityPressureMax: $("utilityPressureMax").value, destination: $("destination").value, dailyVolumeL: $("dailyVolumeL").value, refillHours: $("refillHours").value, tankBuildingType: $("tankBuildingType").value, waterTemperature: $("waterTemperature").value };
  const boundary = projectInputs.boundaries?.[projectInputs.system];
  if (boundary) { boundary.headM = $("sourceHead").value; boundary.staticHeadM = $("sourceStaticHead").value; boundary.elevationM = $("sourceElevation").value; }
  try { localStorage.setItem("hydros:inputs:" + activeFileKey, JSON.stringify(projectInputs)); }
  catch { log("Não foi possível salvar as entradas locais deste projeto."); }
}
function saveReviewDecisions() {
  try { localStorage.setItem("hydros:reviews:" + activeFileKey, JSON.stringify(reviewDecisions)); }
  catch { log("Não foi possível salvar as decisões locais de revisão."); }
}
function renderConnectionReview() {
  const counts = { Confirmada: 0, Rejeitada: 0, Pendente: 0 };
  importedCandidates.forEach(candidate => { const saved = reviewDecisions[candidate.key]; const decision = saved === "Confirmada" || saved === "Rejeitada" ? saved : "Pendente"; counts[decision]++; });
  const topology = reviewedTopology();
  const pages = Math.ceil(importedCandidates.length / reviewPageSize), start = reviewPage * reviewPageSize;
  $("connectionSummary").className = "summary";
  $("connectionSummary").innerHTML = "<dl><dt>Candidatos (até 50 mm)</dt><dd>" + importedCandidates.length.toLocaleString("pt-BR") + "</dd><dt>Confirmadas manualmente</dt><dd>" + counts.Confirmada + "</dd><dt>Rejeitadas</dt><dd>" + counts.Rejeitada + "</dd><dt>Pendentes</dt><dd>" + counts.Pendente + "</dd><dt>Trechos no grafo revisado</dt><dd>" + topology.pipeCount + "</dd><dt>Extremidades ainda abertas</dt><dd>" + topology.openEnds + "</dd><dt>Redes desconectadas</dt><dd>" + topology.components + "</dd><dt>Terminais ligados</dt><dd>" + topology.connectedTerminals + " / " + terminals.length + "</dd></dl><div class=\"warning\">As ligações continuam sendo sugestões geométricas até confirmação manual. Um grafo sem pontas abertas ainda não substitui a conferência de fonte, vazões, diâmetros e perdas.</div>";
  $("connectionPageLabel").textContent = pages ? (reviewPage + 1) + " / " + pages : "0 / 0";
  $("connectionPrev").disabled = reviewPage === 0; $("connectionNext").disabled = reviewPage + 1 >= pages;
  $("connectionList").innerHTML = importedCandidates.slice(start, start + reviewPageSize).map((candidate, offset) => {
    const index = start + offset, saved = reviewDecisions[candidate.key], decision = saved === "Confirmada" || saved === "Rejeitada" ? saved : "Pendente";
    const from = candidate.from, to = candidate.to;
    const fromLabel = escapeHtml(from.type.replace(/^Ifc/, "") + " · " + (from.id ?? "sem GlobalId").slice(0, 12) + " · ponta " + (from.end + 1));
    const toLabel = escapeHtml(to.type.replace(/^Ifc/, "") + " · " + (to.id ?? "sem GlobalId").slice(0, 12) + (to.end == null ? "" : " · ponta " + (to.end + 1)));
    const networkWarning = from.system && to.system && from.system !== to.system ? "<div class=\"warning\">Redes IFC distintas: " + escapeHtml(from.system) + " / " + escapeHtml(to.system) + ".</div>" : "";
    return "<article class=\"candidate\"><div class=\"candidate-heading\"><strong>" + fromLabel + " ↔ " + toLabel + "</strong><span class=\"decision " + decision.toLowerCase() + "\">" + decision + "</span></div><div class=\"candidate-detail\">" + candidate.distance_m.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) + " m · " + escapeHtml(candidate.evidence) + "</div>" + networkWarning + "<div class=\"candidate-actions\"><button class=\"btn small\" data-action=\"focus\" data-index=\"" + index + "\">Focar tubo</button><button class=\"btn small\" data-action=\"Confirmada\" data-index=\"" + index + "\">Confirmar</button><button class=\"btn small\" data-action=\"Rejeitada\" data-index=\"" + index + "\">Rejeitar</button></div></article>";
  }).join("") || "<div class=\"summary empty\">Nenhum candidato foi encontrado na tolerância atual, ou a unidade do IFC não é compatível.</div>";
}
function reviewedTopology() {
  const parent = new Map(), find = key => { if (!parent.has(key)) parent.set(key, key); if (parent.get(key) !== key) parent.set(key, find(parent.get(key))); return parent.get(key); };
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
  const pipeKey = (id, end) => "p:" + id + ":" + end, componentKey = id => "c:" + id;
  const connectedPorts = new Set(), linkedTerminals = new Set();
  importedCandidates.forEach(candidate => {
    if (reviewDecisions[candidate.key] !== "Confirmada") return;
    const from = candidate.from, to = candidate.to, fromKey = pipeKey(from.expressId, from.end);
    const targetIsPipe = to.type.toLowerCase() === "ifcpipesegment", targetIsTerminal = to.type.toLowerCase() === "ifcsanitaryterminal";
    const toKey = targetIsPipe ? pipeKey(to.expressId, to.end) : componentKey(to.expressId);
    union(fromKey, toKey); connectedPorts.add(fromKey);
    if (targetIsPipe) connectedPorts.add(toKey);
    if (targetIsTerminal) linkedTerminals.add(to.expressId);
  });
  const pipes = batches.flatMap(batch => batch.records).filter(item => item.kind === "pipe" && item.endpoints?.length === 2);
  const adjacency = new Map();
  for (const pipe of pipes) {
    const a = find(pipeKey(pipe.expressId, 0)), b = find(pipeKey(pipe.expressId, 1));
    if (!adjacency.has(a)) adjacency.set(a, new Set()); if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b); adjacency.get(b).add(a);
  }
  let components = 0; const seen = new Set();
  for (const node of adjacency.keys()) if (!seen.has(node)) {
    components++; const stack = [node]; seen.add(node);
    while (stack.length) for (const next of adjacency.get(stack.pop())) if (!seen.has(next)) { seen.add(next); stack.push(next); }
  }
  return { pipeCount: pipes.length, openEnds: Math.max(0, pipes.length * 2 - connectedPorts.size), components, connectedTerminals: linkedTerminals.size };
}
function calculateReviewedFlows() {
  const system = $("system").value, boundary = projectInputs.boundaries?.[system], tankMode = system === "feed" && $("destination").value === "tank", error = message => ({ error: message });
  if (!boundary) return error("Defina a origem da rede ativa no modelo 3D.");
  if (!batches.some(batch => batch.records.some(item => item.kind === "pipe" && item.endpoints?.length === 2 && systemKind(item.systemLabel ?? "") === system))) return error("A rede ativa não tem tubos com endpoints geométricos.");
  const refillFlowLps = Number($("dailyVolumeL").value) / (Number($("refillHours").value) * 3600);
  const maxRefillHours = $("tankBuildingType").value === "single" ? 3 : 6;
  if (tankMode && (!boundary.target || !["single", "other"].includes($("tankBuildingType").value) || String($("dailyVolumeL").value).trim() === "" || String($("refillHours").value).trim() === "" || !Number.isFinite(refillFlowLps) || refillFlowLps <= 0 || Number($("refillHours").value) > maxRefillHours)) return error("Para alimentar o reservatório, informe a tipologia, o volume diário e tempo dentro do limite normativo, além da extremidade de chegada selecionada no 3D.");
  if (system === "feed" && [$("utilityPressure").value, $("utilityFlowLps").value, $("utilityPressureMax").value].some(value => String(value).trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0)) return error("Informe valores não negativos de pressão dinâmica, vazão correspondente e pressão máxima estática da concessionária.");
  if (system === "feed" && (Number($("utilityFlowLps").value) <= 0 || Number($("utilityPressureMax").value) < Number($("utilityPressure").value))) return error("A vazão da medição deve ser positiva e a pressão máxima estática não pode ser menor que a dinâmica informada.");
  if (system !== "feed" && [boundary.headM, boundary.elevationM].some(value => String(value ?? "").trim() === "" || !Number.isFinite(Number(value)))) return error("Informe carga total e cota da origem para a rede ativa.");
  const parent = new Map(), find = key => { if (!parent.has(key)) parent.set(key, key); if (parent.get(key) !== key) parent.set(key, find(parent.get(key))); return parent.get(key); };
  const union = (a, b) => { const x = find(a), y = find(b); if (x === y) return false; parent.set(y, x); return true; };
  const pipeKey = (id, end) => "p:" + id + ":" + end, componentKey = id => "c:" + id;
  const portConnections = new Map(), terminalNodes = new Map(), filtered = [];
  for (const candidate of importedCandidates) {
    if (reviewDecisions[candidate.key] !== "Confirmada") continue;
    const from = candidate.from, to = candidate.to;
    if (systemKind(from.system ?? "") !== system || systemKind(to.system ?? "") !== system) continue;
    const fromKey = pipeKey(from.expressId, from.end), targetIsPipe = to.type.toLowerCase() === "ifcpipesegment", targetIsTerminal = to.type.toLowerCase() === "ifcsanitaryterminal";
    const toKey = targetIsPipe ? pipeKey(to.expressId, to.end) : componentKey(to.expressId);
    filtered.push([fromKey, toKey]);
    if (targetIsTerminal) terminalNodes.set(to.expressId, fromKey);
    for (const key of [fromKey, ...(targetIsPipe ? [toKey] : [])]) portConnections.set(key, (portConnections.get(key) ?? 0) + 1);
  }
  if ([...portConnections.values()].some(count => count !== 1)) return error("Há extremidades de tubo com mais de uma conexão confirmada; resolva as ambiguidades.");
  const pipes = batches.flatMap(batch => batch.records).filter(item => item.kind === "pipe" && item.endpoints?.length === 2 && systemKind(item.systemLabel ?? "") === system);
  const keys = new Set();
  for (const pipe of pipes) { keys.add(pipeKey(pipe.expressId, 0)); keys.add(pipeKey(pipe.expressId, 1)); }
  for (const [a, b] of filtered) { keys.add(a); keys.add(b); }
  for (const [a, b] of filtered) { if (!union(a, b)) return error("A rede revisada contém um ciclo; esta versão só distribui vazões em árvores."); }
  for (const pipe of pipes) union(pipeKey(pipe.expressId, 0), pipeKey(pipe.expressId, 1));
  const rootFor = key => find(key), graph = new Map();
  for (const key of keys) { const root = rootFor(key); if (!graph.has(root)) graph.set(root, new Set()); }
  for (const pipe of pipes) { const a = rootFor(pipeKey(pipe.expressId, 0)), b = rootFor(pipeKey(pipe.expressId, 1)); if (a === b) return error("Uma conexão fecha o tubo sobre o próprio nó; revise as pontas confirmadas."); graph.get(a)?.add(b); graph.get(b)?.add(a); }
  const sourceKey = boundary.type.toLowerCase() === "ifcpipesegment" ? pipeKey(boundary.expressId, boundary.end ?? 0) : componentKey(boundary.expressId), source = rootFor(sourceKey);
  const targetKey = tankMode ? pipeKey(boundary.target.expressId, boundary.target.end) : null, destination = targetKey ? rootFor(targetKey) : null;
  if (!graph.has(source)) return error("A origem selecionada não pertence à rede hidráulica classificada como " + $("system").selectedOptions[0].text + ".");
  if (tankMode && (!graph.has(destination) || destination === source || portConnections.has(targetKey))) return error("A chegada ao reservatório deve ser outra extremidade de tubo aberta na rede ativa.");
  const openPorts = pipes.flatMap(pipe => [0, 1].map(end => pipeKey(pipe.expressId, end))).filter(key => !portConnections.has(key) && key !== sourceKey && key !== targetKey);
  if (openPorts.length) return error("Há " + openPorts.length + " extremidade(s) de tubo sem conexão confirmada, além da origem; revise o grafo.");
  const active = tankMode ? [] : terminals.filter(item => projectInputs.demands?.[item.expressId]?.include === true && systemKind(item.systemLabel ?? "") === system);
  if (!tankMode && !active.length) return error("Marque ao menos um ponto de utilização no cenário da rede ativa.");
  const demandAt = new Map();
  if (tankMode) demandAt.set(destination, refillFlowLps);
  for (const terminal of active) {
    const values = projectInputs.demands[terminal.expressId], flow = Number(values.flowLps);
    if (!Number.isFinite(flow) || flow <= 0 || !String(values.source ?? "").trim()) return error("Cada ponto incluído precisa de vazão positiva e fonte do valor.");
    const key = terminalNodes.get(terminal.expressId);
    if (!key) return error("O terminal Express ID " + terminal.expressId + " não tem conexão confirmada no grafo.");
    const node = rootFor(key); demandAt.set(node, (demandAt.get(node) ?? 0) + flow);
  }
  const parentNode = new Map([[source, null]]), order = [source];
  for (let i = 0; i < order.length; i++) for (const next of graph.get(order[i]) ?? []) {
    if (!parentNode.has(next)) { parentNode.set(next, order[i]); order.push(next); }
    else if (parentNode.get(order[i]) !== next) return error("A rede revisada contém um ciclo; esta versão só distribui vazões em árvores.");
  }
  if (order.length !== graph.size) return error("Há componentes fora do caminho da origem; reconecte a rede ou restrinja o modelo ao sistema ativo.");
  const subtree = new Map(demandAt);
  for (const node of order.slice(1).reverse()) { const p = parentNode.get(node); subtree.set(p, (subtree.get(p) ?? 0) + (subtree.get(node) ?? 0)); }
  const byRoot = new Map();
  for (const pipe of pipes) { const a = rootFor(pipeKey(pipe.expressId, 0)), b = rootFor(pipeKey(pipe.expressId, 1)); const child = parentNode.get(a) === b ? a : parentNode.get(b) === a ? b : null; if (child) byRoot.set(child, pipe.expressId); }
  const result = new Map(), paths = [];
  for (const [node, flow] of subtree) if (node !== source) { const expressId = byRoot.get(node); if (expressId != null) result.set(expressId, flow); }
  for (const [child, expressId] of byRoot) paths.push({ expressId, upstream: parentNode.get(child), downstream: child });
  if (result.size !== pipes.length) return error("Não foi possível associar todos os tubos do sistema à árvore de caminhos da origem.");
  if (tankMode && [...result.values()].some(flow => flow <= 0)) return error("A alimentação do reservatório deve formar um único caminho, sem ramais ativos fora do alimentador.");
  const elevations = new Map();
  for (const pipe of pipes) for (const end of [0, 1]) {
    const node = rootFor(pipeKey(pipe.expressId, end)), z = pipe.endpoints[end]?.[2];
    if (Number.isFinite(z)) { const entry = elevations.get(node) ?? { sum: 0, count: 0 }; entry.sum += z; entry.count++; elevations.set(node, entry); }
  }
  return { result, paths, elevations: Object.fromEntries([...elevations].map(([node, value]) => [node, value.sum / value.count])), terminalNodes: Object.fromEntries([...terminalNodes].map(([id, key]) => [id, rootFor(key)])), parentNode: Object.fromEntries(parentNode), order, source, destination, tankMode, totalLps: subtree.get(source) ?? 0, terminalCount: active.length, method: tankMode ? "Volume diário explicitamente informado dividido pelo tempo de reposição escolhido; vazão distribuída no caminho fonte-reservatório." : "Soma das vazões máximas explicitamente marcadas no cenário, agregadas a jusante em árvore radial." };
}
function calculatePressures() {
  if (!flowCalculation || flowCalculation.error) return { error: "Calcule primeiro as vazões no grafo revisado." };
  const system = $("system").value, boundary = projectInputs.boundaries?.[system], temperature = Number($("waterTemperature").value);
  if (String($("waterTemperature").value).trim() === "") return { error: "Informe a temperatura da água para obter densidade e viscosidade." };
  let fluid;
  try { fluid = waterProperties(temperature); } catch (error) { return { error: error.message }; }
  const feed = system === "feed", sourcePressure = Number(feed ? $("utilityPressure").value : boundary?.headM), staticSourcePressure = Number(feed ? $("utilityPressureMax").value : boundary?.staticHeadM), sourceElevation = Number(boundary?.elevationM);
  const sourcePressureInput = feed ? $("utilityPressure").value : boundary?.headM, staticPressureInput = feed ? $("utilityPressureMax").value : boundary?.staticHeadM;
  if (!boundary || [sourcePressure, staticSourcePressure, sourceElevation].some(value => !Number.isFinite(value)) || [sourcePressureInput, staticPressureInput, boundary.elevationM].some(value => String(value ?? "").trim() === "")) return { error: "Informe a pressão dinâmica, pressão estática máxima e cota da origem." };
  if (sourcePressure < 0 || staticSourcePressure < sourcePressure) return { error: "As pressões de origem devem ser não negativas e a pressão estática máxima deve ser maior ou igual à dinâmica." };
  if (feed && Math.abs(Number($("utilityFlowLps").value) - flowCalculation.totalLps) > 0.0005) return { error: "A pressão da concessionária só pode ser usada quando sua vazão de referência coincide com a vazão total calculada; não há curva da rede pública para interpolar." };
  const losses = {}, hgl = new Map([[flowCalculation.source, sourceElevation + sourcePressure]]), pressureLimit = 10000 / (fluid.density * 9.80665), networkLimit = 5000 / (fluid.density * 9.80665), staticLimit = 400000 / (fluid.density * 9.80665), failures = [], pathByDownstream = new Map(flowCalculation.paths.map(item => [item.downstream, item])), pipeById = new Map(batches.flatMap(batch => batch.records).map(item => [item.expressId, item]));
  for (const node of flowCalculation.order.slice(1)) {
    const upstream = flowCalculation.parentNode[node], path = pathByDownstream.get(node);
    if (!path || !Number.isFinite(hgl.get(upstream))) return { error: "O caminho de pressão não pôde ser associado a todos os trechos." };
    const pipe = pipeById.get(path.expressId), input = projectInputs.pipeHydraulics?.[path.expressId] ?? {};
    if (!String(input.source ?? "").trim()) return { error: "Registre a fonte física do tubo Express ID " + path.expressId + "." };
    let loss;
    try { loss = calculatePipeLoss(flowResults.get(path.expressId), { ...input, lengthM: input.lengthM || pipe?.properties?.find(value => value.name === "Comprimento")?.normalizedValue }, temperature); }
    catch (error) { return { error: "Tubo Express ID " + path.expressId + ": " + error.message }; }
    const elevation = flowCalculation.elevations[node];
    if (!Number.isFinite(elevation)) return { error: "Cota geométrica ausente no nó a jusante do tubo Express ID " + path.expressId + "." };
    const downstreamHgl = hgl.get(upstream) - loss.totalLossM, dynamicPressure = downstreamHgl - elevation;
    hgl.set(node, downstreamHgl);
    const upstreamElevation = upstream === flowCalculation.source ? sourceElevation : flowCalculation.elevations[upstream];
    losses[path.expressId] = { ...loss, diameterMm: Number(input.diameterMm), lengthM: Number(input.lengthM || pipe?.properties?.find(value => value.name === "Comprimento")?.normalizedValue), roughnessMm: Number(input.roughnessMm), localK: Number(input.k), dataSource: input.source, upstreamPressureMca: hgl.get(upstream) - upstreamElevation, downstreamPressureMca: dynamicPressure, networkMinimumMca: networkLimit };
    if (loss.velocity > 3) failures.push("Tubo " + path.expressId + ": velocidade acima de 3 m/s; avaliar limites do projeto e golpe de aríete.");
    if (dynamicPressure < networkLimit) failures.push("Tubo " + path.expressId + ": pressão dinâmica abaixo de 5 kPa.");
  }
  const terminalsResult = [];
  for (const terminal of terminals.filter(item => projectInputs.demands?.[item.expressId]?.include === true && systemKind(item.systemLabel ?? "") === system)) {
    const node = flowCalculation.terminalNodes[terminal.expressId], elevation = node === flowCalculation.source ? sourceElevation : flowCalculation.elevations[node], available = hgl.get(node) - elevation, demand = projectInputs.demands[terminal.expressId], pressureInput = String(demand.pressureMca ?? "").trim();
    if (pressureInput && (!Number.isFinite(Number(pressureInput)) || Number(pressureInput) < 0)) return { error: "Pressão requerida inválida no terminal Express ID " + terminal.expressId + "." };
    const required = Math.max(pressureInput ? Number(pressureInput) : 0, pressureLimit), staticPressure = staticSourcePressure + sourceElevation - elevation;
    if (!Number.isFinite(available)) return { error: "Pressão não determinável no terminal Express ID " + terminal.expressId + "." };
    const result = { expressId: terminal.expressId, available, required, staticPressure, specified: String(demand.pressureMca ?? "").trim() !== "", passed: available >= required && staticPressure <= staticLimit };
    terminalsResult.push(result);
    if (!result.passed) failures.push("Terminal " + terminal.expressId + ": pressão dinâmica insuficiente ou pressão estática acima de 400 kPa.");
  }
  let destinationResult = null;
  if (flowCalculation.tankMode) {
    const node = flowCalculation.destination, elevation = node === flowCalculation.source ? sourceElevation : flowCalculation.elevations[node], available = hgl.get(node) - elevation, staticPressure = staticSourcePressure + sourceElevation - elevation;
    destinationResult = { available, staticPressure, elevation };
    if (!Number.isFinite(available)) return { error: "Pressão não determinável na chegada ao reservatório." };
    if (available < networkLimit) failures.push("Chegada ao reservatório: pressão dinâmica abaixo de 5 kPa.");
    if (staticPressure > staticLimit) failures.push("Chegada ao reservatório: pressão estática acima de 400 kPa.");
  }
  if (sourcePressure < networkLimit) failures.push("Pressão dinâmica na origem abaixo de 5 kPa.");
  if (system === "hot") failures.push("Resultado parcial: retorno e balanceamento da água quente não estão modelados e precisam ser verificados.");
  return { pipes: losses, terminals: terminalsResult, destination: destinationResult, sourcePressureMca: sourcePressure, staticSourcePressureMca: staticSourcePressure, sourceElevationM: sourceElevation, failures, temperature, density: fluid.density, viscosity: fluid.viscosity, method: "Darcy–Weisbach com fator de atrito Churchill; perdas localizadas por K total informado; propriedades da água pela temperatura de entrada." };
}
function evaluateCatalogPump() {
  if (!hydraulicResults || hydraulicResults.error) return { error: "Calcule primeiro as perdas e pressões." };
  if ($("system").value === "hot") return { error: "A curva disponível é de pressurização de água fria; o retorno quente e a temperatura admissível da bomba não foram verificados." };
  const networkDeficit = Math.max(0, hydraulicResults.pipes[Object.keys(hydraulicResults.pipes)[0]]?.networkMinimumMca - hydraulicResults.sourcePressureMca, ...Object.values(hydraulicResults.pipes).map(pipe => pipe.networkMinimumMca - pipe.downstreamPressureMca));
  const terminalDeficit = Math.max(0, ...hydraulicResults.terminals.map(terminal => terminal.required - terminal.available));
  const requiredHeadM = Math.max(networkDeficit, terminalDeficit);
  if (requiredHeadM === 0) return { noPumpRequired: true, requiredHeadM: 0 };
  const qM3h = flowCalculation.totalLps * 3.6, curve = pumpCurves[0], evaluated = evaluatePump(curve, qM3h, requiredHeadM), staticLimit = 400000 / (hydraulicResults.density * 9.80665);
  if (evaluated.error) return { ...evaluated, curve };
  const staticSafe = hydraulicResults.terminals.every(terminal => terminal.staticPressure + requiredHeadM <= staticLimit) && (!hydraulicResults.destination || hydraulicResults.destination.staticPressure + requiredHeadM <= staticLimit);
  const velocitySafe = !hydraulicResults.failures.some(value => value.includes("velocidade acima"));
  return { ...evaluated, curve, staticSafe, velocitySafe, candidate: evaluated.fitsHead && staticSafe && velocitySafe, requiredHeadM, staticLimit, reason: !evaluated.fitsHead ? "A curva não cobre a carga necessária." : !staticSafe ? "A carga adicional elevaria a pressão estática acima do limite verificado." : !velocitySafe ? "A rede excede o alerta de velocidade; corrija antes da seleção." : "Ponto coberto na triagem hidráulica; confirme instalação e dados de catálogo com o fabricante." };
}
function exportCalculationReport() {
  if (!hydraulicResults || hydraulicResults.error || !flowCalculation || flowCalculation.error) return;
  const system = $("system").value, report = {
    application: "Hydros System",
    generatedAt: new Date().toISOString(),
    project: modelName,
    system,
    units: { flow: "L/s (pump curve: m³/h)", pressure: "m.c.a.", diameter: "mm interno", length: "m", roughness: "mm", velocity: "m/s" },
    inputs: { boundary: projectInputs.boundaries?.[system], utility: system === "feed" ? { pressureDynamicMca: Number($("utilityPressure").value), referenceFlowLps: Number($("utilityFlowLps").value), pressureStaticMaxMca: Number($("utilityPressureMax").value), destination: $("destination").value, buildingType: projectInputs.tankBuildingType, dailyVolumeL: Number(projectInputs.dailyVolumeL), refillHours: Number(projectInputs.refillHours) } : null, waterTemperatureC: hydraulicResults.temperature, demands: terminals.filter(item => projectInputs.demands?.[item.expressId]?.include === true).map(item => ({ expressId: item.expressId, name: item.name, flowLps: Number(projectInputs.demands[item.expressId].flowLps), pressureRequiredMca: projectInputs.demands[item.expressId].pressureMca, source: projectInputs.demands[item.expressId].source })), pipes: Object.fromEntries([...flowResults.keys()].map(id => [id, projectInputs.pipeHydraulics[id] ?? {}])) },
    methods: { flow: flowCalculation.method, hydraulics: hydraulicResults.method, pump: pumpResult?.curve ? { source: pumpResult.curve.source, method: pumpResult.method ?? "Fora da faixa tabelada; sem extrapolação." } : null },
    results: { totalFlowLps: flowCalculation.totalLps, pipes: hydraulicResults.pipes, terminals: hydraulicResults.terminals, destination: hydraulicResults.destination, warnings: hydraulicResults.failures, pump: pumpResult },
    standards: ["ABNT NBR 5626:2020, clauses 6.5.3.1, 6.6.4-6.6.5, 6.7.1-6.7.2, 6.8, 6.9, 6.14; confirm current edition/errata before official use."],
    limitations: ["Connections are geometric and manually confirmed.", "Junction elevations use the mean elevation of incident IFC pipe endpoints and the project's vertical datum must be checked.", "Water-hammer, cavitation/NPSH, component-specific loss coefficients, hot-water return balancing and energy sizing are not evaluated.", "Pump result is a catalog curve screening, not final equipment approval.", "Project memorials and example drawings are not calculation sources."]
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = (modelName.replace(/\.[^.]+$/, "") || "hydros") + "-relatorio-hidraulico.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderDemandInputs() {
  const pages = Math.ceil(terminals.length / demandPageSize), start = demandPage * demandPageSize;
  const filled = terminals.filter(item => String(projectInputs.demands?.[item.expressId]?.flowLps ?? "").trim() !== "").length, activeCount = terminals.filter(item => projectInputs.demands?.[item.expressId]?.include === true).length;
  $("demandSummary").className = "summary";
  const tankMode = $("system").value === "feed" && $("destination").value === "tank";
  $("demandSummary").innerHTML = "<dl><dt>" + (tankMode ? "Volume diário informado" : "Pontos IFC de utilização") + "</dt><dd>" + (tankMode ? (Number($("dailyVolumeL").value) || 0).toLocaleString("pt-BR") + " L/dia" : terminals.length.toLocaleString("pt-BR")) + "</dd><dt>" + (tankMode ? "Tempo de reposição" : "Com vazão informada") + "</dt><dd>" + (tankMode ? (Number($("refillHours").value) || 0).toLocaleString("pt-BR") + " h" : filled.toLocaleString("pt-BR")) + "</dd>" + (tankMode ? "<dt>Vazão calculada</dt><dd>" + (flowCalculation && !flowCalculation.error ? flowCalculation.totalLps.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) + " L/s" : "aguardando dados") + "</dd>" : "<dt>Incluídos no cenário</dt><dd>" + activeCount.toLocaleString("pt-BR") + "</dd>") + "</dl><div class=\"warning\">" + (tankMode ? "Reposição calculada como volume diário dividido pelo tempo informado; o limite de 6 h é verificado. A rota até o reservatório deve ter uma única chegada aberta." : "Marque explicitamente os pontos simultâneos. A soma distribui vazão em rede radial; perdas, pressões e diâmetros exigem a etapa hidráulica.") + "</div>";
  $("demandPageLabel").textContent = pages ? (demandPage + 1) + " / " + pages : "0 / 0";
  $("demandPrev").disabled = demandPage === 0; $("demandNext").disabled = demandPage + 1 >= pages;
  $("demandList").innerHTML = terminals.slice(start, start + demandPageSize).map(item => {
    const values = projectInputs.demands?.[item.expressId] ?? {}, identity = String(item.expressId);
    return "<article class=\"candidate demand-item\"><strong>" + escapeHtml(item.name || item.type) + " · " + escapeHtml(item.storey ?? "pavimento não associado") + " · Express ID " + identity + "</strong>" + (item.systemLabel ? "<div class=\"candidate-detail\">Rede IFC: " + escapeHtml(item.systemLabel) + "</div>" : "") + "<label class=\"scenario-check\"><input type=\"checkbox\" data-demand=\"include\" data-express-id=\"" + identity + "\" " + (values.include === true ? "checked" : "") + "> Incluir neste cenário simultâneo</label><div class=\"demand-fields\"><label>Vazão máx. (L/s)<input type=\"number\" min=\"0\" step=\"any\" data-demand=\"flowLps\" data-express-id=\"" + identity + "\" value=\"" + escapeHtml(values.flowLps ?? "") + "\"></label><label>Pressão requerida (m.c.a.)<input type=\"number\" min=\"0\" step=\"any\" data-demand=\"pressureMca\" data-express-id=\"" + identity + "\" value=\"" + escapeHtml(values.pressureMca ?? "") + "\"></label><label>Fonte dos valores<input type=\"text\" maxlength=\"160\" data-demand=\"source\" data-express-id=\"" + identity + "\" value=\"" + escapeHtml(values.source ?? "") + "\" placeholder=\"Fabricante ou especificação\"></label></div></article>";
  }).join("") || "<div class=\"summary empty\">Nenhum IfcSanitaryTerminal foi reconhecido neste IFC.</div>";
  $("btnCalcFlows").disabled = !batches.length;
  $("btnCalcPressure").disabled = !flowCalculation || Boolean(flowCalculation.error);
  $("btnExportReport").disabled = !hydraulicResults || Boolean(hydraulicResults.error);
  $("btnCheckPump").disabled = !hydraulicResults || Boolean(hydraulicResults.error);
  if (pumpResult?.error) $("pumpResult").innerHTML = "<div class=\"warning\">" + escapeHtml(pumpResult.error) + "</div>";
  else if (pumpResult?.noPumpRequired) $("pumpResult").innerHTML = "<div>Não é indicada bomba adicional pelo balanço de pressão calculado.</div>";
  else if (pumpResult) $("pumpResult").innerHTML = "<div><strong>" + escapeHtml(pumpResult.curve.model) + "</strong></div><div>Vazão requerida: " + pumpResult.flowM3h.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m³/h · carga adicional requerida: " + pumpResult.requiredHeadM.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a. · tabela interpolada: " + pumpResult.curveHeadM.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a.</div><div>" + escapeHtml(pumpResult.curve.source) + "</div><div class=\"warning\">" + escapeHtml(pumpResult.reason) + "</div>";
  else $("pumpResult").textContent = "Calcule primeiro vazões, perdas e pressões.";
  if (flowCalculation?.error) $("flowResult").innerHTML = "<div class=\"warning error\">" + escapeHtml(flowCalculation.error) + "</div>";
  else if (flowCalculation) $("flowResult").innerHTML = "<div class=\"summary metadata-block\"><dl><dt>Vazão total do cenário</dt><dd>" + flowCalculation.totalLps.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) + " L/s</dd><dt>Pontos incluídos</dt><dd>" + flowCalculation.terminalCount + "</dd><dt>Método</dt><dd>" + escapeHtml(flowCalculation.method) + "</dd><dt>Trechos atribuídos</dt><dd>" + flowCalculation.result.size + "</dd></dl></div>" + (hydraulicResults?.error ? "<div class=\"warning error\">" + escapeHtml(hydraulicResults.error) + "</div>" : hydraulicResults ? "<div class=\"summary metadata-block\"><strong>Verificação hidráulica</strong><div>" + escapeHtml(hydraulicResults.method) + "</div><div>" + hydraulicResults.terminals.length + " pontos avaliados" + (hydraulicResults.destination ? " · pressão dinâmica na chegada: " + hydraulicResults.destination.available.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a." : "") + " · temperatura " + hydraulicResults.temperature + " °C</div>" + (hydraulicResults.failures.length ? hydraulicResults.failures.map(value => "<div class=\"warning\">" + escapeHtml(value) + "</div>").join("") : "<div class=\"warning\">Pressões dinâmicas e estáticas dentro dos limites verificados para as entradas informadas.</div>") + ($("system").value === "hot" ? "<div class=\"warning\">Dimensionamento incompleto: retorno hidráulico de água quente ainda precisa de modelagem.</div>" : "") + "</div>" : "<div class=\"warning\">Distribuição de vazões somente. Informe os dados físicos por tubo e calcule perdas/pressões para avançar.</div>");
  else { $("flowResult").innerHTML = ""; $("btnCalcPressure").disabled = true; }
}
function focusElement(expressId) {
  const item = batches.flatMap(batch => batch.records).find(record => record.expressId === expressId);
  if (!item) return;
  const box = selectedBox(expressId), point = box.getCenter(new THREE.Vector3());
  setSelection({ item, point }); fit(box, 1.5);
}
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
function pick(event) {
  const rect = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height * 2 - 1));
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(batches.map(b => b.mesh), false); if (!hits.length) return null;
  const hit = hits[0], b = batches.find(x => x.mesh === hit.object), item = b?.records[hit.batchId];
  return item ? { item, point: hit.point } : null;
}
function setSelection(hit) {
  for (const batch of batches) batch.records.forEach((item, id) => { if (item.expressId === selected) batch.mesh.setColorAt(id, new THREE.Color(displayColor(item))); });
  selected = hit?.item.expressId ?? null;
  $("btnSetSource").disabled = !hit;
  $("btnSetTankEnd").disabled = !hit || hit.item.kind !== "pipe" || $("system").value !== "feed" || $("destination").value !== "tank";
  if (hit) {
    for (const batch of batches) batch.records.forEach((item, id) => { if (item.expressId === selected) batch.mesh.setColorAt(id, new THREE.Color(0xf04f37)); });
    controls.setOrbitPoint(hit.point.x, hit.point.y, hit.point.z); showProperties(hit.item);
  } else showProperties(null);
}
function selectedBox(expressId) {
  const box = new THREE.Box3(); world.updateMatrixWorld(true);
  for (const batch of batches) batch.records.forEach(item => { if (item.expressId === expressId) box.union(item.box.clone().applyMatrix4(batch.mesh.matrixWorld)); });
  return box;
}
let down = null;
renderer.domElement.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
  setSelection(pick(e));
});
renderer.domElement.addEventListener("dblclick", e => { const hit = pick(e); if (hit) fit(selectedBox(hit.item.expressId), 1.5); });
$("btnAbrir").onclick = () => host?.postMessage({ type: "openIfc" });
$("btnFit").onclick = () => fit(); $("btnZoom").onclick = () => { if (selected) fit(selectedBox(selected), 1.5); };
$("btnTop").onclick = () => switchView(true); document.querySelector('[data-view="3d"]').onclick = () => switchView(false);
$("btnClear").onclick = () => setSelection(null);
$("filter").onchange = () => {
  const mode = $("filter").value;
  for (const b of batches) b.records.forEach((item, id) => b.mesh.setVisibleAt(id, mode === "all" || (mode === "pipes" ? item.kind === "pipe" : item.kind !== "pipe")));
  if (mode !== "all" && selected) { const item = batches.flatMap(b => b.records).find(x => x.expressId === selected); if (item && ((mode === "pipes") !== (item.kind === "pipe"))) setSelection(null); }
};
$("connectionPrev").onclick = () => { reviewPage = Math.max(0, reviewPage - 1); renderConnectionReview(); };
$("connectionNext").onclick = () => { reviewPage++; renderConnectionReview(); };
$("demandPrev").onclick = () => { demandPage = Math.max(0, demandPage - 1); renderDemandInputs(); };
$("demandNext").onclick = () => { demandPage++; renderDemandInputs(); };
$("demandList").onchange = event => {
  const input = event.target.closest("input[data-demand]"); if (!input) return;
  const id = input.dataset.expressId, field = input.dataset.demand;
  projectInputs.demands[id] = { ...(projectInputs.demands[id] ?? {}), [field]: field === "include" ? input.checked : input.value };
  flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs();
};
$("properties").onchange = event => {
  const input = event.target.closest("input[data-pipe]"); if (!input) return;
  const id = input.dataset.expressId, field = input.dataset.pipe;
  projectInputs.pipeHydraulics[id] = { ...(projectInputs.pipeHydraulics[id] ?? {}), [field]: input.value };
  hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs();
};
$("btnCalcFlows").onclick = () => {
  const calculated = calculateReviewedFlows();
  hydraulicResults = null; pumpResult = null;
  if (calculated.error) { flowResults = new Map(); flowCalculation = calculated; }
  else { flowResults = calculated.result; flowCalculation = calculated; log("Vazões distribuídas no grafo revisado: " + calculated.totalLps.toLocaleString("pt-BR") + " L/s."); }
  if (selected != null) { const item = batches.flatMap(batch => batch.records).find(record => record.expressId === selected); showProperties(item); }
  renderDemandInputs();
};
$("btnCalcPressure").onclick = () => {
  hydraulicResults = calculatePressures();
  pumpResult = null;
  if (hydraulicResults.error) log(hydraulicResults.error);
  else log("Perdas de Darcy–Weisbach e pressões calculadas em " + Object.keys(hydraulicResults.pipes).length + " tubos.");
  renderDemandInputs();
  if (selected != null) { const item = batches.flatMap(batch => batch.records).find(record => record.expressId === selected); showProperties(item); }
};
$("btnCheckPump").onclick = () => { pumpResult = evaluateCatalogPump(); renderDemandInputs(); };
$("btnExportReport").onclick = exportCalculationReport;
$("btnSetSource").onclick = () => {
  if (selected == null) return;
  const item = batches.flatMap(batch => batch.records).find(record => record.expressId === selected); if (!item) return;
  const previousBoundary = projectInputs.boundaries?.[$("system").value];
  const boundary = { expressId: item.expressId, type: item.type, name: item.name, end: item.kind === "pipe" ? Number($("sourceEnd").value) : null, headM: previousBoundary?.headM ?? "", staticHeadM: previousBoundary?.staticHeadM ?? "", elevationM: previousBoundary?.elevationM ?? "", target: previousBoundary?.target ?? null };
  projectInputs.boundaries = { ...projectInputs.boundaries, [$("system").value]: boundary };
  flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; updateBoundaryFields(); saveProjectInputs(); renderDemandInputs();
};
$("btnSetTankEnd").onclick = () => {
  if (selected == null) return;
  const item = batches.flatMap(batch => batch.records).find(record => record.expressId === selected), boundary = projectInputs.boundaries?.feed;
  if (!item || item.kind !== "pipe" || !boundary) { log("Defina primeiro a origem da alimentação e selecione um tubo para a chegada ao reservatório."); return; }
  boundary.target = { expressId: item.expressId, type: item.type, end: Number($("tankEnd").value) };
  flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; updateBoundaryFields(); saveProjectInputs(); renderDemandInputs();
};
$("tankEnd").onchange = () => {
  const target = projectInputs.boundaries?.feed?.target;
  if (target) { target.end = Number($("tankEnd").value); flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs(); }
};
$("sourceEnd").onchange = () => {
  const boundary = projectInputs.boundaries?.[$("system").value];
  if (boundary) { boundary.end = Number($("sourceEnd").value); flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; updateBoundaryFields(); saveProjectInputs(); renderDemandInputs(); }
};
$("sourceHead").onchange = $("sourceStaticHead").onchange = $("sourceElevation").onchange = () => { hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs(); };
$("connectionList").onclick = event => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const candidate = importedCandidates[Number(button.dataset.index)]; if (!candidate) return;
  if (button.dataset.action === "focus") focusElement(candidate.from.expressId);
  else { reviewDecisions[candidate.key] = button.dataset.action; flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; saveReviewDecisions(); renderConnectionReview(); renderDemandInputs(); }
};
$("system").onchange = () => { flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; updateBoundaryFields(); saveProjectInputs(); renderDemandInputs(); };
$("waterTemperature").onchange = () => { hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs(); };
$("utilityPressure").onchange = $("utilityFlowLps").onchange = $("utilityPressureMax").onchange = saveProjectInputs;
$("dailyVolumeL").onchange = $("refillHours").onchange = $("tankBuildingType").onchange = () => { flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs(); };
$("destination").onchange = () => { flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; updateBoundaryFields(); saveProjectInputs(); renderDemandInputs(); };
document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => {
  document.querySelectorAll("[data-tab]").forEach(x => x.classList.toggle("active", x === button));
  document.querySelectorAll(".tab-content").forEach(x => x.hidden = x.id !== `tab-${button.dataset.tab}`);
});
$("colorMode").onchange = () => {
  for (const batch of batches) batch.records.forEach((item, id) => batch.mesh.setColorAt(id, new THREE.Color(item.expressId === selected ? 0xf04f37 : displayColor(item))));
};
$("btnTheme").onclick = () => document.body.classList.toggle("dark");
$("btnOutput").onclick = () => { const panel = $("output"); panel.hidden = !panel.hidden; $("btnOutput").textContent = panel.hidden ? "Saída ▴" : "Saída ▾"; };
document.addEventListener("keydown", e => { if (e.key === "Escape") setSelection(null); if (e.key.toLowerCase() === "f") fit(); });
function setLoading(on, text = "Lendo modelo IFC…", progress = 0) { $("loading").hidden = !on; $("emptyState").hidden = on || batches.length > 0; $("loadText").textContent = text; $("loadProgress").value = progress; }
function renderSummary(data) {
  const total = Object.values(data.counts).reduce((sum, count) => sum + count, 0);
  const units = data.units.map(unit => escapeHtml(unit.type) + ": " + escapeHtml(unit.name)).join(" · ") || "não declaradas";
  const storeys = Object.entries(data.storeys).map(([name, count]) => escapeHtml(name) + " (" + count + ")").join(", ") || "não informados";
  $("projectSummary").className = "summary";
  const networks = Object.entries(data.systemCounts ?? {}).map(([name, count]) => "<dt>Rede IFC · " + escapeHtml(name) + "</dt><dd>" + count.toLocaleString("pt-BR") + "</dd>").join("");
  $("projectSummary").innerHTML = "<h3>" + escapeHtml(data.projectName || modelName) + "</h3><dl><dt>Arquivo</dt><dd>" + escapeHtml(modelName) + "</dd><dt>Esquema</dt><dd>" + escapeHtml(data.schema) + "</dd><dt>Unidades</dt><dd>" + units + "</dd><dt>Fator para metro</dt><dd>" + (data.metresPerUnit == null ? "desconhecido" : "1 unidade IFC = " + data.metresPerUnit + " m") + "</dd><dt>Pavimentos</dt><dd>" + storeys + "</dd><dt>Elementos hidráulicos</dt><dd>" + total.toLocaleString("pt-BR") + "</dd><dt>Elementos com geometria</dt><dd>" + data.elements.toLocaleString("pt-BR") + "</dd>" + Object.entries(data.counts).filter(([, n]) => n).map(([name,n]) => "<dt>" + escapeHtml(name.replace(/^IFC/, "Ifc")) + "</dt><dd>" + n.toLocaleString("pt-BR") + "</dd>").join("") + networks + "<dt>IfcSystem explícito</dt><dd>" + data.explicitSystems + "</dd><dt>Relações de portas</dt><dd>" + data.portRelations + "</dd></dl>";
  const endpointCoverage = data.pipeCount ? Math.round(data.pipesWithEndpoints / data.pipeCount * 100) : 0;
  $("projectSummary").innerHTML += "<div class=\"metadata-block\"><dl><dt>Tubos com endpoints geométricos</dt><dd>" + data.pipesWithEndpoints + " / " + data.pipeCount + " (" + endpointCoverage + "%)</dd><dt>Candidatos de conexão</dt><dd>" + data.candidates.length.toLocaleString("pt-BR") + "</dd></dl></div>";
  const warnings = [...data.warnings, ...(data.duplicateGlobalIds ?? []).map(item => "GlobalId duplicado " + item.id + ": Express IDs " + item.expressIds.join(", ") + "."), ...(data.missingGlobalIds ?? []).map(item => "Sem GlobalId: " + item.type + " Express ID " + item.expressId + ".")];
  $("warnings").innerHTML = warnings.length ? warnings.map(warning => "<div class=\"warning\">" + escapeHtml(warning) + "</div>").join("") : "<div class=\"warning\">Sem avisos nesta leitura. Nenhuma ligação hidráulica foi inferida.</div>";
}
function startImport(file) {
  loadingToken++;
  if (worker) worker.terminate();
  discardPending(); pendingGroup = new THREE.Group(); scene.add(pendingGroup); pendingName = file.name; pendingFileKey = file.fileKey || (file.name + "|" + file.size + "|" + file.modified);
  setLoading(true); status("Importando IFC…"); log(`Arquivo selecionado: ${file.name} (${(file.size/1048576).toFixed(1)} MB).`);
  worker = new Worker("./ifc-worker.js", { type: "module" }); const token = loadingToken;
  worker.onmessage = ({ data }) => {
    if (token !== loadingToken) return;
    if (data.type === "status") { setLoading(true, data.text, data.progress); status(data.text); }
    else if (data.type === "geometry") { renderChunk(data.items, pendingBatches, pendingGroup); }
    else if (data.type === "done") {
      setLoading(false); commitPending(); importedCandidates = data.candidates; terminals = data.terminals ?? []; reviewPage = 0; demandPage = 0; renderSummary(data); renderConnectionReview(); renderDemandInputs(); fit(); status(`Importação concluída: ${data.elements.toLocaleString("pt-BR")} elementos.`);
      $("emptyState").hidden = true; log(`Importação concluída: ${data.elements} elementos IFC com geometria.`); worker.terminate(); worker = null;
    }
    else if (data.type === "error") {
      setLoading(false); discardPending(); host?.postMessage({ type: "modelRejected" }); status("Falha na importação; modelo anterior preservado.");
      log(`Falha ao abrir ${pendingName}: ${data.text}`); if (!modelName) { $("fileName").textContent = "nenhum IFC selecionado"; $("projectSummary").className = "summary empty"; $("projectSummary").textContent = data.text; }
      worker.terminate(); worker = null;
    }
  };
  worker.onerror = e => { setLoading(false); discardPending(); host?.postMessage({ type: "modelRejected" }); status("Falha no leitor IFC; modelo anterior preservado."); log(e.message || "Erro no leitor IFC."); worker?.terminate(); worker = null; };
  worker.postMessage({ type: "load" });
}
host?.addEventListener("message", ({ data }) => {
  if (data?.type === "ifcSelected") startImport(data);
  else if (data?.type === "error") { status(data.text); log(data.text); }
});
