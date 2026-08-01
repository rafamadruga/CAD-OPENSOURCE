# Como funciona um sistema CAD de modelagem 3D

> Documento de pesquisa — base de conhecimento para a construção de um CAD open-source.

## 1. Visão geral: a arquitetura em camadas

Todo CAD paramétrico moderno (FreeCAD, SolidWorks, Fusion 360, Onshape) segue essencialmente a mesma arquitetura em 4 camadas:

```
┌─────────────────────────────────────────────┐
│  4. INTERFACE (GUI)                         │  Qt, wxWidgets, navegador (WebGL)
│     viewport 3D, árvore de features,        │
│     sketcher, menus                         │
├─────────────────────────────────────────────┤
│  3. MODELO PARAMÉTRICO (documento)          │  árvore de features, DAG de
│     histórico de operações, expressões,     │  dependências, undo/redo
│     restrições                              │
├─────────────────────────────────────────────┤
│  2. KERNEL GEOMÉTRICO ("o coração")         │  OpenCASCADE, Parasolid, ACIS,
│     B-rep, NURBS, booleanas, fillets,       │  truck (Rust)
│     tesselação                              │
├─────────────────────────────────────────────┤
│  1. RENDERIZAÇÃO                            │  OpenGL / Vulkan / WebGL /
│     malha de triângulos na tela             │  Three.js
└─────────────────────────────────────────────┘
```

A regra de ouro: **o CAD em si é "apenas" uma interface sobre o kernel geométrico**. O kernel é onde estão 80% da complexidade e das décadas de matemática aplicada. Por isso quase ninguém escreve um kernel do zero — usa-se um pronto.

## 2. O kernel geométrico: B-rep + NURBS

### 2.1 B-rep (Boundary Representation)

Um sólido 3D **não** é armazenado como voxels nem como malha de triângulos. Ele é representado pela sua **fronteira** (boundary): a casca de superfícies que separa o "dentro" do "fora". O B-rep tem duas metades que andam juntas:

**Topologia** (como as coisas se conectam):

| Entidade | O que é |
|----------|---------|
| `Vertex` | ponto |
| `Edge`   | aresta (curva delimitada por 2 vértices) |
| `Wire`   | sequência fechada de arestas (contorno) |
| `Face`   | pedaço de superfície delimitado por wires |
| `Shell`  | conjunto conectado de faces |
| `Solid`  | shell fechado que define um volume |

**Geometria** (a forma exata de cada coisa): cada `Edge` aponta para uma curva matemática (reta, arco, spline) e cada `Face` aponta para uma superfície (plano, cilindro, **NURBS**).

### 2.2 NURBS

*Non-Uniform Rational B-Splines* — a representação matemática universal de curvas e superfícies em CAD. Uma NURBS é definida por pontos de controle, pesos e um vetor de nós (knot vector). Vantagens: representa **exatamente** círculos, cônicas, cilindros e superfícies livres com a mesma equação; é avaliável em qualquer ponto com precisão numérica dupla. É por isso que um furo no CAD é um círculo perfeito, e não um polígono de 64 lados como em softwares de malha (Blender).

### 2.3 O que o kernel sabe fazer

- **Primitivas**: caixa, cilindro, esfera, cone, toro.
- **Operações de varredura**: extrusão (pad), revolução, loft, sweep.
- **Booleanas**: união, subtração (corte/furo), interseção — o algoritmo mais difícil de um kernel, envolve interseção superfície-superfície e reconstrução de topologia.
- **Modificadores locais**: fillet (arredondamento), chamfer (chanfro), shell (casca), offset, draft.
- **Consultas**: volume, área, centro de massa, colisão, distância mínima.
- **Tesselação**: converter o B-rep exato em malha de triângulos para desenhar na tela (e exportar STL).
- **Healing/validação**: consertar geometria degenerada, tolerâncias.

## 3. Modelagem paramétrica: a árvore de features

O usuário não edita o B-rep diretamente. Ele constrói uma **receita** (histórico):

```
Corpo
 ├─ Sketch01 (retângulo 100×50, no plano XY)
 ├─ Pad01    (extrusão do Sketch01, altura = 20)
 ├─ Sketch02 (círculo Ø10 na face de cima)
 ├─ Pocket01 (furo passante do Sketch02)
 └─ Fillet01 (raio 3 nas arestas verticais)
```

Internamente isso é um **grafo acíclico dirigido (DAG)** de dependências. Quando o usuário muda "altura = 20" para "altura = 35", o sistema:

1. Marca `Pad01` como sujo (*touched*);
2. Propaga a sujeira para tudo que depende dele (`Sketch02`, `Pocket01`, `Fillet01`);
3. **Reexecuta** cada feature suja em ordem topológica, chamando o kernel de novo;
4. Retessela e redesenha.

