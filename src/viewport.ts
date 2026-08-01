/**
 * Viewport 3D: renderiza a malha tesselada do corpo com Three.js.
 * Sombreado + arestas técnicas por cima, grade de referência e órbita.
 *
 * Picking: clique dispara um raio (raycasting) contra as arestas e a
 * malha; o índice do triângulo/segmento atingido é mapeado de volta à
 * entidade topológica do B-rep via faceGroups/edgeGroups da tesselação.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { TessellatedBody, TopoGroup } from "./kernel";
import { toProfile, type ProfileSegment, type SketchEntity, type SketchPlaneData } from "./features";
import { solveSketch, type SketchConstraint, type SolveResult } from "./solver";

export interface Selection {
  faceId: number | null;
  edgeIds: number[];
}

interface SketchSession {
  plane: SketchPlaneData;
  kind: "profile" | "circle";
  mathPlane: THREE.Plane;
  basis: { origin: THREE.Vector3; x: THREE.Vector3; y: THREE.Vector3 };
  /** perfil: segmentos (linhas/arcos); círculo: até 2 cliques em `clicks` */
  segments: ProfileSegment[];
  clicks: [number, number][];
  /** próximo trecho será um arco: 1º clique = ponto de passagem, 2º = fim */
  arcArmed: boolean;
  pendingVia: [number, number] | null;
  /** restrições geométricas do perfil (resolvidas pelo solver) */
  constraints: SketchConstraint[];
  /** modo seleção: cliques escolhem uma aresta em vez de criar pontos */
  selectMode: boolean;
  selectedEdge: number | null;
  preview: THREE.Group;
  saved: { position: THREE.Vector3; up: THREE.Vector3; target: THREE.Vector3 };
}

/** Distância de um ponto a um segmento 2D. */
function distToSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
}

