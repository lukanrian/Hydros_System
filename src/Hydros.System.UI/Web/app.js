import * as THREE from "three";
import CameraControls from "./lib/camera-controls.module.js";
import { candidateInSystem, hotWaterPipeRole, pipeInSystem, solveFlows, solvePressures, systemKind, terminalsInSystem } from "./network-solver.js";
import { calculateHotWaterReturn } from "./hot-water-return.js";
import { fillPipeBatch, pendingConnectionsForBatch, pipeBatchGroups } from "./review-batches.js";
import { evaluatePump, pumpCurves, rowaPressurizers, rowaHighFlow, rowaMaxflow, rowaHotCirculators } from "./pump-catalog.js";

const $ = id => document.getElementById(id);
const host = window.chrome?.webview;
const viewport = $("viewport"), scene = new THREE.Scene();
// Fundo transparente: quem pinta o visor é o CSS (--canvas), que acompanha o tema claro/escuro.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
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
const pumpCatalog = [
  ...pumpCurves.map(curve => ({ ...curve, id: curve.id ?? "wdm-" + encodeURIComponent(curve.model), group: "WDM", family: "VPI1", horsepower: 1.5, powerUnit: "cv", applications: ["cold", "feed"], source: curve.source })),
  ...rowaPressurizers.map(pump => ({ ...pump, id: "rowa-" + pump.model.toLowerCase().replaceAll(" ", "-"), group: "ROWA", family: "MAX PRESS", horsepower: pump.powerHp, powerUnit: "HP", curveImage: "./assets/rowa-max-press-2026.png", applications: ["cold", "feed"] })),
  ...rowaHighFlow.map(pump => ({ ...pump, id: "rowa-" + pump.model.toLowerCase().replaceAll(" ", "-"), group: "ROWA", family: "MAX PRESS ALTA VAZÃO", horsepower: pump.powerHp, powerUnit: "HP", curveImage: /(?:VF|MVF)/.test(pump.model) ? "./assets/rowa-max-press-vf-2026.png" : "./assets/rowa-max-press-alta-vazao-2026.png", applications: ["cold", "feed"] })),
  ...rowaMaxflow.map(pump => ({ ...pump, id: "rowa-" + pump.model.toLowerCase().replaceAll(" ", "-"), group: "ROWA", family: "MAXFLOW", horsepower: pump.powerHp, powerUnit: "HP", curveImage: "./assets/rowa-maxflow-2026.png", applications: ["cold", "feed"] })),
  ...rowaHotCirculators.map(pump => ({ ...pump, id: "rowa-" + pump.model.toLowerCase().replaceAll(" ", "-"), group: "ROWA", family: "CIRCULADORAS CONTROLLER", powerValue: pump.powerW, powerUnit: "W", curveImage: "./assets/rowa-circulators-2026.png", applications: ["hot"] }))
];
let selectedPumpId = pumpCatalog[0].id;
const batches = [], pendingBatches = [], outputLines = [];
const colors = { pipe: 0x3d78c5, fitting: 0x8292a6, valve: 0xe5a03c, pump: 0x9a66bb, terminal: 0x39a487, meter: 0x35a8b4, equipment: 0xc0703a, other: 0x8993a1 };
const axis = new THREE.Matrix4().set(1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1);
function typeKind(type = "") {
  const t = type.toLowerCase();
  if (t.includes("pipesegment")) return "pipe";
  if (t.includes("pipefitting")) return "fitting";
  if (t.includes("valve")) return "valve";
  if (t.includes("pump")) return "pump";
  if (t.includes("flowmeter")) return "meter";
  if (t.includes("flowterminal") || t === "ifcsanitaryterminal") return "terminal";
  if (t === "ifctank" || t === "ifcboiler") return "equipment";
  return "other";
}
const systemColors = { cold: 0x3985d4, hot: 0xe85a42, feed: 0x3ca785, unknown: 0x8993a1 };
function displayColor(item) { return $("colorMode").value === "system" ? systemColors[systemKind(item.systemLabel ?? "")] : item.color; }
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
  batches.length = 0; world.clear(); setSelection(null);
  flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null;
}
function commitPending() {
  discardActive();
  world.add(pendingGroup); batches.push(...pendingBatches); pendingBatches.length = 0; pendingGroup = null;
  applyElementColors();
  applyElementFilter();
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
    controlsTop.setFocalOffset(0, 0, 0, false); controlsTop.zoomTo(1, false); controlsTop.setLookAt(center.x, center.y, center.z + Math.max(size.z * 4, 50), center.x, center.y, center.z, false); return;
  }
  const direction = new THREE.Vector3(1, -1, 0.8).normalize();
  const radius = Math.max(size.length() / 2, 0.5);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(perspective.fov / 2)) * padding;
  // A seleção desloca o ponto de órbita; sem zerar esse deslocamento o enquadramento aponta para outro lugar.
  controls3d.setFocalOffset(0, 0, 0, false);
  controls3d.setLookAt(center.x + direction.x * distance, center.y + direction.y * distance, center.z + direction.z * distance, center.x, center.y, center.z, true);
}
function switchView(top) {
  topView = top; controls.enabled = false; camera = top ? ortho : perspective; controls = top ? controlsTop : controls3d; controls.enabled = true;
  document.querySelectorAll("[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === (top ? "top" : "3d")));
  if (batches.length) fit();
}
function pipeHydraulicInput(item) {
  const saved = projectInputs.pipeHydraulics?.[item.expressId] ?? {};
  const property = name => item.properties?.find(value =>
    value.name === name && Number.isFinite(value.normalizedValue) && value.normalizedValue > 0)?.normalizedValue;
  const diameterM = property("Diâmetro interno");
  return {
    ...saved,
    diameterMm: String(saved.diameterMm ?? "").trim() === "" ? (diameterM == null ? "" : diameterM * 1000) : saved.diameterMm,
    lengthM: String(saved.lengthM ?? "").trim() === "" ? property("Comprimento") ?? "" : saved.lengthM
  };
}
const pipeEndKey = (expressId, end) => "p:" + expressId + ":" + end;
function closedEndKeys() {
  return new Set(Object.entries(projectInputs.closedEnds ?? {}).filter(([, closed]) => closed === true).map(([key]) => key));
}
function connectedPipeEnds() {
  const connected = new Set();
  for (const { key, from, to } of importedCandidates) {
    if (reviewDecisions[key] !== "Confirmada") continue;
    connected.add(pipeEndKey(from.expressId, from.end));
    if (to.type.toLowerCase() === "ifcpipesegment") connected.add(pipeEndKey(to.expressId, to.end));
  }
  return connected;
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
  const hydraulicRow = hydraulic ? "<dt>Velocidade</dt><dd>" + hydraulic.velocity.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m/s</dd><dt>Perda total</dt><dd>" + hydraulic.totalLossM.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m de coluna do fluido</dd><dt>Pressão no nó jusante</dt><dd>" + hydraulic.downstreamPressureMca.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a.</dd>" : "";
  const pipeInput = item.kind === "pipe" ? (() => {
    const saved = pipeHydraulicInput(item), diameter = saved.diameterMm, length = saved.lengthM;
    const connected = connectedPipeEnds(), closed = closedEndKeys(), coordinate = value => value.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
    const ends = (item.endpoints ?? []).map((point, end) => {
      const key = pipeEndKey(item.expressId, end), position = "x " + coordinate(point[0]) + " · y " + coordinate(point[1]) + " · z " + coordinate(point[2]) + " m";
      return connected.has(key)
        ? "<div class=\"candidate-detail\">Extremidade " + (end + 1) + " (" + position + "): ligação confirmada.</div>"
        : "<label class=\"scenario-check\"><input type=\"checkbox\" data-closed-end=\"" + key + "\"" + (closed.has(key) ? " checked" : "") + "> Extremidade " + (end + 1) + " (" + position + ") sem vazão neste cálculo</label>";
    }).join("");
    const endsHtml = ends ? "<details class=\"metadata-block\" open><summary>Extremidades</summary>" + ends + "<p class=\"hint\">Marque apenas pontas tampadas, esperas ou saídas fora do cenário. A declaração é registrada no relatório e no memorial.</p></details>" : "";
    const hotInputs = $("system").value === "hot" ? "<label>Perda térmica linear (W/m)<input type=\"number\" min=\"0\" step=\"any\" data-pipe=\"thermalLossWm\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(saved.thermalLossWm ?? "") + "\"></label><label>Fonte da perda térmica<input type=\"text\" maxlength=\"160\" data-pipe=\"thermalSource\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(saved.thermalSource ?? "") + "\" placeholder=\"Memória térmica ou fabricante\"></label>" : "";
    return "<details class=\"metadata-block\" open><summary>Dados hidráulicos do tubo</summary><div class=\"demand-fields\"><label>Diâmetro interno (mm)<input type=\"number\" min=\"0\" step=\"any\" data-pipe=\"diameterMm\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(diameter) + "\"></label><label>Comprimento (m)<input type=\"number\" min=\"0\" step=\"any\" data-pipe=\"lengthM\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(length) + "\"></label><label>Rugosidade absoluta (mm)<input type=\"number\" min=\"0\" step=\"any\" data-pipe=\"roughnessMm\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(saved.roughnessMm ?? "") + "\"></label><label>Soma dos K localizados<input type=\"number\" min=\"0\" step=\"any\" data-pipe=\"k\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(saved.k ?? "") + "\"></label><label>Fonte dos dados hidráulicos<input type=\"text\" maxlength=\"160\" data-pipe=\"source\" data-express-id=\"" + item.expressId + "\" value=\"" + escapeHtml(saved.source ?? "") + "\" placeholder=\"Fabricante, ficha técnica ou medição\"></label>" + hotInputs + "</div></details>" + endsHtml;
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
  projectInputs = { ...saved, demands: saved.demands && typeof saved.demands === "object" && !Array.isArray(saved.demands) ? saved.demands : {}, pipeHydraulics: saved.pipeHydraulics && typeof saved.pipeHydraulics === "object" && !Array.isArray(saved.pipeHydraulics) ? saved.pipeHydraulics : {}, boundaries, closedEnds: saved.closedEnds && typeof saved.closedEnds === "object" && !Array.isArray(saved.closedEnds) ? saved.closedEnds : {} };
  if (["cold", "hot", "feed"].includes(saved.system)) $("system").value = saved.system;
  $("utilityPressure").value = typeof saved.utilityPressure === "string" ? saved.utilityPressure : "";
  $("utilityFlowLps").value = typeof saved.utilityFlowLps === "string" ? saved.utilityFlowLps : "";
  $("utilityPressureMax").value = typeof saved.utilityPressureMax === "string" ? saved.utilityPressureMax : "";
  $("destination").value = saved.destination === "direct" ? "direct" : "tank";
  $("dailyVolumeL").value = typeof saved.dailyVolumeL === "string" ? saved.dailyVolumeL : "";
  $("refillHours").value = typeof saved.refillHours === "string" ? saved.refillHours : "";
  $("tankBuildingType").value = saved.tankBuildingType === "single" ? "single" : saved.tankBuildingType === "other" ? "other" : "";
  $("waterTemperature").value = typeof saved.waterTemperature === "string" ? saved.waterTemperature : "";
  $("hotDeltaT").value = typeof saved.hotDeltaT === "string" ? saved.hotDeltaT : "";
  updateBoundaryFields();
}
function renderSourceLabel() {
  const boundary = projectInputs.boundaries?.[$("system").value];
  const z = flowCalculation?.elevations?.[flowCalculation.source];
  $("sourceLabel").textContent = boundary
    ? boundary.type + " · Express ID " + boundary.expressId + (boundary.end == null ? " · nó do componente" : " · extremidade " + (boundary.end + 1))
      + (Number.isFinite(z) ? " · Z IFC do nó: " + z.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m" : "")
    : "Origem não selecionada para este sistema.";
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
  renderSourceLabel();
  $("tankEndLabel").textContent = boundary?.target ? boundary.target.type + " · Express ID " + boundary.target.expressId + " · extremidade " + (boundary.target.end + 1) : "Extremidade do alimentador junto ao reservatório não selecionada.";
  $("hotReturnInputs").hidden = system !== "hot";
  $("tankEnd").value = String(boundary?.target?.end ?? 0);
  const selectedItem = batches.flatMap(batch => batch.records).find(item => item.expressId === selected);
  $("btnSetTankEnd").disabled = !selectedItem || selectedItem.kind !== "pipe" || system !== "feed" || $("destination").value !== "tank";
}
// O armazenamento local do WebView2 tem cota; em modelos grandes uma falha de gravação perderia trabalho em silêncio.
function storageFailed(what) {
  const message = "Não foi possível salvar " + what + " neste computador (armazenamento local cheio ou indisponível). Exporte o relatório JSON antes de fechar o programa.";
  status(message); log(message);
}
function saveProjectInputs() {
  if (!activeFileKey) return;
  projectInputs = { ...projectInputs, system: $("system").value, utilityPressure: $("utilityPressure").value, utilityFlowLps: $("utilityFlowLps").value, utilityPressureMax: $("utilityPressureMax").value, destination: $("destination").value, dailyVolumeL: $("dailyVolumeL").value, refillHours: $("refillHours").value, tankBuildingType: $("tankBuildingType").value, waterTemperature: $("waterTemperature").value, hotDeltaT: $("hotDeltaT").value };
  const boundary = projectInputs.boundaries?.[projectInputs.system];
  if (boundary) { boundary.headM = $("sourceHead").value; boundary.staticHeadM = $("sourceStaticHead").value; boundary.elevationM = $("sourceElevation").value; }
  try { localStorage.setItem("hydros:inputs:" + activeFileKey, JSON.stringify(projectInputs)); }
  catch { storageFailed("as entradas deste projeto"); }
}
function saveReviewDecisions() {
  try { localStorage.setItem("hydros:reviews:" + activeFileKey, JSON.stringify(reviewDecisions)); }
  catch { storageFailed("as decisões de revisão de conexões"); }
}
function renderConnectionReview() {
  const counts = { Confirmada: 0, Rejeitada: 0, Pendente: 0 };
  importedCandidates.forEach(candidate => { const saved = reviewDecisions[candidate.key]; const decision = saved === "Confirmada" || saved === "Rejeitada" ? saved : "Pendente"; counts[decision]++; });
  const topology = reviewedTopology();
  const pages = Math.ceil(importedCandidates.length / reviewPageSize), start = reviewPage * reviewPageSize;
  $("connectionSummary").className = "summary";
  $("connectionSummary").innerHTML = "<dl><dt>Candidatos de conexão</dt><dd>" + importedCandidates.length.toLocaleString("pt-BR") + "</dd><dt>Por portas IFC</dt><dd>" + importedCandidates.filter(candidate => candidate.source === "ifc-ports").length.toLocaleString("pt-BR") + "</dd><dt>Por geometria (50 mm ou volume da peça)</dt><dd>" + importedCandidates.filter(candidate => candidate.source !== "ifc-ports").length.toLocaleString("pt-BR") + "</dd><dt>Confirmadas manualmente</dt><dd>" + counts.Confirmada + "</dd><dt>Rejeitadas</dt><dd>" + counts.Rejeitada + "</dd><dt>Pendentes</dt><dd>" + counts.Pendente + "</dd><dt>Trechos no grafo revisado</dt><dd>" + topology.pipeCount + "</dd><dt>Extremidades ainda abertas</dt><dd>" + topology.openEnds + "</dd><dt>Declaradas sem vazão</dt><dd>" + topology.declaredClosed + "</dd><dt>Redes desconectadas</dt><dd>" + topology.components + "</dd><dt>Terminais ligados</dt><dd>" + topology.connectedTerminals + " / " + terminals.length + "</dd></dl><div class=\"warning\">As ligações, vindas de portas IFC ou da geometria, só entram no cálculo depois de confirmadas. Um grafo sem pontas abertas ainda não substitui a conferência de fonte, vazões, diâmetros e perdas.</div>";
  $("connectionPageLabel").textContent = pages ? (reviewPage + 1) + " / " + pages : "0 / 0";
  $("connectionPrev").disabled = reviewPage === 0; $("connectionNext").disabled = reviewPage + 1 >= pages;
  $("connectionList").innerHTML = importedCandidates.slice(start, start + reviewPageSize).map((candidate, offset) => {
    const index = start + offset, saved = reviewDecisions[candidate.key], decision = saved === "Confirmada" || saved === "Rejeitada" ? saved : "Pendente";
    const from = candidate.from, to = candidate.to;
    const fromLabel = escapeHtml(from.type.replace(/^Ifc/, "") + " · " + (from.id ?? "sem GlobalId").slice(0, 12) + " · ponta " + (from.end + 1));
    const toLabel = escapeHtml(to.type.replace(/^Ifc/, "") + " · " + (to.id ?? "sem GlobalId").slice(0, 12) + (to.end == null ? "" : " · ponta " + (to.end + 1)));
    const networkWarning = from.system && to.system && from.system !== to.system ? "<div class=\"warning\">Redes IFC distintas: " + escapeHtml(from.system) + " / " + escapeHtml(to.system) + ".</div>" : "";
    return "<article class=\"candidate\"><div class=\"candidate-heading\"><strong>" + fromLabel + " ↔ " + toLabel + "</strong><span class=\"decision " + decision.toLowerCase() + "\">" + decision + "</span></div><div class=\"candidate-detail\">" + (Number.isFinite(candidate.distance_m) ? candidate.distance_m.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) + " m" : "distância não informada") + " · " + escapeHtml(candidate.evidence) + "</div>" + networkWarning + "<div class=\"candidate-actions\"><button class=\"btn small\" data-action=\"focus\" data-index=\"" + index + "\">Focar tubo</button><button class=\"btn small\" data-action=\"Confirmada\" data-index=\"" + index + "\">Confirmar</button><button class=\"btn small\" data-action=\"Rejeitada\" data-index=\"" + index + "\">Rejeitar</button></div></article>";
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
  const pipeIds = new Set();
  for (const { records } of batches) for (const item of records) {
    if (item.kind === "pipe" && item.endpoints?.length === 2) pipeIds.add(item.expressId);
  }
  const adjacency = new Map();
  const closed = closedEndKeys();
  let openEnds = 0, declaredClosed = 0;
  for (const id of pipeIds) {
    const start = pipeKey(id, 0), end = pipeKey(id, 1);
    for (const key of [start, end]) if (!connectedPorts.has(key)) { if (closed.has(key)) declaredClosed++; else openEnds++; }
    const a = find(start), b = find(end);
    if (!adjacency.has(a)) adjacency.set(a, new Set()); if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b); adjacency.get(b).add(a);
  }
  let components = 0; const seen = new Set();
  for (const node of adjacency.keys()) if (!seen.has(node)) {
    components++; const stack = [node]; seen.add(node);
    while (stack.length) for (const next of adjacency.get(stack.pop())) if (!seen.has(next)) { seen.add(next); stack.push(next); }
  }
  return { pipeCount: pipeIds.size, openEnds, declaredClosed, components, connectedTerminals: linkedTerminals.size };
}
function scenarioDemand(item, system) {
  return projectInputs.demandsBySystem?.[system]?.[item.expressId]
    ?? (systemKind(item.systemLabel ?? "") === system ? projectInputs.demands?.[item.expressId] : null)
    ?? {};
}
function scenarioDemands(system) {
  return Object.fromEntries(terminals.map(item => [item.expressId, scenarioDemand(item, system)]));
}
function calculateReviewedFlows() {
  const system = $("system").value;
  return solveFlows({
    system, systemLabel: $("system").selectedOptions[0]?.text, boundary: projectInputs.boundaries?.[system],
    tankMode: system === "feed" && $("destination").value === "tank",
    refillHours: $("refillHours").value, dailyVolumeL: $("dailyVolumeL").value, buildingType: $("tankBuildingType").value,
    records: batches.flatMap(batch => batch.records), candidates: importedCandidates, decisions: reviewDecisions,
    terminals, demands: scenarioDemands(system), closedEnds: closedEndKeys()
  });
}
function calculatePressures() {
  const system = $("system").value;
  const pipeInputs = new Map();
  const records = batches.flatMap(batch => batch.records);
  for (const item of records) {
    if ((flowCalculation?.result?.has(item.expressId) || system === "hot" && hotWaterPipeRole(item)) && !pipeInputs.has(item.expressId))
      pipeInputs.set(item.expressId, pipeHydraulicInput(item));
  }
  const hydraulic = solvePressures({
    flowCalculation, system, boundary: projectInputs.boundaries?.[system], temperatureInput: $("waterTemperature").value,
    utilityPressure: $("utilityPressure").value, utilityStaticPressure: $("utilityPressureMax").value,
    utilityFlow: $("utilityFlowLps").value, pipeInputs, demands: scenarioDemands(system)
  });
  if (system === "hot" && !hydraulic.error) {
    const hotReturn = calculateHotWaterReturn({ records, candidates: importedCandidates, decisions: reviewDecisions,
      boundary: projectInputs.boundaries?.hot, deltaTC: $("hotDeltaT").value, temperatureC: $("waterTemperature").value, pipeInputs });
    hydraulic.hotReturn = hotReturn.error ? null : hotReturn;
    if (hotReturn.error) hydraulic.failures.push("Recirculação não calculada: " + hotReturn.error);
    else hydraulic.failures = hydraulic.failures.filter(message => !message.startsWith("Resultado parcial: retorno e balanceamento"));
  }
  return hydraulic;
}
function evaluateCatalogPump(pump = pumpCatalog.find(item => item.id === selectedPumpId), category = $("system").value) {
  if (!hydraulicResults || hydraulicResults.error) return { error: "Calcule primeiro as perdas e pressões." };
  const system = $("system").value;
  if (system === "hot") return { error: hydraulicResults.hotReturn
    ? "Ponto de recirculação: " + hydraulicResults.hotReturn.totalFlowLps.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) + " L/s e " + hydraulicResults.hotReturn.requiredHeadM.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a. O catálogo não tem curva tabulada de circuladora para avaliar a bomba."
    : "A recirculação não foi calculada: confirme a identificação de retorno, as conexões IFC e as entradas térmicas." };
  if (category !== system || !pump?.applications.includes(system)) return { error: "A classe escolhida não corresponde ao sistema do projeto." };
  if (!pump?.points) return { error: "Este modelo consta no catálogo, mas não tem curva tabulada para avaliar o ponto de operação." };
  const networkDeficit = Math.max(0, hydraulicResults.pipes[Object.keys(hydraulicResults.pipes)[0]]?.networkMinimumMca - hydraulicResults.sourcePressureMca, ...Object.values(hydraulicResults.pipes).map(pipe => pipe.networkMinimumMca - pipe.downstreamPressureMca));
  const terminalDeficit = Math.max(0, ...hydraulicResults.terminals.map(terminal => terminal.required - terminal.available));
  const requiredPressureMca = Math.max(networkDeficit, terminalDeficit);
  if (requiredPressureMca === 0) return { noPumpRequired: true, requiredHeadM: 0 };
  const requiredHeadM = requiredPressureMca / (hydraulicResults.mcaPerMetre ?? 1);
  // Sem consumo a bomba entrega a altura de shutoff (vazão nula): é essa altura que soma na pressão estática dos pontos.
  const qM3h = flowCalculation.totalLps * 3.6, curve = pump, evaluated = evaluatePump(curve, qM3h, requiredHeadM), staticLimit = 400 / 9.80665;
  const shutoffPressureMca = Math.max(...curve.points.map(point => point[1])) * (hydraulicResults.mcaPerMetre ?? 1);
  if (evaluated.error) return { ...evaluated, curve };
  const staticSafe = hydraulicResults.terminals.every(terminal => terminal.staticPressure + shutoffPressureMca <= staticLimit) && (!hydraulicResults.destination || hydraulicResults.destination.staticPressure + shutoffPressureMca <= staticLimit);
  const velocitySafe = !hydraulicResults.failures.some(value => value.includes("velocidade acima"));
  return { ...evaluated, curve, staticSafe, velocitySafe, candidate: evaluated.fitsHead && staticSafe && velocitySafe, requiredHeadM, requiredPressureMca, shutoffPressureMca, staticLimit, reason: !evaluated.fitsHead ? "A curva não cobre a carga necessária." : !staticSafe ? "Com vazão nula, a altura de shutoff da bomba elevaria a pressão estática acima de 400 kPa." : !velocitySafe ? "A rede excede o alerta de velocidade; corrija antes da seleção." : "Ponto coberto na triagem hidráulica; confirme instalação e dados de catálogo com o fabricante." };
}
function pumpStatus(pump, category) {
  const result = evaluateCatalogPump(pump, category);
  if (result.noPumpRequired) return { mark: "—", label: "O balanço calculado não indica necessidade de bomba adicional." };
  if (result.error) return { mark: result.outOfRange ? "×" : "?", label: result.error };
  return { mark: result.candidate ? "✓" : "×", label: result.reason };
}
// Os gráficos do catálogo Rowa não são distribuídos com o código: ficam em Web/assets apenas na instalação local.
const noTabulatedCurve = "<div class=\"summary empty\">O catálogo informa vazão e pressão máximas, mas não traz tabela de pontos da curva deste modelo.</div>";
function pumpCurveSvg(pump) {
  if (!pump.points) return pump.curveImage ? "<figure class=\"pump-source-curve\"><img src=\"" + escapeHtml(pump.curveImage) + "\" alt=\"Curvas de desempenho do catálogo ROWA para a família " + escapeHtml(pump.family) + "\"><figcaption>Gráfico original do Catálogo Técnico Rowa 2026. Referência visual; não foi digitalizado para cálculo.</figcaption></figure>" : noTabulatedCurve;
  const width = 700, height = 340, left = 58, top = 18, plotW = 620, plotH = 270, maxQ = pump.points.at(-1)[0], maxH = Math.ceil(Math.max(...pump.points.map(point => point[1])) / 5) * 5, x = q => left + q / maxQ * plotW, y = h => top + plotH - h / maxH * plotH;
  const grid = Array.from({ length: 6 }, (_, i) => { const q = maxQ * i / 5, h = maxH * i / 5; return "<path class=\"pump-grid\" d=\"M" + x(q) + " " + top + "V" + (top + plotH) + " M" + left + " " + y(h) + "H" + (left + plotW) + "\"/><text x=\"" + x(q) + "\" y=\"" + (top + plotH + 20) + "\" text-anchor=\"middle\">" + q.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "</text><text x=\"" + (left - 8) + "\" y=\"" + (y(h) + 4) + "\" text-anchor=\"end\">" + h + "</text>"; }).join("");
  const line = pump.points.map(([q, h]) => x(q) + "," + y(h)).join(" "), qReq = flowCalculation?.totalLps * 3.6, hReq = pumpResult?.requiredHeadM;
  const target = pumpResult?.curve?.model === pump.model && qReq >= 0 && qReq <= maxQ && hReq >= 0 && hReq <= maxH ? "<circle class=\"pump-target\" cx=\"" + x(qReq) + "\" cy=\"" + y(hReq) + "\" r=\"6\"><title>Ponto requerido</title></circle>" : "";
  return "<svg class=\"pump-chart\" viewBox=\"0 0 " + width + " " + height + "\" role=\"img\" aria-label=\"Curva de vazão e altura da bomba\"><text class=\"pump-chart-title\" x=\"350\" y=\"12\" text-anchor=\"middle\">Curva de vazão e altura</text>" + grid + "<polyline class=\"pump-line\" points=\"" + line + "\"/>" + target + "<text x=\"350\" y=\"330\" text-anchor=\"middle\">Vazão (m³/h)</text><text transform=\"translate(15 160) rotate(-90)\" text-anchor=\"middle\">Altura manométrica (m)</text></svg><div class=\"candidate-detail\">Curva tabulada do fabricante; ponto azul = altura requerida para a vazão calculada, em metros de coluna do fluido. Curva do sistema não representada.</div>";
}
function renderPumpDialog() {
  const category = $("pumpClass").value || $("system").value, available = pumpCatalog.filter(pump => pump.applications.includes(category));
  const fill = (id, values, current) => { const select = $(id); select.innerHTML = values.map(value => "<option value=\"" + escapeHtml(value) + "\">" + (value === "all" ? "Todos" : escapeHtml(value)) + "</option>").join(""); select.value = values.includes(current) ? current : values[0] ?? "all"; };
  const groups = ["all", ...new Set(available.map(pump => pump.group))]; fill("pumpGroup", groups, $("pumpGroup").value || "all");
  const inGroup = available.filter(pump => $("pumpGroup").value === "all" || pump.group === $("pumpGroup").value), families = ["all", ...new Set(inGroup.map(pump => pump.family))]; fill("pumpFamily", families, $("pumpFamily").value || "all");
  const matching = inGroup.filter(pump => $("pumpFamily").value === "all" || pump.family === $("pumpFamily").value);
  if (!matching.some(pump => pump.id === selectedPumpId)) {
    selectedPumpId = matching[0]?.id ?? available[0]?.id ?? pumpCatalog[0].id;
    pumpResult = null;
  }
  $("pumpModel").innerHTML = matching.map(pump => "<option value=\"" + escapeHtml(pump.id) + "\">" + escapeHtml(pump.model) + "</option>").join(""); $("pumpModel").value = selectedPumpId;
  const selectedPump = pumpCatalog.find(pump => pump.id === selectedPumpId);
  const onlyCandidates = $("pumpOnlyCandidates").checked;
  const shown = matching.map(pump => ({ pump, status: pumpStatus(pump, category) }))
    .filter(({ status }) => !onlyCandidates || status.mark !== "×");
  $("pumpCatalogCount").textContent = shown.length + " modelo(s)";
  $("pumpList").innerHTML = shown.map(({ pump, status }) => {
    const qMax = pump.flowM3h ?? pump.points?.at(-1)[0], hMax = pump.pressureMca ?? pump.points?.[0][1];
    const label = escapeHtml(status.label);
    return `<button class="pump-row ${pump.id === selectedPumpId ? "selected" : ""}" data-pump-id="${escapeHtml(pump.id)}">
      <span><strong>${escapeHtml(pump.model)}</strong><small>${escapeHtml(pump.group)} · ${escapeHtml(pump.family)}
      · Pot. ${pump.powerValue ?? pump.horsepower ?? pump.powerHp} ${pump.powerUnit}
      · Q máx. ${qMax.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}
      · H máx. ${hMax.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} m.c.a.</small></span>
      <span class="pump-status" aria-label="${label}" title="${label}">${status.mark}</span></button>`;
  }).join("") || "<div class=\"summary empty\">Nenhum modelo neste filtro.</div>";
  if (selectedPump) {
    const curveDetails = selectedPump.points ? "Curva tabulada · " + selectedPump.points.length + " pontos · " + escapeHtml(selectedPump.source) : "Curva sem pontos tabulados · " + escapeHtml(selectedPump.source);
    const specs = selectedPump.points ? "Potência: " + selectedPump.horsepower + " cv" : "Vazão máxima: " + selectedPump.flowM3h + " m³/h · pressão máxima: " + selectedPump.pressureMca + " m.c.a." + (selectedPump.voltage ? " · tensão: " + selectedPump.voltage + " V" : "") + (selectedPump.currentA ? " · corrente: " + selectedPump.currentA + " A" : "") + (selectedPump.powerValue ? " · potência: " + selectedPump.powerValue + " W" : selectedPump.powerHp ? " · potência: " + selectedPump.powerHp + " HP" : "") + (selectedPump.weightKg ? " · peso: " + selectedPump.weightKg + " kg" : "") + (selectedPump.tankL ? " · tanque: " + selectedPump.tankL + " L" : "") + (selectedPump.temperatureMaxC ? " · temperatura máx.: " + selectedPump.temperatureMaxC + " °C" : "") + (selectedPump.pressureAdjustmentMca ? " · ajuste: " + selectedPump.pressureAdjustmentMca + " m.c.a." : "");
    $("pumpModelDetails").innerHTML = "<h3>" + escapeHtml(selectedPump.model) + "</h3><div>" + specs + "</div>" + (!selectedPump.points ? "<div class=\"candidate-detail\">Vazão e pressão são máximos publicados e não representam necessariamente o mesmo ponto da curva.</div>" : "") + "<div class=\"candidate-detail\">" + curveDetails + "</div>" + (category !== $("system").value ? "<div class=\"warning\">A classe escolhida não corresponde ao sistema do projeto; altere o sistema do projeto para avaliar este ponto.</div>" : category === "hot" ? "<div class=\"warning\">Confirme aplicação, temperatura admissível e retorno/balanceamento para água quente.</div>" : "");
    $("pumpCurve").innerHTML = pumpCurveSvg(selectedPump);
    $("pumpCurve").querySelector("img")?.addEventListener("error", () => { $("pumpCurve").innerHTML = noTabulatedCurve; }, { once: true });
  }
  const resultHtml = pumpResult?.error ? "<div class=\"warning\">" + escapeHtml(pumpResult.error) + "</div>" : pumpResult?.noPumpRequired ? "<div>Não é indicada bomba adicional pelo balanço de pressão calculado.</div>" : pumpResult ? "<div><strong>" + escapeHtml(pumpResult.curve.model) + "</strong></div><div>Vazão requerida: " + pumpResult.flowM3h.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m³/h · déficit de pressão: " + pumpResult.requiredPressureMca.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a. · altura requerida: " + pumpResult.requiredHeadM.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m · altura na curva: " + pumpResult.curveHeadM.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m</div><div class=\"warning\">" + escapeHtml(pumpResult.reason) + "</div>" : "<div class=\"summary empty\">Calcule primeiro vazões, perdas e pressões.</div>";
  $("pumpResult").innerHTML = resultHtml; $("pumpDialogResult").innerHTML = resultHtml;
  $("btnCheckPump").disabled = !hydraulicResults || Boolean(hydraulicResults.error) || category !== $("system").value;
}
function exportCalculationReport() {
  if (!hydraulicResults || hydraulicResults.error || !flowCalculation || flowCalculation.error) return;
  const system = $("system").value;
  const terminalIds = new Set(hydraulicResults.terminals.map(point => point.expressId));
  const demands = terminals.filter(item => terminalIds.has(item.expressId)).map(item => {
    const demand = scenarioDemand(item, system);
    return { expressId: item.expressId, name: item.name, flowLps: Number(demand.flowLps),
      pressureRequiredMca: demand.pressureMca, source: demand.source };
  });
  const pipes = Object.fromEntries(Object.entries(hydraulicResults.pipes).map(([id, pipe]) => [
    id, { ...projectInputs.pipeHydraulics?.[id], diameterMm: pipe.diameterMm, lengthM: pipe.lengthM,
      roughnessMm: pipe.roughnessMm, k: pipe.localK, source: pipe.dataSource }
  ]));
  const report = {
    application: "Hydros System",
    generatedAt: new Date().toISOString(),
    project: modelName,
    system,
    units: { flow: "L/s (curva da bomba em m³/h)", pressure: "m.c.a. convencional (1 m.c.a. = 9,80665 kPa)", diameter: "mm interno", length: "m", roughness: "mm", velocity: "m/s" },
    inputs: {
      boundary: projectInputs.boundaries?.[system],
      utility: system === "feed" ? {
        pressureDynamicMca: Number($("utilityPressure").value), referenceFlowLps: Number($("utilityFlowLps").value),
        pressureStaticMaxMca: Number($("utilityPressureMax").value), destination: $("destination").value,
        buildingType: projectInputs.tankBuildingType, dailyVolumeL: Number(projectInputs.dailyVolumeL),
        refillHours: Number(projectInputs.refillHours)
      } : null,
      waterTemperatureC: hydraulicResults.temperature,
      hotReturn: system === "hot" ? { deltaTC: hydraulicResults.hotReturn?.deltaTC ?? Number($("hotDeltaT").value),
        pipeThermalLoss: Object.fromEntries(Object.entries(projectInputs.pipeHydraulics ?? {}).filter(([, input]) => String(input.thermalLossWm ?? "").trim() !== "")
          .map(([id, input]) => [id, { thermalLossWm: Number(input.thermalLossWm), lengthM: Number(input.lengthM), source: input.thermalSource }])) } : null,
      elevationReference: {
        sourceIfcElevationM: hydraulicResults.sourceIfcElevationM,
        elevationOffsetM: hydraulicResults.elevationOffsetM
      },
      scope: { unreachedPipes: flowCalculation.unreachedPipes, declaredClosedEnds: flowCalculation.declaredClosedEnds },
      demands, pipes
    },
    methods: { flow: flowCalculation.method, hydraulics: hydraulicResults.method, hotReturn: hydraulicResults.hotReturn?.method ?? null, pump: pumpResult?.curve ? { source: pumpResult.curve.source, method: pumpResult.method ?? "Fora da faixa tabelada; sem extrapolação." } : null },
    results: { totalFlowLps: flowCalculation.totalLps, pipes: hydraulicResults.pipes, terminals: hydraulicResults.terminals, destination: hydraulicResults.destination, hotReturn: hydraulicResults.hotReturn, warnings: hydraulicResults.failures, pump: pumpResult },
    standards: ["ABNT NBR 5626:2020, itens 6.5.3.1, 6.6.4–6.6.5, 6.7.1–6.7.2, 6.8, 6.9 e 6.14. Confirme a edição vigente e suas erratas."],
    limitations: [
      "Conexões geométricas confirmadas manualmente.",
      "As cotas dos nós partem da média das extremidades dos tubos incidentes no IFC.",
      "Golpe de aríete, cavitação/NPSH, perdas individuais de componentes e dimensionamento energético estão fora do cálculo.",
      "O retorno requer classificação explícita no IFC; válvulas de balanceamento e curvas de circuladoras não são selecionadas automaticamente.",
      "O resultado de bomba representa uma triagem pela curva do catálogo.",
      "Memoriais e pranchas de exemplo servem como referências de apresentação."
    ]
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = (modelName.replace(/\.[^.]+$/, "") || "hydros") + "-relatorio-hidraulico.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function generateMemorial() {
  if (!hydraulicResults || hydraulicResults.error || !flowCalculation || flowCalculation.error) return;
  if (!host) { status("Abra o Hydros System no aplicativo para salvar o memorial em Word."); return; }

  const fmt = (value, digits = 3) => {
    if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
    return Number(value).toLocaleString("pt-BR", { maximumFractionDigits: digits });
  };
  const system = $("system"), boundary = projectInputs.boundaries?.[system.value] ?? {};
  const systemLabel = system.selectedOptions[0]?.text ?? system.value;
  const pipes = Object.entries(hydraulicResults.pipes).map(([id, pipe]) => [
    id, fmt(pipe.flowLps), fmt(pipe.diameterMm, 1), fmt(pipe.lengthM, 2), fmt(pipe.velocity),
    fmt(pipe.majorLossM), fmt(pipe.minorLossM), fmt(pipe.totalLossM), pipe.dataSource || "—"
  ]);
  const terminalsById = new Map(terminals.map(item => [item.expressId, item]));
  const points = hydraulicResults.terminals.map(terminal => {
    const item = terminalsById.get(terminal.expressId);
    const demand = item ? scenarioDemand(item, system.value) : {};
    return [
      (item?.name || item?.type || "Ponto IFC") + " · " + terminal.expressId,
      fmt(demand.flowLps), fmt(terminal.available), fmt(terminal.required), fmt(terminal.staticPressureKpa, 1),
      demand.source || "—", terminal.passed ? "Atende" : "Não atende"
    ];
  });
  const destination = hydraulicResults.destination;
  const hotReturn = hydraulicResults.hotReturn;
  const returnRows = hotReturn?.branches.map(branch => [
    branch.id + (branch.junctionExpressId == null ? "" : " · IFC " + branch.junctionExpressId), fmt(branch.heatLossW, 1),
    fmt(branch.flowLps, 4), fmt(branch.loopHeadM), fmt(branch.additionalBalancingHeadM)
  ]) ?? [];
  const recordsById = new Map(batches.flatMap(batch => batch.records).map(item => [item.expressId, item]));
  const returnThermalRows = hotReturn ? Object.entries(hotReturn.thermalLossWByPipe).map(([id, heatW]) => {
    const input = projectInputs.pipeHydraulics?.[id] ?? {}, item = recordsById.get(Number(id));
    return [id, hotWaterPipeRole(item) === "return" ? "Retorno" : "Distribuição", fmt(input.thermalLossWm, 2),
      fmt(input.lengthM, 2), fmt(heatW, 1), fmt(hotReturn.flowByPipe[id], 4), input.thermalSource || "—"];
  }) : [];
  const warnings = [
    ...hydraulicResults.failures,
    ...(hotReturn?.unservedPipeIds.length ? ["Tubos de água quente fora das alças de recirculação (não incluídos no cálculo): Express ID " + hotReturn.unservedPipeIds.join(", ") + "."] : []),
    ...(flowCalculation.unreachedPipes ? [flowCalculation.unreachedPipes + " tubo(s) da mesma classe de rede não são alcançados a partir da origem e ficaram fora deste cálculo."] : []),
    ...(flowCalculation.declaredClosedEnds.length ? ["Pontas declaradas sem vazão pelo projetista (Express ID · extremidade): " + flowCalculation.declaredClosedEnds.map(item => item.expressId + " · " + (item.end + 1)).join("; ") + "."] : []),
    ...(pumpResult?.error ? [pumpResult.error] : []),
    ...(pumpResult?.reason ? [pumpResult.reason] : []),
    "As ligações IFC foram revisadas manualmente. Confirme cota, datum, propriedades e especificações de fabricante antes da emissão executiva."
  ];
  let pumpDescription = "Nenhuma bomba foi avaliada neste cenário.";
  if (pumpResult?.error) {
    pumpDescription = "Modelo selecionado: " + (pumpCatalog.find(pump => pump.id === selectedPumpId)?.model ?? "—") + " · " + pumpResult.error;
  } else if (pumpResult?.curve) {
    pumpDescription = pumpResult.curve.model + " · vazão " + fmt(pumpResult.flowM3h) + " m³/h · déficit de pressão "
      + fmt(pumpResult.requiredPressureMca) + " m.c.a. · altura requerida " + fmt(pumpResult.requiredHeadM)
      + " m · altura interpolada " + fmt(pumpResult.curveHeadM) + " m · fonte: " + pumpResult.curve.source;
  } else if (pumpResult?.noPumpRequired) {
    pumpDescription = "O balanço calculado não indica necessidade de bomba adicional.";
  }

  host.postMessage({ type: "saveMemorial", sections: [
    { title: "1. Identificação e escopo", paragraphs: [
      "Arquivo IFC: " + modelName,
      "Sistema: " + systemLabel,
      "Este memorial registra as entradas informadas, o método e as verificações do cenário calculado. Memoriais e desenhos de outros projetos não são fonte de critérios ou valores numéricos."
    ] },
    { title: "2. Dados e condições de contorno", paragraphs: [
      "Vazão de projeto: " + fmt(flowCalculation.totalLps, 4) + " L/s · Temperatura: " + fmt(hydraulicResults.temperature, 1) + " °C",
      "Origem: " + (boundary.name || boundary.type || "concessionária") + " · Pressão dinâmica: "
        + fmt(hydraulicResults.sourcePressureMca) + " m.c.a. · Pressão estática: " + fmt(hydraulicResults.staticSourcePressureMca)
        + " m.c.a. · Cota: " + fmt(hydraulicResults.sourceElevationM) + " m",
      "Z da origem no IFC: " + fmt(hydraulicResults.sourceIfcElevationM) + " m · Ajuste aplicado às cotas do IFC: "
        + fmt(hydraulicResults.elevationOffsetM) + " m",
      "Demandas: " + hydraulicResults.terminals.length + " ponto(s) · Vazões: " + flowCalculation.method,
      ...(system.value === "hot" ? ["ΔT entre ida e retorno: " + fmt(hotReturn?.deltaTC ?? $("hotDeltaT").value, 2) + " °C"] : [])
    ] },
    { title: "3. Método", paragraphs: [
      hydraulicResults.method,
      "As propriedades da água são calculadas pela temperatura informada. Cada trecho usa o diâmetro interno, comprimento, rugosidade absoluta, K localizado e fonte cadastrados pelo projetista.",
      ...(hotReturn ? [hotReturn.method, "ΔT de projeto: " + fmt(hotReturn.deltaTC, 2) + " °C · perda térmica total: " + fmt(hotReturn.totalHeatLossW, 1) + " W · vazão total de retorno: " + fmt(hotReturn.totalFlowLps, 4) + " L/s"] : [])
    ] },
    { title: "4. Resultados por trecho", paragraphs: [],
      columns: ["IFC ID", "Q (L/s)", "Di (mm)", "L (m)", "v (m/s)", "hf (m)", "hl (m)", "h total (m)", "Fonte dos dados"],
      rows: pipes
    },
    { title: "5. Pressões nos pontos",
      paragraphs: destination ? [
        "Chegada ao reservatório: pressão dinâmica " + fmt(destination.available)
          + " m.c.a. · pressão estática " + fmt(destination.staticPressure) + " m.c.a."
      ] : [],
      columns: ["Ponto", "Q (L/s)", "Dinâmica (m.c.a.)", "Requerida (m.c.a.)", "Estática (kPa)", "Fonte da demanda", "Verificação"],
      rows: points
    },
    ...(system.value === "hot" ? [{ title: "6. Alças de recirculação", paragraphs: hotReturn ? ["Altura de circulação pela alça crítica: " + fmt(hotReturn.requiredHeadM) + " m.c.a. A perda adicional indicada deve ser atendida pelo dispositivo de balanceamento selecionado."] : ["Cálculo indisponível: " + (hydraulicResults.failures.find(value => value.startsWith("Recirculação não calculada:")) ?? "dados de retorno ausentes no IFC ou no projeto.")],
      columns: ["Alça", "Perda térmica (W)", "Vazão (L/s)", "Perda do circuito (m.c.a.)", "Perda para balancear (m.c.a.)"], rows: returnRows },
      { title: "7. Entradas de perda térmica por tubo", paragraphs: hotReturn ? ["Fonte e perda térmica linear informadas para cada trecho que participa das alças."] : ["Sem cálculo de recirculação, não há perdas térmicas por tubo apresentadas."],
        columns: ["IFC ID", "Rede", "Perda linear (W/m)", "Comprimento (m)", "Perda total (W)", "Vazão no tubo (L/s)", "Fonte"], rows: returnThermalRows }] : []),
    { title: system.value === "hot" ? "8. Bomba" : "6. Bomba", paragraphs: [pumpDescription] },
    { title: system.value === "hot" ? "9. Verificações e ressalvas" : "7. Verificações e ressalvas", paragraphs: warnings },
    { title: system.value === "hot" ? "10. Referência normativa" : "8. Referência normativa", paragraphs: [
      "ABNT NBR 5626:2020, conforme aplicável ao sistema. A edição vigente e suas emendas devem ser confirmadas antes da emissão oficial.",
      "Documento gerado automaticamente para revisão do responsável técnico. Não substitui validação de dados, especificações dos fabricantes ou responsabilidade profissional."
    ] }
  ] });
}
// Erros de cálculo citam o Express ID do elemento; o botão leva direto a ele no 3D.
function errorHtml(message) {
  const ids = [...new Set([...String(message).matchAll(/Express ID (\d+)/g)].map(match => Number(match[1])))].slice(0, 3);
  return "<div class=\"warning error\">" + escapeHtml(message) + ids.map(id => " <button class=\"btn small\" data-focus-id=\"" + id + "\">Focar " + id + "</button>").join("") + "</div>";
}
function hotReturnHtml(result, failures = []) {
  if (result) return "<div class=\"summary metadata-block\"><strong>Recirculação de água quente</strong><div>Vazão total: " + result.totalFlowLps.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) + " L/s · altura da alça crítica: " + result.requiredHeadM.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a. · perda térmica: " + result.totalHeatLossW.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " W · ΔT: " + result.deltaTC.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " °C</div>" + result.branches.map(branch => "<div class=\"candidate-detail\">Alça " + branch.id + (branch.junctionExpressId == null ? "" : " · junção IFC " + branch.junctionExpressId) + ": " + branch.heatLossW.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " W · " + branch.flowLps.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) + " L/s · perda " + branch.loopHeadM.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a. · perda adicional para balancear " + branch.additionalBalancingHeadM.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a.</div>").join("") + (result.unservedPipeIds.length ? "<div class=\"warning\">Tubos fora das alças, não incluídos no cálculo (Express ID): " + result.unservedPipeIds.join(", ") + ".</div>" : "") + "<p class=\"hint\">A perda adicional é uma meta para o regulador do ramal; a seleção da válvula e da circuladora depende de dados de fabricante.</p></div>";
  const failure = failures.find(value => value.startsWith("Recirculação não calculada:"));
  return failure ? "<div class=\"warning\">" + escapeHtml(failure) + "</div>" : "<div class=\"warning\">Recirculação ainda não calculada.</div>";
}
function renderDemandInputs() {
  renderSourceLabel();
  const system = $("system").value;
  const scenarioTerminals = terminalsInSystem(terminals, importedCandidates, system);
  const pages = Math.ceil(scenarioTerminals.length / demandPageSize);
  demandPage = Math.min(demandPage, Math.max(0, pages - 1));
  const start = demandPage * demandPageSize;
  const filled = scenarioTerminals.filter(item => String(scenarioDemand(item, system).flowLps ?? "").trim() !== "").length;
  const activeCount = scenarioTerminals.filter(item => scenarioDemand(item, system).include === true).length;
  $("demandSummary").className = "summary";
  const tankMode = $("system").value === "feed" && $("destination").value === "tank";
  $("demandSummary").innerHTML = "<dl><dt>" + (tankMode ? "Volume diário informado" : "Pontos de utilização desta rede") + "</dt><dd>" + (tankMode ? (Number($("dailyVolumeL").value) || 0).toLocaleString("pt-BR") + " L/dia" : scenarioTerminals.length.toLocaleString("pt-BR")) + "</dd><dt>" + (tankMode ? "Tempo de reposição" : "Com vazão informada") + "</dt><dd>" + (tankMode ? (Number($("refillHours").value) || 0).toLocaleString("pt-BR") + " h" : filled.toLocaleString("pt-BR")) + "</dd>" + (tankMode ? "<dt>Vazão calculada</dt><dd>" + (flowCalculation && !flowCalculation.error ? flowCalculation.totalLps.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) + " L/s" : "aguardando dados") + "</dd>" : "<dt>Incluídos no cenário</dt><dd>" + activeCount.toLocaleString("pt-BR") + "</dd>") + "</dl><div class=\"warning\">" + (tankMode ? "A vazão de reposição é o volume diário dividido pelo tempo informado. O limite é de 3 h em edificações unifamiliares e 6 h nas demais. A rota até o reservatório deve ter uma única chegada aberta." : "Marque explicitamente os pontos simultâneos. A soma distribui vazão em rede radial; perdas, pressões e diâmetros exigem a etapa hidráulica.") + "</div>";
  $("demandPageLabel").textContent = pages ? (demandPage + 1) + " / " + pages : "0 / 0";
  $("demandPrev").disabled = demandPage === 0; $("demandNext").disabled = demandPage + 1 >= pages;
  $("demandList").innerHTML = scenarioTerminals.slice(start, start + demandPageSize).map(item => {
    const values = scenarioDemand(item, system), identity = String(item.expressId);
    return "<article class=\"candidate demand-item\"><strong>" + escapeHtml(item.name || item.type) + " · " + escapeHtml(item.storey ?? "pavimento não associado") + " · Express ID " + identity + "</strong>" + (item.systemLabel ? "<div class=\"candidate-detail\">Rede IFC: " + escapeHtml(item.systemLabel) + "</div>" : "") + "<label class=\"scenario-check\"><input type=\"checkbox\" data-demand=\"include\" data-express-id=\"" + identity + "\" " + (values.include === true ? "checked" : "") + "> Incluir neste cenário simultâneo</label><div class=\"demand-fields\"><label>Vazão máx. (L/s)<input type=\"number\" min=\"0\" step=\"any\" data-demand=\"flowLps\" data-express-id=\"" + identity + "\" value=\"" + escapeHtml(values.flowLps ?? "") + "\"></label><label>Pressão requerida (m.c.a.)<input type=\"number\" min=\"0\" step=\"any\" data-demand=\"pressureMca\" data-express-id=\"" + identity + "\" value=\"" + escapeHtml(values.pressureMca ?? "") + "\"></label><label>Fonte dos valores<input type=\"text\" maxlength=\"160\" data-demand=\"source\" data-express-id=\"" + identity + "\" value=\"" + escapeHtml(values.source ?? "") + "\" placeholder=\"Fabricante ou especificação\"></label></div></article>";
  }).join("") || "<div class=\"summary empty\">Nenhum ponto de utilização associado a esta rede.</div>";
  $("btnCalcFlows").disabled = $("btnAnalyze").disabled = !batches.length;
  $("btnCalcPressure").disabled = !flowCalculation || Boolean(flowCalculation.error);
  $("btnExportReport").disabled = !hydraulicResults || Boolean(hydraulicResults.error);
  $("btnMemorial").disabled = !hydraulicResults || Boolean(hydraulicResults.error) || !flowCalculation || Boolean(flowCalculation.error);
  const returnResultHtml = system === "hot" && hydraulicResults
    ? hotReturnHtml(hydraulicResults.hotReturn, hydraulicResults.failures) : "";
  for (const action of $("filesMenu").querySelectorAll("button[data-file-action]")) action.disabled = $(action.dataset.fileAction).disabled;
  renderConnectionBatch();
  renderPipeBatch();
  renderPumpDialog();
  if (flowCalculation?.error) $("flowResult").innerHTML = errorHtml(flowCalculation.error);
  else if (flowCalculation) $("flowResult").innerHTML = "<div class=\"summary metadata-block\"><dl><dt>Vazão total do cenário</dt><dd>" + flowCalculation.totalLps.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) + " L/s</dd><dt>Pontos incluídos</dt><dd>" + flowCalculation.terminalCount + "</dd><dt>Método</dt><dd>" + escapeHtml(flowCalculation.method) + "</dd><dt>Trechos atribuídos</dt><dd>" + flowCalculation.result.size + "</dd>" + (flowCalculation.unreachedPipes ? "<dt>Tubos de outras redes da mesma classe, fora do cálculo</dt><dd>" + flowCalculation.unreachedPipes + "</dd>" : "") + (flowCalculation.declaredClosedEnds.length ? "<dt>Pontas declaradas sem vazão</dt><dd>" + flowCalculation.declaredClosedEnds.length + "</dd>" : "") + "</dl></div>" + (hydraulicResults?.error ? errorHtml(hydraulicResults.error) : hydraulicResults ? "<div class=\"summary metadata-block\"><strong>Verificação hidráulica</strong><div>" + escapeHtml(hydraulicResults.method) + "</div><div>" + hydraulicResults.terminals.length + " pontos avaliados" + (hydraulicResults.destination ? " · pressão dinâmica na chegada: " + hydraulicResults.destination.available.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " m.c.a." : "") + " · temperatura " + hydraulicResults.temperature + " °C</div>" + (hydraulicResults.failures.length ? hydraulicResults.failures.map(value => "<div class=\"warning\">" + escapeHtml(value) + "</div>").join("") : "<div class=\"warning\">Pressões dinâmicas e estáticas dentro dos limites verificados para as entradas informadas.</div>") + "</div>" + returnResultHtml : "<div class=\"warning\">Distribuição de vazões somente. Informe os dados físicos por tubo e calcule perdas/pressões para avançar.</div>");
  else { $("flowResult").innerHTML = ""; $("btnCalcPressure").disabled = true; }
}
function activePipes(system) {
  const pipes = new Map();
  for (const { records } of batches) for (const item of records) {
    if (pipeInSystem(item, system) && item.endpoints?.length === 2) pipes.set(item.expressId, item);
  }
  return pipes;
}
let openEndCursor = -1;
function openEndsOfActiveNetwork() {
  const system = $("system").value, boundary = projectInputs.boundaries?.[system], connected = connectedPipeEnds(), closed = closedEndKeys();
  const skip = new Set();
  if (boundary?.type?.toLowerCase() === "ifcpipesegment") skip.add(pipeEndKey(boundary.expressId, boundary.end ?? 0));
  if (system === "feed" && $("destination").value === "tank" && boundary?.target) skip.add(pipeEndKey(boundary.target.expressId, boundary.target.end));
  const open = [];
  for (const pipe of activePipes(system).values()) for (const end of [0, 1]) {
    const key = pipeEndKey(pipe.expressId, end);
    if (!connected.has(key) && !closed.has(key) && !skip.has(key)) open.push({ expressId: pipe.expressId, end });
  }
  return open;
}
function connectionBatchPending() {
  const system = $("system").value, pipes = activePipes(system), boundary = projectInputs.boundaries?.[system];
  const isPipe = end => end.type.toLowerCase() === "ifcpipesegment";
  // A origem e a chegada ao reservatório precisam continuar abertas.
  const reserved = closedEndKeys();
  if (boundary && isPipe(boundary)) reserved.add("p:" + boundary.expressId + ":" + (boundary.end ?? 0));
  if (system === "feed" && $("destination").value === "tank" && boundary?.target) reserved.add("p:" + boundary.target.expressId + ":" + boundary.target.end);
  // Reservatórios e aquecedores definem onde a rede começa e termina: ficam para a revisão individual.
  const canConfirm = ({ from, to }) => pipes.has(from.expressId) && (!isPipe(to) || pipes.has(to.expressId)) && !["ifctank", "ifcboiler"].includes(to.type.toLowerCase());
  return pendingConnectionsForBatch(importedCandidates, reviewDecisions, candidate => candidateInSystem(candidate, system), canConfirm, reserved);
}
function renderConnectionBatch() {
  const pending = importedCandidates.length ? connectionBatchPending() : [];
  const label = $("system").selectedOptions[0]?.text ?? $("system").value;
  $("connectionBatch").hidden = !importedCandidates.length;
  $("btnConfirmConnectionBatch").disabled = !pending.length;
  const open = openEndsOfActiveNetwork().length;
  $("btnNextOpenEnd").disabled = !open;
  $("btnNextOpenEnd").textContent = "Ir para a próxima ponta aberta (" + open.toLocaleString("pt-BR") + ")";
  $("connectionBatchHint").textContent = pending.length
    ? pending.length.toLocaleString("pt-BR") + " ligação(ões) pendente(s) da rede " + label + " sem disputa de extremidade. As demais, e as ligações a reservatórios e aquecedores, continuam na revisão individual."
    : "Nenhuma ligação pendente da rede " + label + " pode ser confirmada em lote; revise as restantes uma a uma.";
}
let pipeBatchIds = [];
function renderPipeBatch() {
  const pipes = [...activePipes($("system").value).values()];
  $("pipeBatch").hidden = !pipes.length;
  if (!pipes.length) { pipeBatchIds = []; return; }
  const groups = pipeBatchGroups(pipes, pipeHydraulicInput);
  const fill = (select, entries) => {
    const current = select.value;
    select.innerHTML = entries.map(([value, text]) => "<option value=\"" + escapeHtml(value) + "\">" + escapeHtml(text) + "</option>").join("");
    select.value = entries.some(([value]) => value === current) ? current : entries[0]?.[0] ?? "";
  };
  const size = diameters => [...diameters.values()].reduce((sum, ids) => sum + ids.length, 0);
  fill($("pipeBatchMaterial"), [...groups].sort(([a], [b]) => a.localeCompare(b, "pt-BR")).map(([name, diameters]) => [name, name + " (" + size(diameters) + ")"]));
  const diameters = groups.get($("pipeBatchMaterial").value) ?? new Map();
  fill($("pipeBatchDiameter"), [...diameters].sort(([a], [b]) => (a === "missing") - (b === "missing") || Number(a) - Number(b))
    .map(([key, ids]) => [key, (key === "missing" ? "Sem diâmetro interno" : Number(key).toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " mm") + " (" + ids.length + ")"]));
  pipeBatchIds = diameters.get($("pipeBatchDiameter").value) ?? [];
  const saved = projectInputs.pipeHydraulics ?? {}, empty = field => pipeBatchIds.filter(id => String(saved[id]?.[field] ?? "").trim() === "").length;
  $("pipeBatchCount").textContent = pipeBatchIds.length.toLocaleString("pt-BR") + " tubo(s) no grupo · " + empty("roughnessMm") + " sem rugosidade · " + empty("k") + " sem K · " + empty("source") + " sem fonte.";
  $("btnApplyPipeBatch").disabled = !pipeBatchIds.length;
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
$("btnAnalyze").onclick = () => {
  document.querySelector('[data-tab="pontos"]').click();
  $("btnCalcFlows").click();
  if (!$("btnCalcPressure").disabled) $("btnCalcPressure").click();
};
const filesMenu = $("filesMenu");
filesMenu.onclick = event => {
  const action = event.target.closest("button[data-file-action]");
  if (!action || action.disabled) return;
  filesMenu.open = false;
  filesMenu.querySelector("summary").focus();
  $(action.dataset.fileAction).click();
};
filesMenu.onkeydown = event => {
  if (event.key !== "Escape" || !filesMenu.open) return;
  filesMenu.open = false;
  filesMenu.querySelector("summary").focus();
  event.preventDefault();
};
document.addEventListener("click", event => { if (filesMenu.open && !filesMenu.contains(event.target)) filesMenu.open = false; });
$("btnFit").onclick = () => fit(); $("btnZoom").onclick = () => { if (selected) fit(selectedBox(selected), 1.5); };
$("btnTop").onclick = () => switchView(true); document.querySelector('[data-view="3d"]').onclick = () => switchView(false);
$("btnClear").onclick = () => setSelection(null);
function applyElementFilter() {
  const mode = $("filter").value;
  const visible = item => mode === "all" || (mode === "pipes") === (item.kind === "pipe");
  let selectionHidden = false;
  for (const batch of batches) batch.records.forEach((item, id) => {
    const isVisible = visible(item);
    batch.mesh.setVisibleAt(id, isVisible);
    if (!isVisible && item.expressId === selected) selectionHidden = true;
  });
  if (selectionHidden) setSelection(null);
}
$("filter").onchange = applyElementFilter;
$("connectionPrev").onclick = () => { reviewPage = Math.max(0, reviewPage - 1); renderConnectionReview(); };
$("connectionNext").onclick = () => { reviewPage++; renderConnectionReview(); };
$("demandPrev").onclick = () => { demandPage = Math.max(0, demandPage - 1); renderDemandInputs(); };
$("demandNext").onclick = () => { demandPage++; renderDemandInputs(); };
$("demandList").onchange = event => {
  const input = event.target.closest("input[data-demand]"); if (!input) return;
  if (input.validity.badInput) { input.reportValidity(); return; }
  const id = Number(input.dataset.expressId), field = input.dataset.demand, system = $("system").value;
  const item = terminals.find(terminal => terminal.expressId === id);
  if (!item) return;
  const bySystem = projectInputs.demandsBySystem ??= {};
  const entries = bySystem[system] ??= {};
  entries[id] = { ...scenarioDemand(item, system), [field]: field === "include" ? input.checked : input.value };
  flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs();
};
$("properties").onchange = event => {
  const endInput = event.target.closest("input[data-closed-end]");
  if (endInput) {
    const closedEnds = projectInputs.closedEnds ??= {};
    if (endInput.checked) closedEnds[endInput.dataset.closedEnd] = true; else delete closedEnds[endInput.dataset.closedEnd];
    flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null;
    saveProjectInputs(); renderConnectionReview(); renderDemandInputs();
    return;
  }
  const input = event.target.closest("input[data-pipe]"); if (!input) return;
  if (input.validity.badInput) { input.reportValidity(); return; }
  const id = input.dataset.expressId, field = input.dataset.pipe;
  const data = projectInputs.pipeHydraulics[id] = { ...(projectInputs.pipeHydraulics[id] ?? {}), [field]: input.value };
  if ((field === "diameterMm" || field === "lengthM") && input.value === "") {
    delete data[field];
    const item = batches.flatMap(batch => batch.records).find(record => record.expressId === Number(id));
    if (item) input.value = pipeHydraulicInput(item)[field];
  }
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
const pumpDialog = $("pumpDialog"), openPumpDialog = () => { $("pumpClass").value = $("system").value; renderPumpDialog(); pumpDialog.showModal(); };
$("btnSelectPump").onclick = openPumpDialog;
document.querySelectorAll("[data-open-pump]").forEach(button => button.onclick = openPumpDialog);
$("btnClosePump").onclick = () => pumpDialog.close();
$("pumpClass").onchange = $("pumpGroup").onchange = $("pumpFamily").onchange = () => renderPumpDialog();
$("pumpModel").onchange = () => { selectedPumpId = $("pumpModel").value; pumpResult = null; renderDemandInputs(); };
$("pumpOnlyCandidates").onchange = renderPumpDialog;
$("pumpList").onclick = event => { const row = event.target.closest("[data-pump-id]"); if (!row) return; selectedPumpId = row.dataset.pumpId; pumpResult = null; renderDemandInputs(); };
$("btnNextOpenEnd").onclick = () => {
  const open = openEndsOfActiveNetwork();
  if (!open.length) { status("Nenhuma ponta aberta na rede ativa."); return; }
  openEndCursor = (openEndCursor + 1) % open.length;
  const { expressId, end } = open[openEndCursor];
  focusElement(expressId);
  status("Ponta aberta " + (openEndCursor + 1) + " de " + open.length + ": tubo Express ID " + expressId + ", extremidade " + (end + 1) + ".");
};
$("btnConfirmConnectionBatch").onclick = () => {
  const pending = connectionBatchPending();
  if (!pending.length) return;
  for (const candidate of pending) reviewDecisions[candidate.key] = "Confirmada";
  flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null;
  saveReviewDecisions(); renderConnectionReview(); renderDemandInputs();
  log(pending.length.toLocaleString("pt-BR") + " ligação(ões) confirmada(s) em lote na rede " + ($("system").selectedOptions[0]?.text ?? $("system").value) + ".");
};
$("pipeBatchMaterial").onchange = $("pipeBatchDiameter").onchange = () => { $("pipeBatchMessage").textContent = ""; renderPipeBatch(); };
$("pipeBatchForm").onsubmit = event => {
  event.preventDefault();
  const total = pipeBatchIds.length;
  const result = fillPipeBatch(pipeBatchIds, projectInputs.pipeHydraulics, { roughnessMm: $("pipeBatchRoughness").value, k: $("pipeBatchK").value, source: $("pipeBatchSource").value });
  if (result.error) { $("pipeBatchMessage").textContent = result.error; return; }
  for (const [id, input] of result.updates) projectInputs.pipeHydraulics[id] = input;
  hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs();
  if (selected != null) showProperties(batches.flatMap(batch => batch.records).find(item => item.expressId === selected));
  const kept = total - result.updates.size;
  $("pipeBatchMessage").textContent = result.updates.size.toLocaleString("pt-BR") + " tubo(s) preenchido(s)" + (kept ? "; " + kept.toLocaleString("pt-BR") + " preservado(s) por já terem os valores ou outra fonte." : ".");
  if (result.updates.size) log("Dados de tubo preenchidos em lote: " + result.updates.size.toLocaleString("pt-BR") + " tubo(s).");
};
$("flowResult").onclick = event => { const button = event.target.closest("button[data-focus-id]"); if (button) focusElement(Number(button.dataset.focusId)); };
$("btnExportReport").onclick = exportCalculationReport;
$("btnMemorial").onclick = generateMemorial;
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
$("system").onchange = () => { flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; $("pumpClass").value = $("system").value; updateBoundaryFields(); saveProjectInputs(); if (selected != null) showProperties(batches.flatMap(batch => batch.records).find(item => item.expressId === selected)); renderDemandInputs(); };
$("waterTemperature").onchange = () => { hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs(); };
$("hotDeltaT").onchange = () => { hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs(); };
$("utilityPressure").onchange = $("utilityFlowLps").onchange = $("utilityPressureMax").onchange = () => {
  hydraulicResults = null;
  pumpResult = null;
  saveProjectInputs();
  renderDemandInputs();
  if (selected != null) showProperties(batches.flatMap(batch => batch.records).find(item => item.expressId === selected));
};
$("dailyVolumeL").onchange = $("refillHours").onchange = $("tankBuildingType").onchange = () => { flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; saveProjectInputs(); renderDemandInputs(); };
$("destination").onchange = () => { flowResults = new Map(); flowCalculation = null; hydraulicResults = null; pumpResult = null; updateBoundaryFields(); saveProjectInputs(); renderDemandInputs(); };
document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => {
  document.querySelectorAll("[data-tab]").forEach(x => x.classList.toggle("active", x === button));
  document.querySelectorAll(".tab-content").forEach(x => x.hidden = x.id !== `tab-${button.dataset.tab}`);
});
function applyElementColors() {
  for (const batch of batches) batch.records.forEach((item, id) => batch.mesh.setColorAt(id, new THREE.Color(item.expressId === selected ? 0xf04f37 : displayColor(item))));
}
$("colorMode").onchange = applyElementColors;
$("btnTheme").onclick = () => document.body.classList.toggle("dark");
$("btnOutput").onclick = () => { const panel = $("output"); panel.hidden = !panel.hidden; $("btnOutput").textContent = panel.hidden ? "Saída ▴" : "Saída ▾"; };
document.addEventListener("keydown", e => {
  if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey ||
      e.target.isContentEditable || e.target.closest?.("input, textarea, select, dialog[open]")) return;
  if (e.key === "Escape") setSelection(null);
  if (e.key.toLowerCase() === "f") fit();
});
function setLoading(on, text = "Lendo modelo IFC…", progress = 0) { $("loading").hidden = !on; $("emptyState").hidden = on || batches.length > 0; $("loadText").textContent = text; $("loadProgress").value = progress; }
$("btnCancelImport").onclick = () => {
  if (!worker) return;
  loadingToken++;
  worker.terminate();
  worker = null;
  discardPending();
  setLoading(false);
  host?.postMessage({ type: "modelRejected" });
  status(modelName ? "Importação cancelada; modelo anterior preservado." : "Importação cancelada.");
};
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
      setLoading(false); commitPending(); importedCandidates = data.candidates; terminals = data.terminals ?? []; reviewPage = 0; demandPage = 0; renderSummary(data); renderConnectionReview(); renderDemandInputs(); fit(); status(`Importação concluída: ${data.elements.toLocaleString("pt-BR")} elementos com geometria.`);
      $("emptyState").hidden = true; log(`Importação concluída: ${data.elements} elementos IFC com geometria.`); worker.terminate(); worker = null;
    }
    else if (data.type === "error") {
      setLoading(false); discardPending(); host?.postMessage({ type: "modelRejected" }); status("Falha na importação; modelo anterior preservado.");
      log(`Falha ao abrir ${pendingName}: ${data.text}`); if (!modelName) { $("fileName").textContent = "nenhum IFC selecionado"; $("projectSummary").className = "summary empty"; $("projectSummary").textContent = data.text; }
      worker.terminate(); worker = null;
    }
  };
  worker.onerror = e => {
    if (token !== loadingToken) return;
    setLoading(false); discardPending(); host?.postMessage({ type: "modelRejected" }); status("Falha no leitor IFC; modelo anterior preservado."); log(e.message || "Erro no leitor IFC."); worker?.terminate(); worker = null;
  };
  worker.postMessage({ type: "load" });
}
host?.addEventListener("message", ({ data }) => {
  if (data?.type === "ifcSelected") startImport(data);
  else if (data?.type === "error" || data?.type === "memorialSaved") { status(data.text); log(data.text); }
});
