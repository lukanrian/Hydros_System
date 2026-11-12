# Hydros System

Aplicativo Windows em desenvolvimento para análise e pré-dimensionamento predial de água fria, água quente e alimentação a partir de IFC4. Inclui visualizador 3D e cálculos hidráulicos condicionados à revisão da rede e à entrada explícita de dados físicos.

## Executar

Requisitos: Windows, .NET 10 SDK e Microsoft Edge WebView2 Runtime.

```powershell
dotnet build Hydros.System.sln
dotnet run --project src/Hydros.System.UI/Hydros.System.UI.csproj
```

É possível abrir um IFC diretamente ao iniciar: `dotnet run --project src/Hydros.System.UI/Hydros.System.UI.csproj -- "C:\caminho\modelo.ifc"`. Também há o botão **Abrir IFC**.

A prévia mostra segmentos de tubulação, conexões, válvulas, bombas e medidores reconhecidos pelo IFC. Use **Projeto** para alternar água fria, água quente e alimentação. A concessionária recebe pressão dinâmica, vazão de referência e pressão estática máxima. Para reservatório, informe tipologia, volume diário e tempo de reposição, e marque no 3D a extremidade de chegada; a vazão vem de volume/tempo e o limite de reposição é 3 h para unifamiliar ou 6 h para demais edificações. Para água fria/quente, selecione a origem no 3D e informe pressões/cota. As entradas são salvas localmente por IFC.

A aba **Pontos** coleta vazão, pressão requerida e fonte por terminal. Marque os pontos simultâneos e clique em **Calcular vazões** para agregar as demandas no grafo radial confirmado. Para perdas e pressões, informe a temperatura e, por tubo, diâmetro interno, comprimento, rugosidade absoluta, K localizado total e fonte. O cálculo usa o diâmetro interno e o comprimento reconhecidos no IFC quando o projetista ainda não editou esses campos. Darcy–Weisbach fornece as perdas de carga, e o programa usa as dimensões disponíveis para calcular as velocidades e pressões. A cota geométrica da origem aparece após o cálculo das vazões. A diferença entre essa cota e a cota informada é aplicada uniformemente às cotas dos nós.

Para recirculação de água quente, o IFC precisa classificar explicitamente as redes de distribuição e retorno e conectá-las em alças até o aquecedor selecionado. Informe ΔT e, em cada tubo que participa das alças, a perda térmica em W/m e sua fonte. O programa rateia perdas dos trechos comuns entre alças, calcula vazão por alça e indica a altura de circulação e a perda adicional para balanceamento. Sem retorno explícito no IFC, o cálculo permanece parcial. A válvula e a bomba circuladora ainda precisam de validação com dados do fabricante.

A aba **Bombas** reúne 24 opções organizadas por classe, fabricante e família. A WDM VPI1 EEP 1.5 15 é avaliada por interpolação dentro da faixa da curva tabelada. O Catálogo Técnico Rowa 2026 fornece especificações e gráficos de MAX PRESS, MAX PRESS Alta Vazão, MAXFLOW e circuladoras RW S50/S150 Controller TT, incluindo as diferentes velocidades. Os valores máximos de vazão e pressão da Rowa servem como referência. Os gráficos do catálogo não são distribuídos no repositório: para vê-los no seletor, coloque as imagens em `src/Hydros.System.UI/Web/assets/` (`rowa-max-press-2026.png`, `rowa-max-press-alta-vazao-2026.png`, `rowa-max-press-vf-2026.png`, `rowa-maxflow-2026.png`, `rowa-circulators-2026.png`); sem elas, o seletor mostra só os dados. A classe Água quente lista as circuladoras com limite de temperatura cadastrado, mas sem curva tabulada para avaliar o ponto calculado. A triagem requer confirmação de temperatura, tensão, sucção e instalação.

**Exportar relatório JSON** inclui as entradas e os resultados do cenário calculado, com fontes, avisos e limitações. **Gerar memorial** abre a janela para salvar um documento Word editável (.docx), com vazões em L/s e pressão estática por ponto em kPa.

A aba **Conexões** lista candidatos vindos de portas IFC (`IfcRelConnectsPorts`), de proximidade (50 mm) e de pontas de tubo dentro do volume de uma peça. Só ligações confirmadas entram no cálculo. **Confirmar ligações únicas da rede** confirma em lote as que não disputam extremidade; ligações a reservatórios e aquecedores ficam na revisão individual. **Ir para a próxima ponta aberta** leva a cada extremidade pendente, e no painel do tubo é possível declarar uma ponta sem vazão (tampada, espera ou fora do cenário); a declaração vai para o relatório e o memorial. O cálculo cobre a rede alimentada pela origem; tubos da mesma classe que a origem não alcança são contados e ficam de fora. Redes com ciclo (bombas em paralelo, bypass) continuam bloqueadas, e a mensagem aponta o tubo que fecha o ciclo. As pressões são em m.c.a. convencional (1 m.c.a. = 9,80665 kPa).

## Testes

Requer Node.js 22 ou mais recente:

```powershell
node --test tests/
```

Os testes cobrem o motor hidráulico, o solver de vazões e pressões, os candidatos de conexão e as ações em lote.

A aba também informa extremidades abertas e redes desconectadas. O leitor mostra associações de material e dimensões quando o IFC as fornece; não interpreta diâmetro nominal como diâmetro interno. Consulte [SPEC-hydraulic-engine.md](SPEC-hydraulic-engine.md) para as próximas entregas e requisitos de entrada.

O viewer deriva do padrão Three.js/WebGL e `camera-controls` do Dimensionador Tipo Grelha. As bibliotecas distribuídas e suas licenças estão em `src/Hydros.System.UI/Web/lib`. O app original, os IFCs, catálogos, normas e as pranchas de referência em `PROJETOS MODELO/` não são alterados nem incluídos no Git.

As pranchas ajudam a conferir nomes de sistemas, tags de ramais/colunas, símbolos e materiais declarados em cada projeto. Informações particulares das pranchas (diâmetros, vazões, pressões, bombas e soluções adotadas) não são premissas, coeficientes nem oráculo dos cálculos do Hydros System. Os critérios de cálculo devem vir da norma aplicável, dos dados do fabricante e das entradas aprovadas para o projeto em análise.