/** Amostra um arco por três pontos (coordenadas 2D locais do plano). */
function sampleArc(
  a: [number, number],
  via: [number, number],
  b: [number, number],
): [number, number][] {
  const d =
    2 * (a[0] * (via[1] - b[1]) + via[0] * (b[1] - a[1]) + b[0] * (a[1] - via[1]));
  if (Math.abs(d) < 1e-9) return [a, b]; // colineares → linha

  const sq = (p: [number, number]) => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (via[1] - b[1]) + sq(via) * (b[1] - a[1]) + sq(b) * (a[1] - via[1])) / d;
  const cy = (sq(a) * (b[0] - via[0]) + sq(via) * (a[0] - b[0]) + sq(b) * (via[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy);

  const angle = (p: [number, number]) => Math.atan2(p[1] - cy, p[0] - cx);
  const ccwFrom = (from: number, to: number) =>
    (((to - from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = angle(a);
  const sweepCCW = ccwFrom(a0, angle(b));
  // o arco deve passar pelo ponto de via — escolhe o sentido certo
  const sweep = ccwFrom(a0, angle(via)) <= sweepCCW ? sweepCCW : sweepCCW - 2 * Math.PI;

  const steps = 24;
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + (sweep * i) / steps;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

const MAT_BODY = new THREE.MeshStandardMaterial({
  color: 0x5b8dbf,
  metalness: 0.1,
  roughness: 0.6,
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});
const MAT_BODY_SELECTED = MAT_BODY.clone();
MAT_BODY_SELECTED.color.set(0xe8a33d);
const MAT_EDGE = new THREE.LineBasicMaterial({ color: 0xdde3ec });
const MAT_EDGE_SELECTED = new THREE.LineBasicMaterial({ color: 0xff8c1a, depthTest: false });
const MAT_SKETCH = new THREE.LineBasicMaterial({ color: 0x4ade80, depthTest: false });
const MAT_SKETCH_POINTS = new THREE.PointsMaterial({
  color: 0x4ade80,
  size: 8,
  sizeAttenuation: false,
  depthTest: false,
});

export class Viewport {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private bodyGroup = new THREE.Group();
  private raycaster = new THREE.Raycaster();

  private mesh: THREE.Mesh | null = null;
  private edges: THREE.LineSegments | null = null;
  private faceGroups: TopoGroup[] = [];
  private edgeGroups: TopoGroup[] = [];

  private selectedFaceId: number | null = null;
  private selectedEdgeIds = new Set<number>();

  private sketch: SketchSession | null = null;
  /** avisa a UI quantos pontos o sketch em andamento tem */
  onSketchProgress: (pointCount: number) => void = () => {};

  constructor(
    container: HTMLElement,
    private onSelectionChange: (sel: Selection) => void = () => {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x1a1d23);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1); // convenção CAD: Z para cima
    this.camera.position.set(120, -120, 90);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const grid = new THREE.GridHelper(200, 20, 0x3a4150, 0x262b33);
    grid.rotation.x = Math.PI / 2; // GridHelper nasce no plano XZ; giramos para XY
    this.scene.add(grid);
    this.scene.add(new THREE.AxesHelper(30));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(100, -80, 150);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
    dir2.position.set(-80, 100, -60);
    this.scene.add(dir2);

    this.scene.add(this.bodyGroup);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };
    new ResizeObserver(resize).observe(container);
    resize();

    // clique ≠ arrasto de órbita: só seleciona se o ponteiro quase não se moveu
    let downAt: { x: number; y: number } | null = null;
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      downAt = { x: e.clientX, y: e.clientY };
    });
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved >= 5) return;
      if (this.sketch) this.addSketchPoint(e);
      else this.pick(e);
    });

    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Substitui o corpo exibido pela nova tesselação (ou limpa, se null). */
  setBody(tess: TessellatedBody | null): void {
    for (const child of [...this.bodyGroup.children]) {
      this.bodyGroup.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
      }
    }
    this.mesh = null;
    this.edges = null;
    this.faceGroups = [];
    this.edgeGroups = [];
    this.clearSelection();
    if (!tess) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(tess.vertices, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(tess.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(tess.indices, 1));
    for (const g of tess.faceGroups) geometry.addGroup(g.start, g.count, 0);

    this.mesh = new THREE.Mesh(geometry, [MAT_BODY, MAT_BODY_SELECTED]);
    this.faceGroups = tess.faceGroups;
    this.bodyGroup.add(this.mesh);

    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(tess.edgeLines, 3));
    for (const g of tess.edgeGroups) edgeGeometry.addGroup(g.start, g.count, 0);
    edgeGeometry.computeBoundingSphere();

    this.edges = new THREE.LineSegments(edgeGeometry, [MAT_EDGE, MAT_EDGE_SELECTED]);
    this.edges.renderOrder = 1;
    this.edgeGroups = tess.edgeGroups;
    this.bodyGroup.add(this.edges);
  }

  /**
   * Entra no modo sketch: cliques passam a criar pontos no plano dado,
   * e a câmera se posiciona olhando o plano de frente. `initial` carrega
   * uma entidade existente para edição.
   */
  startSketch(
    plane: SketchPlaneData,
    kind: SketchEntity["kind"],
    initial?: SketchEntity,
  ): void {
    this.cancelSketch();
    this.clearSelection();

    const origin = new THREE.Vector3(...plane.origin);
    const x = new THREE.Vector3(...plane.xDir).normalize();
    const normal = new THREE.Vector3(...plane.normal).normalize();
    const y = new THREE.Vector3().crossVectors(normal, x);

    const preview = new THREE.Group();
    this.scene.add(preview);

    let segments: ProfileSegment[] = [];
    let clicks: [number, number][] = [];
    let constraints: SketchConstraint[] = [];
    if (initial) {
      const entity = toProfile(initial);
      if (entity.kind === "profile") {
        segments = structuredClone(entity.segments);
        constraints = structuredClone(entity.constraints ?? []);
      } else if (entity.kind === "circle") {
        clicks = [
          entity.center,
          [entity.center[0] + entity.radius, entity.center[1]],
        ];
      }
    }

    this.sketch = {
      plane,
      kind: kind === "circle" ? "circle" : "profile",
      mathPlane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin),
      basis: { origin, x, y },
      segments,
      clicks,
      arcArmed: false,
      pendingVia: null,
      constraints,
      selectMode: false,
      selectedEdge: null,
      preview,
      saved: {
        position: this.camera.position.clone(),
        up: this.camera.up.clone(),
        target: this.controls.target.clone(),
      },
    };

    // olha o plano de frente, a uma distância proporcional ao modelo
    const dist = (this.edges?.geometry.boundingSphere?.radius ?? 60) * 3;
    this.camera.up.copy(y);
    this.camera.position.copy(origin).addScaledVector(normal, Math.max(dist, 120));
    this.controls.target.copy(origin);
    this.updateSketchPreview();
    this.emitSketchProgress();
  }

  /** Arma/desarma o modo arco para o próximo trecho do perfil. */
  toggleArcMode(): boolean {
    const s = this.sketch;
    if (!s || s.kind !== "profile" || s.segments.length === 0) return false;
    s.arcArmed = !s.arcArmed;
    if (!s.arcArmed) s.pendingVia = null;
    this.updateSketchPreview();
    return s.arcArmed;
  }

  /** Remove o último ponto clicado. */
  undoSketchPoint(): void {
    const s = this.sketch;
    if (!s) return;
    if (s.pendingVia) s.pendingVia = null;
    else if (s.kind === "profile") {
      s.segments.pop();
      // descarta restrições que referenciam arestas que deixaram de existir
      s.constraints = s.constraints.filter((c) => c.seg < s.segments.length);
      s.selectedEdge = null;
    } else s.clicks.pop();
    this.updateSketchPreview();
    this.emitSketchProgress();
  }

  /** Liga/desliga o modo de seleção de aresta no sketch. */
  toggleSketchSelect(): boolean {
    const s = this.sketch;
    if (!s || s.kind !== "profile") return false;
    s.selectMode = !s.selectMode;
    if (!s.selectMode) s.selectedEdge = null;
    this.updateSketchPreview();
    return s.selectMode;
  }

  /** Comprimento atual da aresta selecionada (para o valor padrão da cota). */
  selectedEdgeLength(): number | null {
    const s = this.sketch;
    if (!s || s.selectedEdge === null) return null;
    const n = s.segments.length;
    const a = s.segments[s.selectedEdge].to;
    const b = s.segments[(s.selectedEdge + 1) % n].to;
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  /**
   * Aplica uma restrição à aresta selecionada e roda o solver: os
   * vértices do desenho se movem para satisfazer todas as restrições.
   */
  applyConstraint(
    kind: "horizontal" | "vertical" | "length" | "fix",
    value?: number,
  ): SolveResult | null {
    const s = this.sketch;
    if (!s || s.kind !== "profile" || s.selectedEdge === null) return null;
    const i = s.selectedEdge;
    const n = s.segments.length;

    if (kind === "fix") {
      s.constraints.push(
        { kind: "fix", seg: i, at: [...s.segments[i].to] },
        { kind: "fix", seg: (i + 1) % n, at: [...s.segments[(i + 1) % n].to] },
      );
    } else if (kind === "length") {
      s.constraints.push({ kind: "length", seg: i, value: value ?? 10 });
    } else {
      s.constraints.push({ kind, seg: i });
    }

    const result = solveSketch(
      s.segments.map((seg) => seg.to),
      s.constraints,
    );
    if (result.converged) {
      result.points.forEach((p, idx) => (s.segments[idx].to = p));
    } else {
      s.constraints.pop(); // restrição conflitante: descarta
      if (kind === "fix") s.constraints.pop();
    }
    this.updateSketchPreview();
    return result;
  }

  private emitSketchProgress(): void {
    const s = this.sketch;
    if (!s) return;
    this.onSketchProgress(s.kind === "profile" ? s.segments.length : s.clicks.length);
  }

  cancelSketch(): void {
    if (!this.sketch) return;
    this.scene.remove(this.sketch.preview);
    this.camera.position.copy(this.sketch.saved.position);
    this.camera.up.copy(this.sketch.saved.up);
    this.controls.target.copy(this.sketch.saved.target);
    this.sketch = null;
  }

  /** Conclui o sketch e devolve a entidade desenhada (ou null se incompleta). */
  finishSketch(): SketchEntity | null {
    const s = this.sketch;
    if (!s) return null;

    let entity: SketchEntity | null = null;
    if (s.kind === "profile" && s.segments.length >= 3) {
      entity = { kind: "profile", segments: s.segments, constraints: s.constraints };
    } else if (s.kind === "circle" && s.clicks.length >= 2) {
      const [c, r] = s.clicks;
      const radius = Math.hypot(r[0] - c[0], r[1] - c[1]);
      if (radius > 0) entity = { kind: "circle", center: c, radius };
    }
    this.cancelSketch();
    return entity;
  }

  private addSketchPoint(event: PointerEvent): void {
    const s = this.sketch!;
    if (s.kind === "circle" && s.clicks.length >= 2) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(s.mathPlane, hit)) return;

    // coordenadas locais do plano, com snap de 1 mm
    const v = hit.clone().sub(s.basis.origin);
    const p: [number, number] = [Math.round(v.dot(s.basis.x)), Math.round(v.dot(s.basis.y))];

    // modo seleção: escolhe a aresta reta mais próxima do clique
    if (s.selectMode && s.kind === "profile") {
      const exact: [number, number] = [v.dot(s.basis.x), v.dot(s.basis.y)];
      const n = s.segments.length;
      if (n < 2) return;
      let best: { edge: number; dist: number } | null = null;
      const edgeCount = n >= 3 ? n : n - 1; // contorno fechado a partir de 3 vértices
      for (let i = 0; i < edgeCount; i++) {
        if (s.segments[(i + 1) % n].via) continue; // arcos não recebem restrição
        const d = distToSegment(exact, s.segments[i].to, s.segments[(i + 1) % n].to);
        if (!best || d < best.dist) best = { edge: i, dist: d };
      }
      const threshold = Math.max(3, this.controls.getDistance() * 0.02);
      s.selectedEdge = best && best.dist < threshold ? best.edge : null;
      this.updateSketchPreview();
      this.emitSketchProgress();
      return;
    }

    if (s.kind === "circle") {
      s.clicks.push(p);
    } else if (s.arcArmed && !s.pendingVia) {
      s.pendingVia = p; // 1º clique do arco: ponto de passagem
    } else if (s.arcArmed && s.pendingVia) {
      s.segments.push({ to: p, via: s.pendingVia }); // 2º clique: fim do arco
      s.pendingVia = null;
      s.arcArmed = false;
    } else {
      s.segments.push({ to: p });
    }
    this.updateSketchPreview();
    this.emitSketchProgress();
  }

  private sketchPointTo3D(p: [number, number]): THREE.Vector3 {
    const { origin, x, y } = this.sketch!.basis;
    return origin.clone().addScaledVector(x, p[0]).addScaledVector(y, p[1]);
  }

  private updateSketchPreview(): void {
    const s = this.sketch!;
    s.preview.clear();

    if (s.kind === "circle") {
      const pts3d = s.clicks.map((p) => this.sketchPointTo3D(p));
      s.preview.add(
        new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts3d), MAT_SKETCH_POINTS),
      );
      if (s.clicks.length === 2) {
        const [c, r] = s.clicks;
        const radius = Math.hypot(r[0] - c[0], r[1] - c[1]);
        const circle: THREE.Vector3[] = [];
        for (let i = 0; i <= 64; i++) {
          const a = (i / 64) * Math.PI * 2;
          circle.push(
            this.sketchPointTo3D([c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)]),
          );
        }
        s.preview.add(
          new THREE.Line(new THREE.BufferGeometry().setFromPoints(circle), MAT_SKETCH),
        );
      }
      return;
    }

    // perfil: marcadores nos vértices (e no via pendente do arco)
    const markers = s.segments.map((seg) => this.sketchPointTo3D(seg.to));
    if (s.pendingVia) markers.push(this.sketchPointTo3D(s.pendingVia));
    s.preview.add(
      new THREE.Points(new THREE.BufferGeometry().setFromPoints(markers), MAT_SKETCH_POINTS),
    );

    if (s.segments.length >= 2) {
      // caminho 2D amostrado (arcos viram sequências de pontos)
      const path: [number, number][] = [s.segments[0].to];
      for (let i = 1; i < s.segments.length; i++) {
        const from = s.segments[i - 1].to;
        const seg = s.segments[i];
        if (seg.via) path.push(...sampleArc(from, seg.via, seg.to).slice(1));
        else path.push(seg.to);
      }
      if (s.segments.length >= 3) path.push(s.segments[0].to); // fecha o contorno
      const pts3d = path.map((p) => this.sketchPointTo3D(p));
      s.preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts3d), MAT_SKETCH));
    }

    // aresta selecionada em destaque
    if (s.selectedEdge !== null) {
      const n = s.segments.length;
      const a = this.sketchPointTo3D(s.segments[s.selectedEdge].to);
      const b = this.sketchPointTo3D(s.segments[(s.selectedEdge + 1) % n].to);
      s.preview.add(
        new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), MAT_EDGE_SELECTED),
      );
    }
  }

  /** Projeta um ponto 3D do modelo para pixels da página (usado nos testes E2E). */
  projectToScreen(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    };
  }

  clearSelection(): void {
    if (this.selectedFaceId === null && this.selectedEdgeIds.size === 0) return;
    this.selectedFaceId = null;
    this.selectedEdgeIds.clear();
    this.applyHighlights();
    this.emitSelection();
  }

  private pick(event: PointerEvent): void {
    if (!this.mesh || !this.edges) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);

    // tolerância de clique em aresta proporcional ao tamanho do modelo
    const radius = this.edges.geometry.boundingSphere?.radius ?? 100;
    this.raycaster.params.Line.threshold = radius * 0.015;

    const edgeHit = this.raycaster.intersectObject(this.edges)[0];
    const faceHit = this.raycaster.intersectObject(this.mesh)[0];

    // aresta ganha da face quando o clique está perto o suficiente dela
    if (
      edgeHit &&
      edgeHit.index !== undefined &&
      (!faceHit || edgeHit.distance <= faceHit.distance + this.raycaster.params.Line.threshold)
    ) {
      const group = this.edgeGroups.find(
        (g) => edgeHit.index! >= g.start && edgeHit.index! < g.start + g.count,
      );
      if (group) {
        if (this.selectedEdgeIds.has(group.id)) this.selectedEdgeIds.delete(group.id);
        else this.selectedEdgeIds.add(group.id);
        this.selectedFaceId = null;
      }
    } else if (faceHit && faceHit.faceIndex != null) {
      const indexPos = faceHit.faceIndex * 3;
      const group = this.faceGroups.find(
        (g) => indexPos >= g.start && indexPos < g.start + g.count,
      );
      if (group) {
        this.selectedFaceId = this.selectedFaceId === group.id ? null : group.id;
        this.selectedEdgeIds.clear();
      }
    } else {
      this.selectedFaceId = null;
      this.selectedEdgeIds.clear();
    }

    this.applyHighlights();
    this.emitSelection();
  }

  /** Grupos de geometria escolhem o material: 0 = normal, 1 = selecionado. */
  private applyHighlights(): void {
    if (this.mesh) {
      this.mesh.geometry.groups.forEach((g, i) => {
        g.materialIndex = this.faceGroups[i]?.id === this.selectedFaceId ? 1 : 0;
      });
    }
    if (this.edges) {
      this.edges.geometry.groups.forEach((g, i) => {
        const id = this.edgeGroups[i]?.id;
        g.materialIndex = id !== undefined && this.selectedEdgeIds.has(id) ? 1 : 0;
      });
    }
  }

  private emitSelection(): void {
    this.onSelectionChange({
      faceId: this.selectedFaceId,
      edgeIds: [...this.selectedEdgeIds],
    });
  }
}
