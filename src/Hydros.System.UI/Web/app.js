import * as THREE from "three";
import CameraControls from "./lib/camera-controls.module.js";

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
let importedCandidates = [], reviewDecisions = {}, reviewPage = 0;
const reviewPageSize = 50;
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
  batches.length = 0; world.clear(); selected = null; showProperties(null);
}
function commitPending() {
  discardActive();
  world.add(pendingGroup); batches.push(...pendingBatches); pendingBatches.length = 0; pendingGroup = null;
  modelName = pendingName; activeFileKey = pendingFileKey; pendingFileKey = ""; loadReviewDecisions(activeFileKey); $("fileName").textContent = modelName; host?.postMessage({ type: "modelAccepted" });
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
  $("properties").innerHTML = "<h3>" + escapeHtml(item.name || item.type) + "</h3><dl><dt>Classe IFC</dt><dd>" + escapeHtml(item.type) + "</dd><dt>GlobalId</dt><dd>" + escapeHtml(item.id ?? "não informado") + "</dd><dt>Express ID</dt><dd>" + item.expressId + "</dd><dt>Pavimento IFC</dt><dd>" + escapeHtml(item.storey ?? "não associado") + "</dd><dt>Rede IFC</dt><dd>" + system + "</dd></dl>" + (properties.length ? "<details class=\"metadata-block\"><summary>Propriedades IFC (" + item.properties.length + ")</summary><div class=\"metadata-list\">" + propertyHtml + (item.properties.length > 80 ? "<div>Mostrando 80 de " + item.properties.length + " propriedades.</div>" : "") + "</div></details>" : "<div class=\"warning\">Sem property sets IFC associados.</div>");
}
function loadReviewDecisions(fileKey) {
  try { const saved = JSON.parse(localStorage.getItem("hydros:reviews:" + fileKey) || "{}"); reviewDecisions = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}; }
  catch { reviewDecisions = {}; }
}
function saveReviewDecisions() {
  try { localStorage.setItem("hydros:reviews:" + activeFileKey, JSON.stringify(reviewDecisions)); }
  catch { log("Não foi possível salvar as decisões locais de revisão."); }
}
function renderConnectionReview() {
  const counts = { Confirmada: 0, Rejeitada: 0, Pendente: 0 };
  importedCandidates.forEach(candidate => { const saved = reviewDecisions[candidate.key]; const decision = saved === "Confirmada" || saved === "Rejeitada" ? saved : "Pendente"; counts[decision]++; });
  const pages = Math.ceil(importedCandidates.length / reviewPageSize), start = reviewPage * reviewPageSize;
  $("connectionSummary").className = "summary";
  $("connectionSummary").innerHTML = "<dl><dt>Candidatos (até 50 mm)</dt><dd>" + importedCandidates.length.toLocaleString("pt-BR") + "</dd><dt>Confirmadas manualmente</dt><dd>" + counts.Confirmada + "</dd><dt>Rejeitadas</dt><dd>" + counts.Rejeitada + "</dd><dt>Pendentes</dt><dd>" + counts.Pendente + "</dd></dl><div class=\"warning\">Cada ligação é uma sugestão geométrica. Confirmar registra sua revisão humana; não habilita cálculos enquanto faltarem critérios e dados obrigatórios.</div>";
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
$("connectionList").onclick = event => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const candidate = importedCandidates[Number(button.dataset.index)]; if (!candidate) return;
  if (button.dataset.action === "focus") focusElement(candidate.from.expressId);
  else { reviewDecisions[candidate.key] = button.dataset.action; saveReviewDecisions(); renderConnectionReview(); }
};
$("system").onchange = () => { $("feedFields").hidden = $("system").value !== "feed"; };
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
      setLoading(false); commitPending(); importedCandidates = data.candidates; reviewPage = 0; renderSummary(data); renderConnectionReview(); fit(); status(`Importação concluída: ${data.elements.toLocaleString("pt-BR")} elementos.`);
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
