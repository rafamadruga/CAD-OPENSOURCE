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

export interface Selection {
  faceId: number | null;
  edgeIds: number[];
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
      if (moved < 5) this.pick(e);
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
