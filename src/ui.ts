/**
 * Interface: barra de ferramentas + árvore de features com parâmetros
 * editáveis. Qualquer mudança dispara a reavaliação do histórico.
 */
import {
  FEATURE_SPECS,
  createFeature,
  ensureIdsAbove,
  isEdgeFeature,
  type BooleanMode,
  type EdgeRef,
  type Feature,
  type FeatureType,
  type SketchData,
  type SketchEntity,
} from "./features";

/** O que fazer com o sketch concluído ("update" = edição de sketch existente). */
export type SketchAction = "pad" | "pocket" | "revolve" | "update";

const FILE_VERSION = 1;

interface UICallbacks {
  onModelChange: (features: Feature[]) => void;
  onExportSTL: () => void;
  onExportSTEP: () => void;
  /** arestas atualmente selecionadas no viewport (para fillet/chamfer seletivo) */
  getSelectedEdgeRefs: () => EdgeRef[];
  onStartSketch: (kind: "polygon" | "circle") => void;
  onFinishSketch: (action: SketchAction) => void;
  onCancelSketch: () => void;
  /** arma o modo arco para o próximo trecho; retorna se ficou armado */
  onToggleArc: () => boolean;
  onUndoPoint: () => void;
  onEditSketch: (featureId: number) => void;
  /** liga/desliga o modo de seleção de aresta; retorna o estado */
  onToggleSelect: () => boolean;
  onConstraint: (kind: "horizontal" | "vertical" | "length" | "fix") => void;
}

export class UI {
  private features: Feature[] = [];
  private treeEl: HTMLElement;
  private statusEl: HTMLElement;
  private selectionEl: HTMLElement;

