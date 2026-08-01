/**
 * Solver de restrições geométricas 2D.
 *
 * O sketcher de um CAD paramétrico transforma restrições ("este lado é
 * horizontal", "este comprimento = 50") num sistema de equações não
 * lineares r(x) = 0, onde x são as coordenadas dos vértices. Resolvemos
 * por Gauss-Newton com amortecimento de Levenberg-Marquardt e jacobiano
 * numérico — a mesma família de métodos do planegcs (FreeCAD) e do
 * solver do SolveSpace, em miniatura.
 *
 * As restrições referenciam arestas pelo índice: aresta i liga o
 * vértice i ao vértice (i+1) % n (o contorno é fechado).
 */

export type SketchConstraint =
  | { kind: "horizontal"; seg: number }
  | { kind: "vertical"; seg: number }
  | { kind: "length"; seg: number; value: number }
  | { kind: "fix"; seg: number; at: [number, number] };

export interface SolveResult {
  points: [number, number][];
  converged: boolean;
  maxError: number;
  /** graus de liberdade restantes (2·vértices − equações) */
  dof: number;
}

/** Monta o vetor de resíduos r(x) — uma linha por equação de restrição. */
function residuals(x: number[], n: number, constraints: SketchConstraint[]): number[] {
  const px = (i: number) => x[2 * (((i % n) + n) % n)];
  const py = (i: number) => x[2 * (((i % n) + n) % n) + 1];
  const r: number[] = [];
  for (const c of constraints) {
    const i = c.seg;
    switch (c.kind) {
      case "horizontal":
        r.push(py(i + 1) - py(i));
        break;
      case "vertical":
        r.push(px(i + 1) - px(i));
        break;
      case "length": {
        const dx = px(i + 1) - px(i);
        const dy = py(i + 1) - py(i);
        r.push(Math.hypot(dx, dy) - c.value);
        break;
      }
      case "fix":
        r.push(px(i) - c.at[0], py(i) - c.at[1]);
        break;
    }
  }
  return r;
}

/** Resolve o sistema linear A·dx = b por eliminação de Gauss com pivoteamento. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const k = M[row][col] / M[col][col];
      for (let c = col; c <= n; c++) M[row][c] -= k * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

const EPS = 1e-6;
const MAX_ITERATIONS = 60;
const TOL = 1e-9;
const DAMPING = 1e-8;

/**
 * Gauss-Newton amortecido: em cada iteração lineariza r(x) ≈ r + J·dx e
 * resolve as equações normais (JᵀJ + λI)·dx = −Jᵀr. O amortecimento λ
 * mantém o sistema solúvel quando há menos restrições que variáveis
 * (sketch subdeterminado — o caso normal), fazendo o solver escolher a
 * solução mais próxima do desenho atual.
 */
export function solveSketch(
  points: [number, number][],
  constraints: SketchConstraint[],
): SolveResult {
  const n = points.length;
  const eqCount = constraints.reduce((s, c) => s + (c.kind === "fix" ? 2 : 1), 0);
  const dof = Math.max(0, 2 * n - eqCount);
  if (constraints.length === 0) {
    return { points, converged: true, maxError: 0, dof };
  }

  let x = points.flat();
  let maxError = Infinity;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const r = residuals(x, n, constraints);
    maxError = Math.max(...r.map(Math.abs), 0);
    if (maxError < TOL) break;

    // jacobiano numérico por diferenças finitas
    const m = r.length;
    const J: number[][] = Array.from({ length: m }, () => new Array(x.length).fill(0));
    for (let v = 0; v < x.length; v++) {
      const saved = x[v];
      x[v] = saved + EPS;
      const rp = residuals(x, n, constraints);
      x[v] = saved;
      for (let e = 0; e < m; e++) J[e][v] = (rp[e] - r[e]) / EPS;
    }

    // equações normais amortecidas: (JᵀJ + λI)·dx = −Jᵀr
    const dim = x.length;
    const A: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
    const b: number[] = new Array(dim).fill(0);
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) {
        let s = 0;
        for (let e = 0; e < m; e++) s += J[e][i] * J[e][j];
        A[i][j] = s + (i === j ? DAMPING : 0);
      }
      let s = 0;
      for (let e = 0; e < m; e++) s += J[e][i] * r[e];
      b[i] = -s;
    }

    const dx = solveLinear(A, b);
    if (!dx) break;
    for (let v = 0; v < dim; v++) x[v] += dx[v];
  }

  const solved: [number, number][] = [];
  for (let i = 0; i < n; i++) solved.push([x[2 * i], x[2 * i + 1]]);
  const finalError = Math.max(...residuals(x, n, constraints).map(Math.abs), 0);
  return { points: solved, converged: finalError < 1e-6, maxError: finalError, dof };
}