É o mesmo princípio de uma planilha: mudou uma célula, recalcula as dependentes. O FreeCAD implementa isso no módulo `App` (classes `Document`, `DocumentObject`, `Property`). Um problema clássico dessa abordagem é o **topological naming problem**: depois de reexecutar, "a face de cima" pode ter mudado de identidade interna, quebrando referências — resolver isso bem é um dos grandes desafios de design.

## 4. O sketcher e o solver de restrições geométricas

A modelagem começa quase sempre num **sketch 2D**: o usuário desenha linhas/arcos "de qualquer jeito" e depois impõe **restrições**: horizontal, vertical, coincidente, tangente, paralelo, distância = 50 mm, raio = 10 mm.

O **geometric constraint solver** transforma isso num sistema de equações não lineares:

- Cada ponto/linha/arco vira variáveis (x, y, raio, ângulo…);
- Cada restrição vira uma ou mais equações;
- O solver resolve numericamente (Newton-Raphson, mínimos quadrados / Levenberg-Marquardt), geralmente após decompor o grafo de restrições em subproblemas menores;
- Ele também informa **graus de liberdade** restantes (sketch totalmente restrito = 0 DOF) e detecta restrições redundantes ou conflitantes.

Solvers open-source prontos: o **solver do SolveSpace** (extraído como biblioteca, usado pelo FreeCAD como opção) e o **planegcs** (o solver nativo do FreeCAD, em C++).

## 5. Renderização

O B-rep exato nunca vai direto para a GPU. O pipeline é:

1. Kernel **tessela** cada face NURBS em triângulos com uma tolerância (deflection);
2. A malha vai para a GPU via OpenGL/Vulkan (desktop) ou WebGL/WebGPU (navegador);
3. Arestas são desenhadas por cima como linhas (a aparência "técnica" do CAD);
4. **Picking**: clicar numa face/aresta na tela e mapear de volta para a entidade topológica do B-rep — essencial para a UX.

O FreeCAD usa **Coin3D** (scene graph estilo Open Inventor) sobre OpenGL, dentro de uma GUI **Qt**. CADs de navegador usam **Three.js** ou WebGL puro.

## 6. Formatos de arquivo

| Formato | Tipo | Uso |
|---------|------|-----|
| **STEP** (ISO 10303, AP203/AP214/AP242) | B-rep exato | O padrão universal de intercâmbio entre CADs. Preserva sólidos, montagens e (AP242) GD&T |
| **IGES** | B-rep/superfícies | Padrão antigo, ainda comum |
| **STL** | malha de triângulos | Impressão 3D — perde toda a informação exata |
| **3MF / OBJ / glTF** | malha | Impressão 3D moderna / visualização |
| **DXF/DWG** | 2D | desenhos técnicos |
| **FCStd** (FreeCAD) | nativo | zip com o documento paramétrico + B-rep serializado |

O OpenCASCADE já traz importador/exportador de STEP e IGES prontos — mais um motivo para usá-lo.

## 7. Linguagens de programação — quem usa o quê

**Não existe "a linguagem do CAD"; existe o padrão da indústria:**

- **C++** — a linguagem de praticamente todos os kernels e CADs sérios. OpenCASCADE (~milhões de linhas), Parasolid, ACIS, o núcleo do FreeCAD, SolveSpace, BRL-CAD. Motivo: desempenho numérico, controle de memória, 30+ anos de código legado.
- **Python** — a linguagem de *scripting e extensão*. O FreeCAD expõe quase tudo via bindings Python (a maioria dos workbenches é Python puro); **CadQuery** e **build123d** são CADs 100% em código Python sobre o OCCT (via pythonocc/OCP).
- **Rust** — a aposta moderna: **truck** (kernel B-rep/NURBS da Ricos Ltd., o mais maduro) e **Fornjot** (kernel B-rep; o projeto original foi encerrado sem atingir os objetivos — lição sobre a dificuldade de escrever kernel do zero). O app CADmium usava truck.
- **JavaScript/TypeScript** — CAD no navegador: **chili3d** (TS + OpenCASCADE compilado para **WebAssembly**), **replicad** (API JS sobre OCCT.wasm), **JSketcher**, **BREP.io**. O truque é sempre o mesmo: compilar o kernel C++ para WASM com Emscripten.

**Resumo do stack do FreeCAD** (a referência open-source): núcleo e kernel em **C++** (OCCT + Coin3D + Qt), scripting/workbenches em **Python**, arquitetura App (modelo, sem GUI) / Gui (visual) separadas — o que permite rodar FreeCAD headless em servidor.

## 8. Kernels disponíveis (build vs. buy)