  constructor(root: HTMLElement, private callbacks: UICallbacks) {
    root.innerHTML = `
      <header id="toolbar">
        <div id="toolbar-main" class="toolbar-row">
          <span class="brand">CAD Open Source</span>
          <button data-sketch="polygon" title="Desenhar um contorno no plano XY ou na face selecionada">✏ Sketch: Polígono</button>
          <button data-sketch="circle" title="Desenhar um círculo no plano XY ou na face selecionada">✏ Sketch: Círculo</button>
          <span class="divider"></span>
          <button data-add="box">+ Caixa</button>
          <button data-add="cylinder">+ Cilindro</button>
          <button data-cut="cylinder">− Furo cilíndrico</button>
          <button data-add="sphere">+ Esfera</button>
          <span class="divider"></span>
          <button data-add="fillet">Fillet</button>
          <button data-add="chamfer">Chamfer</button>
          <span class="divider"></span>
          <button id="undo" title="Desfazer (Ctrl+Z)">↶</button>
          <button id="redo" title="Refazer (Ctrl+Shift+Z)">↷</button>
          <button id="save-doc" title="Salvar documento (.cad.json)">Salvar</button>
          <button id="open-doc" title="Abrir documento salvo">Abrir</button>
          <input id="open-file" type="file" accept=".json,application/json" class="hidden" />
          <span class="spacer"></span>
          <button id="export-stl" title="Malha para impressão 3D">Exportar STL</button>
          <button id="export-step" title="B-rep exato, abre em qualquer CAD">Exportar STEP</button>
        </div>
        <div id="toolbar-sketch" class="toolbar-row hidden">
          <span class="brand sketch-brand">✏ Modo Sketch</span>
          <span id="sketch-hint"></span>
          <span class="spacer"></span>
          <button id="sketch-arc" title="O próximo trecho será um arco: clique o ponto de passagem e depois o fim">◠ Arco</button>
          <button id="sketch-undo-point" title="Remove o último ponto clicado">⌫ Ponto</button>
          <span class="divider"></span>
          <button id="sketch-select" title="Clique numa aresta do desenho para selecioná-la e aplicar restrições">✥ Selecionar</button>
          <button data-constraint="horizontal" title="A aresta selecionada fica horizontal">▬ Horiz.</button>
          <button data-constraint="vertical" title="A aresta selecionada fica vertical">▮ Vert.</button>
          <button data-constraint="length" title="Cota: comprimento exato da aresta selecionada">⟺ Cota</button>
          <button data-constraint="fix" title="Fixa os dois vértices da aresta selecionada">⚓ Fixar</button>
          <span class="divider"></span>
          <button id="sketch-pad" disabled>Extrudar</button>
          <button id="sketch-pocket" disabled>Cortar (pocket)</button>
          <button id="sketch-revolve" disabled title="Gira o perfil em torno do eixo vertical da vista de sketch">Revolucionar</button>
          <button id="sketch-done" class="hidden" disabled>Concluir edição</button>
          <button id="sketch-cancel">Cancelar</button>
        </div>
      </header>
      <div id="workspace">
        <aside id="panel">
          <h2>Histórico de features</h2>
          <div id="tree"></div>
          <p id="selection" class="hint">Clique numa aresta ou face do modelo para selecionar.</p>
          <p id="status"></p>
        </aside>
        <main id="viewport"></main>
      </div>
    `;

    this.treeEl = root.querySelector("#tree")!;
    this.statusEl = root.querySelector("#status")!;
    this.selectionEl = root.querySelector("#selection")!;

    root.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((btn) =>
      btn.addEventListener("click", () =>
        this.addFeature(btn.dataset.add as FeatureType, "add"),
      ),
    );
    root.querySelectorAll<HTMLButtonElement>("[data-cut]").forEach((btn) =>
      btn.addEventListener("click", () =>
        this.addFeature(btn.dataset.cut as FeatureType, "cut"),
      ),
    );
    root.querySelector("#export-stl")!.addEventListener("click", callbacks.onExportSTL);
    root.querySelector("#export-step")!.addEventListener("click", callbacks.onExportSTEP);

    root.querySelectorAll<HTMLButtonElement>("[data-sketch]").forEach((btn) =>
      btn.addEventListener("click", () =>
        callbacks.onStartSketch(btn.dataset.sketch as "polygon" | "circle"),
      ),
    );
    root.querySelector("#sketch-pad")!.addEventListener("click", () =>
      callbacks.onFinishSketch("pad"),
    );
    root.querySelector("#sketch-pocket")!.addEventListener("click", () =>
      callbacks.onFinishSketch("pocket"),
    );
    root.querySelector("#sketch-revolve")!.addEventListener("click", () =>
      callbacks.onFinishSketch("revolve"),
    );
    root.querySelector("#sketch-done")!.addEventListener("click", () =>
      callbacks.onFinishSketch("update"),
    );
    root.querySelector("#sketch-cancel")!.addEventListener("click", callbacks.onCancelSketch);
    const arcBtn = root.querySelector<HTMLButtonElement>("#sketch-arc")!;
    arcBtn.addEventListener("click", () =>
      arcBtn.classList.toggle("active", callbacks.onToggleArc()),
    );
    root.querySelector("#sketch-undo-point")!.addEventListener("click", () => {
      callbacks.onUndoPoint();
      arcBtn.classList.remove("active");
    });
    const selectBtn = root.querySelector<HTMLButtonElement>("#sketch-select")!;
    selectBtn.addEventListener("click", () =>
      selectBtn.classList.toggle("active", callbacks.onToggleSelect()),
    );
    root.querySelectorAll<HTMLButtonElement>("[data-constraint]").forEach((btn) =>
      btn.addEventListener("click", () =>
        callbacks.onConstraint(btn.dataset.constraint as "horizontal" | "vertical" | "length" | "fix"),
      ),
    );

    root.querySelector("#undo")!.addEventListener("click", () => this.undo());
    root.querySelector("#redo")!.addEventListener("click", () => this.redo());
    window.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.target instanceof HTMLInputElement) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        this.redo();
      }
    });

    root.querySelector("#save-doc")!.addEventListener("click", () => this.saveDocument());
    const fileInput = root.querySelector<HTMLInputElement>("#open-file")!;
    root.querySelector("#open-doc")!.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) await this.openDocument(file);
    });
  }

  // ── undo/redo: snapshots do histórico de features ──

  private past: Feature[][] = [];
  private future: Feature[][] = [];

  /** Chamado antes de cada mutação do modelo. */
  private snapshot(): void {
    this.past.push(structuredClone(this.features));
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(structuredClone(this.features));
    this.features = prev;
    this.renderTree();
    this.callbacks.onModelChange(this.features);
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(structuredClone(this.features));
    this.features = next;
    this.renderTree();
    this.callbacks.onModelChange(this.features);
  }

  // ── salvar/abrir: o documento nativo é o histórico serializado ──

  private saveDocument(): void {
    const doc = { app: "cad-opensource", version: FILE_VERSION, features: this.features };
    downloadBlob(
      new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
      "modelo.cad.json",
    );
  }

  private async openDocument(file: File): Promise<void> {
    try {
      const doc = JSON.parse(await file.text());
      if (doc?.app !== "cad-opensource" || !Array.isArray(doc.features)) {
        throw new Error("Formato de arquivo não reconhecido");
      }
      this.snapshot();
      this.features = doc.features as Feature[];
      ensureIdsAbove(this.features);
      this.renderTree();
      this.callbacks.onModelChange(this.features);
    } catch (e) {
      this.setStatus(`Falha ao abrir: ${e instanceof Error ? e.message : e}`, true);
    }
  }

  /** Alterna a barra para o modo sketch (ou de volta). */
  setSketchMode(active: boolean, hint = "", editing = false): void {
    document.querySelector("#toolbar-main")!.classList.toggle("hidden", active);
    document.querySelector("#toolbar-sketch")!.classList.toggle("hidden", !active);
    document.querySelector("#sketch-hint")!.textContent = hint;
    // editando um sketch existente: a operação já existe, só "Concluir"
    document.querySelector("#sketch-pad")!.classList.toggle("hidden", editing);
    document.querySelector("#sketch-pocket")!.classList.toggle("hidden", editing);
    document.querySelector("#sketch-revolve")!.classList.toggle("hidden", editing);
    document.querySelector("#sketch-done")!.classList.toggle("hidden", !editing);
    document.querySelector("#sketch-arc")!.classList.remove("active");
    document.querySelector("#sketch-select")!.classList.remove("active");
    if (active) this.setSketchReady(false);
  }

  setSketchHint(hint: string): void {
    document.querySelector("#sketch-hint")!.textContent = hint;
  }

  setSketchReady(ready: boolean): void {
    document.querySelector<HTMLButtonElement>("#sketch-pad")!.disabled = !ready;
    document.querySelector<HTMLButtonElement>("#sketch-pocket")!.disabled = !ready;
    document.querySelector<HTMLButtonElement>("#sketch-revolve")!.disabled = !ready;
    document.querySelector<HTMLButtonElement>("#sketch-done")!.disabled = !ready;
  }

  /** Substitui a geometria de um sketch existente (edição). */
  updateSketchEntity(featureId: number, entity: SketchEntity): void {
    const feature = this.features.find((f) => f.id === featureId);
    if (!feature?.sketch) return;
    this.snapshot();
    feature.sketch = { ...feature.sketch, entity };
    this.renderTree();
    this.callbacks.onModelChange(this.features);
  }

  getFeature(id: number): Feature | undefined {
    return this.features.find((f) => f.id === id);
  }

  /** Adiciona o par Sketch + operação (pad/pocket/revolução) ao histórico. */
  addSketchAndOp(sketch: SketchData, action: SketchAction): void {
    this.snapshot();
    const sketchFeature = createFeature("sketch", "add", { sketch });
    const op =
      action === "revolve"
        ? createFeature("revolve", "add", { sketchId: sketchFeature.id })
        : createFeature("pad", action === "pocket" ? "cut" : "add", {
            sketchId: sketchFeature.id,
          });
    this.features.push(sketchFeature, op);
    this.renderTree();
    this.callbacks.onModelChange(this.features);
  }

  get viewportEl(): HTMLElement {
    return document.querySelector("#viewport")!;
  }

  setStatus(text: string, isError = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", isError);
  }

  setSelection(sel: { faceId: number | null; edgeIds: number[] }): void {
    if (sel.edgeIds.length > 0) {
      const n = sel.edgeIds.length;
      this.selectionEl.textContent = `${n} aresta${n > 1 ? "s" : ""} selecionada${n > 1 ? "s" : ""} — Fillet/Chamfer será aplicado só nela${n > 1 ? "s" : ""}.`;
    } else if (sel.faceId !== null) {
      this.selectionEl.textContent = "1 face selecionada.";
    } else {
      this.selectionEl.textContent = "Clique numa aresta ou face do modelo para selecionar.";
    }
  }

  /** Marca erros por feature após uma avaliação. */
  showErrors(errors: Map<number, string>): void {
    for (const f of this.features) f.error = errors.get(f.id);
    this.renderTree();
  }

  private addFeature(type: FeatureType, mode: BooleanMode): void {
    this.snapshot();
    const edgeRefs = isEdgeFeature(type) ? this.callbacks.getSelectedEdgeRefs() : undefined;
    this.features.push(createFeature(type, mode, { edgeRefs }));
    this.renderTree();
    this.callbacks.onModelChange(this.features);
  }

  private removeFeature(id: number): void {
    this.snapshot();
    // remover um sketch remove também os pads que dependem dele
    this.features = this.features.filter((f) => f.id !== id && f.sketchId !== id);
    this.renderTree();
    this.callbacks.onModelChange(this.features);
  }

  /** Linha de parâmetro numérico editável, com snapshot e rebuild. */
  private paramRow(
    label: string,
    value: number,
    min: number | undefined,
    apply: (value: number) => void,
  ): HTMLElement {
    const row = document.createElement("label");
    row.className = "param";
    row.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "1";
    if (min !== undefined) input.min = String(min);
    input.value = String(value);
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) {
        this.snapshot();
        const clamped = min !== undefined ? Math.max(min, v) : v;
        apply(clamped);
        input.value = String(clamped);
        this.callbacks.onModelChange(this.features);
      }
    });
    row.appendChild(input);
    return row;
  }

  private renderTree(): void {
    this.treeEl.innerHTML = "";
    if (this.features.length === 0) {
      this.treeEl.innerHTML =
        '<p class="hint">Adicione uma primitiva na barra acima para começar.</p>';
      return;
    }

    for (const f of this.features) {
      const item = document.createElement("details");
      item.className = "feature" + (f.error ? " has-error" : "");
      item.open = f === this.features[this.features.length - 1];

      const summary = document.createElement("summary");
      summary.innerHTML = `<span>${f.name}</span>`;
      const actions = document.createElement("span");
      actions.className = "feature-actions";
      if (f.type === "sketch") {
        const edit = document.createElement("button");
        edit.textContent = "✎";
        edit.title = "Editar o desenho do sketch";
        edit.className = "delete";
        edit.addEventListener("click", (e) => {
          e.preventDefault();
          this.callbacks.onEditSketch(f.id);
        });
        actions.appendChild(edit);
      }
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Remover feature";
      del.className = "delete";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        this.removeFeature(f.id);
      });
      actions.appendChild(del);
      summary.appendChild(actions);
      item.appendChild(summary);

      if (f.error) {
        const err = document.createElement("p");
        err.className = "feature-error";
        err.textContent = `⚠ ${f.error}`;
        item.appendChild(err);
      }

      for (const spec of FEATURE_SPECS[f.type]) {
        item.appendChild(
          this.paramRow(spec.label, f.params[spec.key], spec.min, (value) => {
            f.params[spec.key] = value;
          }),
        );
      }

      // círculo de sketch: centro e raio editáveis numericamente
      if (f.type === "sketch" && f.sketch?.entity.kind === "circle") {
        const circle = f.sketch.entity;
        item.appendChild(
          this.paramRow("Centro X", circle.center[0], undefined, (v) => (circle.center[0] = v)),
        );
        item.appendChild(
          this.paramRow("Centro Y", circle.center[1], undefined, (v) => (circle.center[1] = v)),
        );
        item.appendChild(
          this.paramRow("Raio", circle.radius, 0.1, (v) => (circle.radius = v)),
        );
      }

      this.treeEl.appendChild(item);
    }
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
