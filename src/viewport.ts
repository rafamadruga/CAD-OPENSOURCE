/**
 * Viewport 3D: renderiza a malha tesselada do corpo com Three.js.
 * Sombreado + arestas técnicas por cima, grade de referência e órbita.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { TessellatedBody } from "./kernel";

export class Viewport {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private bodyGroup = new THREE.Group();

  constructor(container: HTMLElement) {
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
        (child.material as THREE.Material).dispose();
      }
    }
    if (!tess) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(tess.vertices, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(tess.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(tess.indices, 1));

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x5b8dbf,
        metalness: 0.1,
        roughness: 0.6,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    );
    this.bodyGroup.add(mesh);

    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(tess.edgeLines, 3));
    const edges = new THREE.LineSegments(
      edgeGeometry,
      new THREE.LineBasicMaterial({ color: 0xdde3ec }),
    );
    this.bodyGroup.add(edges);
  }
}