| Kernel | Linguagem | Licença | Maturidade |
|--------|-----------|---------|------------|
| **OpenCASCADE (OCCT)** | C++ | LGPL | ★★★★★ — o único open-source completo (booleanas robustas, fillets, STEP/IGES). Usado por FreeCAD, CadQuery, KiCad, Gmsh |
| Parasolid | C++ | comercial (Siemens) | usado por SolidWorks, NX, Onshape |
| ACIS | C++ | comercial (Spatial) | usado por vários CADs comerciais |
| truck | Rust | Apache-2.0 | promissor, mas longe do OCCT |
| SolveSpace kernel | C++ | GPL | pequeno, elegante, limitado (sem fillet 3D robusto) |

**Conclusão prática: escrever um kernel B-rep do zero é um projeto de décadas** (booleanas robustas com aritmética de ponto flutuante são um problema de pesquisa). Todo projeto open-source bem-sucedido pegou o OCCT pronto e construiu em cima.

## 9. Roadmap: o que você precisa para criar um CAD

### Conhecimento necessário

1. **Matemática**: álgebra linear (transformações 4×4, quatérnions), geometria diferencial básica, splines/NURBS, métodos numéricos (Newton-Raphson, tolerâncias de ponto flutuante).
2. **Estruturas de dados**: B-rep/half-edge, grafos (DAG de dependências, grafo de restrições).
3. **Computação gráfica**: pipeline GPU, tesselação, picking.
4. **Engenharia de software**: arquitetura documento/visual, undo-redo (command pattern), serialização.

### Caminho recomendado (do mais rápido ao mais profundo)

**Opção A — CAD web (recomendada para começar):** TypeScript + OpenCASCADE.wasm (via replicad ou opencascade.js) + Three.js para renderizar + solver do SolveSpace compilado para WASM. É o stack do chili3d. Resultado visível em semanas.

**Opção B — CAD desktop clássico:** C++ (ou Python com pythonocc para prototipar) + OCCT + Qt. É recriar a fórmula do FreeCAD.

**Opção C — code-CAD (menor esforço de UI):** uma API em Python sobre OCCT no estilo CadQuery/build123d — sem sketcher interativo nem viewport próprio; o "desenho" é código.

### Ordem de implementação sugerida (MVP)

1. Viewport 3D com câmera orbit + primitivas do kernel (caixa, cilindro);
2. Booleanas (união/corte) e export STL;
3. Sketch 2D sem restrições → extrusão (o primeiro fluxo "de verdade");
4. Solver de restrições no sketch;
5. Árvore de features com reexecução paramétrica (DAG);
6. Fillet/chamfer, import/export STEP;
7. Undo/redo, salvar/abrir documento nativo.

### Código para estudar (na ordem)

1. **SolveSpace** — o CAD open-source mais legível; kernel + solver + GUI em ~50k linhas de C++;
2. **replicad / opencascade.js** — como usar OCCT em WASM;
3. **FreeCAD** (módulos `App`, `Part`, `Sketcher`) — arquitetura paramétrica completa;
4. **truck** — como se escreve um kernel B-rep moderno do zero, em Rust.

## 10. Fontes

- [Introduction to OpenCascade and CAD modelling kernels (Analysis Situs)](https://analysis-situs.medium.com/introduction-to-opencascade-and-cad-modelling-kernels-eb9e6b6817f4)
- [What is a geometric modeling kernel? (Engineering.com)](https://www.engineering.com/what-is-a-geometric-modeling-kernel/)
- [Geometric modeling kernels for CAD systems (a.kas, Medium)](https://medium.com/@a.kas/geometric-modeling-kernels-for-cad-systems-b97f689d2f46)
- [Geometric modeling kernel (Wikipedia)](https://en.wikipedia.org/wiki/Geometric_modeling_kernel)
- [Geometric constraint solving (Wikipedia)](https://en.wikipedia.org/wiki/Geometric_constraint_solving)
- [FreeCAD Module Developer Guide — arquitetura](https://github.com/qingfengxia/FreeCAD_Mod_Dev_Guide/blob/master/chapters/1.FreeCAD_overview_architecture.md)
- [FreeCAD no site do Open CASCADE](https://dev.opencascade.org/project/freecad)
- [Primer OpenCascade (GitHub)](https://github.com/RoberAgro/primer_open_cascade)
- [CadQuery: Programmable B-Rep Geometry](https://www.usedby.ai/blog/cadquery-programmable-b-rep-geometry-and-the-shift-to-code-cad)
- [awesome-cad — lista curada de projetos open-source](https://github.com/mlightcad/awesome-cad)
- [truck — kernel CAD em Rust (Ricos)](https://github.com/ricosjp/truck)
- [Fornjot — kernel B-rep em Rust](https://www.fornjot.app/)
- [Chili3d — CAD 3D no navegador (Hacker News)](https://brianlovin.com/hn/44238171)
