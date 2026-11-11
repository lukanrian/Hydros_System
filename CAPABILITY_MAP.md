# Capability Map: Dimensionador de instalações prediais

## Objetivo

Criar um aplicativo desktop para dimensionar redes prediais de água fria, água quente e alimentação, com fluxo de trabalho semelhante ao Dimensionador Tipo Grelha: abrir IFC, montar e revisar a rede, calcular, selecionar bombas quando necessário e gerar resultados rastreáveis.

## Base encontrada

- Normas disponíveis: NBR 5626:2020 (água fria e quente) e NBR 7198:1993 (edição histórica). A própria NBR 5626:2020 informa que cancela e substitui a NBR 7198:1993; portanto, a edição de 2020 será a referência principal.
- Modelos IFC: três arquivos IFC4, com cerca de 1.386, 392 e 11.543 segmentos de tubo; dois têm dezenas de MB e o maior cerca de 100 MB.
- Catálogos: catálogo Schneider de seleção de bombas e catálogo WDM 2023.
- Pranchas de referência: 48 PDFs distribuídos entre os projetos 0035, 056-MARLUCI e OB-VII; os nomes dos arquivos correspondem aos três IFCs disponíveis. Incluem plantas, esquemas/detalhes e legendas.
- Aplicativo de referência: `DIMENSIONADOR TIPO GRELHA/PROGRAMA`, em .NET 10 para Windows, com leitor IFC, interface WinForms/WebView2, visualizador 2D/3D e solver hidráulico esparso.

### Uso das pranchas de projeto

As pranchas podem apoiar o reconhecimento de nomenclatura e a conferência visual dos modelos: identificadores como AF/AQ/AL e HID/D, legenda de aparelhos e válvulas, separação entre água fria/quente/alimentação/reúso, pavimentos, reservatórios, materiais declarados e trechos atendidos por gravidade ou pressurização. Elas ajudam a definir o que o leitor deve exibir e o que o projetista precisa revisar no IFC.

Essas informações são específicas de cada projeto. Diâmetros, cotas, pressões, vazões, capacidades e pontos de operação de bombas nelas anotados não serão usados como padrões, fatores ou fonte de validação numérica do Hydros System. Os memoriais continuam servindo somente de referência de apresentação; os cálculos usam norma, dados de fabricante e entradas do projeto corrente.

## Módulos propostos

| Módulo | Responsabilidade | Depende de |
|---|---|---|
| `ifc-reader` | Abrir IFC4, reconhecer unidades, elementos hidráulicos, propriedades e geometria; apontar dados ausentes ou não reconhecidos. | — |
| `network-topology` | Construir a rede por geometria/relacionamentos IFC, exibir conexões inferidas e permitir revisão antes do cálculo. | `ifc-reader` |
| `hydraulic-core` | Solver comum de nós, trechos, perdas, demandas e condições de contorno, com unidades e convergência verificáveis. | `ifc-reader`, `network-topology` |
| `cold-water` | Definir demanda de água fria por pontos de utilização e verificar vazões/pressões na rede. | `hydraulic-core` |
| `hot-water` | Dimensionar a distribuição e o retorno hidráulico de água quente com critérios próprios; a energia do aquecedor fica fora da primeira versão. | `hydraulic-core` |
| `feed-supply` | Dimensionar a alimentação e avaliar se a pressão disponível da concessionária atende à demanda, indicando a pressão/altura faltante quando não atender. | `hydraulic-core` |
| `pump-selection` | Ler curvas dos catálogos Schneider/WDM, calcular pontos de operação e classificar candidatos com dados e critérios rastreáveis. | `hydraulic-core`, `feed-supply` |
| `results-and-ui` | Interface para IFC, critérios e pressão de entrada; visualizações 2D/3D; planilhas e memorial com avisos, hipóteses e resultados por trecho. | Módulos de cálculo |

## Direção visual aprovada

A interface seguirá o estilo da imagem de referência: aplicativo desktop com barra superior de ações do projeto; painel lateral esquerdo com abas para projeto, trechos/pontos de utilização e bombas; área central ampla para visualizar e inspecionar a rede IFC; controles de enquadramento, seleção, vistas, cores e filtros próximos ao viewport; painel inferior/lateral de propriedades do elemento selecionado; e faixa inferior para status e saída.

As ações principais serão adaptar ao fluxo hidráulico: abrir IFC, analisar/dimensionar, selecionar bomba quando aplicável e gerar memorial. No modo alimentação, o painel Projeto apresentará a entrada da pressão dinâmica da concessionária e o destino configurável (reservatório ou rede direta). A interface manterá densidade visual e hierarquia semelhantes à referência, com rótulos e estados próprios para água fria, água quente e alimentação. O viewport 3D será baseado na visualização existente do Dimensionador Tipo Grelha (Three.js/WebGL em WebView2), reaproveitando e adaptando geometria IFC, seleção/foco, controles de câmera, enquadramento e vistas, em vez de criar um viewer paralelo.

## Estado atual

- Água fria e alimentação direta/reservatório calculam vazões, perdas Darcy–Weisbach, velocidade e pressão quando todas as entradas físicas obrigatórias estão explicitadas.
- Água quente calcula apenas a distribuição; o retorno e balanceamento ainda não estão modelados, portanto o resultado fica sinalizado como parcial.
- Uma curva publicada do sistema pressurizador WDM VPI1 EEP 1.5 15 está integrada para triagem dentro da faixa da tabela; a compatibilidade final requer revisão do fabricante.
- A exportação disponível é um relatório JSON rastreável. Memorial PDF e seleção do catálogo completo permanecem pendentes.

## Ordem de construção

`ifc-reader` → `network-topology` → `hydraulic-core` → `feed-supply`, `cold-water` e `hot-water` → `pump-selection` → `results-and-ui` e relatórios integrados.

A leitura e a topologia vêm primeiro porque os três tipos de cálculo dependem de uma rede IFC consistente. Os módulos de água fria, água quente e alimentação usam o mesmo solver, mas regras e condições de contorno separadas.

## Uso dos memoriais de referência

Os dois memoriais fornecidos são referências apenas para estrutura, organização, nomenclatura e apresentação do memorial de cálculo. Não são fonte de equações, critérios normativos, coeficientes, premissas hidráulicas nem resultados numéricos para os cálculos do aplicativo. Cálculos devem ser implementados a partir das normas aplicáveis e dados técnicos verificados dos fabricantes; qualquer informação extraída dos memoriais deve permanecer identificada como exemplo documental.

## Hipóteses iniciais

- O novo aplicativo ficará nesta pasta `Hydros_System`; o Dimensionador Tipo Grelha existente servirá como referência e não terá seu cálculo de sprinklers alterado.
- Os três sistemas serão opções de cálculo separadas que podem compartilhar a topologia do mesmo IFC.
- Para alimentação, o usuário informará a pressão disponível na entrada da concessionária e o aplicativo a usará como condição de contorno para verificar atendimento e necessidade de pressurização.
- A pressão será informada em m.c.a. com conversão explícita para bar/kPa.
- A NBR 5626:2020 será a base para água fria e quente; a NBR 7198:1993 será conservada como material histórico de consulta, não como regra principal.

## Padrões aprovados para a primeira versão

- A pressão de entrada da concessionária é a pressão dinâmica/residual disponível durante a vazão de projeto.
- Água quente inclui distribuição e retorno hidráulico, sem dimensionamento energético do aquecedor nesta versão.
- A alimentação permite configurar o destino entre reservatório predial e rede direta.
