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
import type { SketchEntity, SketchPlaneData } from "./features";

export interface Selection {
  faceId: number | null;
  edgeIds: number[];
}

interface SketchSession {
  plane: SketchPlaneData;
  kind: SketchEntity["kind"];
  mathPlane: THREE.Plane;
  basis: { origin: THREE.Vector3; x: THREE.Vector3; y: THREE.Vector3 };
  points: [number, number][];
  preview: THREE.Group;
  saved: { position: THREE.Vector3; up: THREE.Vector3; target: THREE.Vector3 };
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
   * e a câmera se posiciona olhando o plano de frente.
   */
  startSketch(plane: SketchPlaneData, kind: SketchEntity["kind"]): void {
    this.cancelSketch();
    this.clearSelection();

    const origin = new THREE.Vector3(...plane.origin);
    const x = new THREE.Vector3(...plane.xDir).normalize();
    const normal = new THREE.Vector3(...plane.normal).normalize();
    const y = new THREE.Vector3().crossVectors(normal, x);

    const preview = new THREE.Group();
    this.scene.add(preview);

    this.sketch = {
      plane,
      kind,
      mathPlane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin),
      basis: { origin, x, y },
      points: [],
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
    this.onSketchProgress(0);
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
    if (s.kind === "polygon" && s.points.length >= 3) {
      entity = { kind: "polygon", points: s.points };
    } else if (s.kind === "circle" && s.points.length >= 2) {
      const [c, r] = s.points;
      const radius = Math.hypot(r[0] - c[0], r[1] - c[1]);
      if (radius > 0) entity = { kind: "circle", center: c, radius };
    }
    this.cancelSketch();
    return entity;
  }

  private addSketchPoint(event: PointerEvent): void {
    const s = this.sketch!;
    if (s.kind === "circle" && s.points.length >= 2) return;

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
    const u = Math.round(v.dot(s.basis.x));
    const w = Math.round(v.dot(s.basis.y));
    s.points.push([u, w]);
    this.updateSketchPreview();
    this.onSketchProgress(s.points.length);
  }

  private sketchPointTo3D(p: [number, number]): THREE.Vector3 {
    const { origin, x, y } = this.sketch!.basis;
    return origin.clone().addScaledVector(x, p[0]).addScaledVector(y, p[1]);
  }

  private updateSketchPreview(): void {
    const s = this.sketch!;
    s.preview.clear();

    const pts3d = s.points.map((p) => this.sketchPointTo3D(p));
    s.preview.add(
      new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts3d), MAT_SKETCH_POINTS),
    );

    if (s.kind === "polygon" && pts3d.length >= 2) {
      const loop = pts3d.length >= 3 ? [...pts3d, pts3d[0]] : pts3d;
      s.preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop), MAT_SKETCH));
    } else if (s.kind === "circle" && s.points.length === 2) {
      const [c, r] = s.points;
      const radius = Math.hypot(r[0] - c[0], r[1] - c[1]);
      const circle: THREE.Vector3[] = [];
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        circle.push(
          this.sketchPointTo3D([c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)]),
        );
      }
      s.preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circle), MAT_SKETCH));
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
