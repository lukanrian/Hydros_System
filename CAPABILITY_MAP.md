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

| Módulo | Responsabilidade | Depende de | Estado atual |
|---|---|---|---|
| `ifc-reader` | Abrir IFC4, reconhecer unidades, elementos hidráulicos, propriedades e geometria; apontar dados ausentes ou não reconhecidos. | — | Importação e resumo disponíveis; conferência visual geral dos três modelos pendente. |
| `network-topology` | Construir a rede a partir de relações/portas IFC e candidatos geométricos, revisar conexões antes do cálculo. | `ifc-reader` | Sugestões geométricas ficam pendentes até confirmação; decisões persistem por IFC. |
| `hydraulic-core` | Solver comum de nós, trechos, perdas, demandas e condições de contorno, com unidades e convergência verificáveis. | `ifc-reader`, `network-topology` | Água fria e alimentação disponíveis para entradas completas; limitações de rede e dados são reportadas. |
| `cold-water` | Definir demanda de água fria por pontos de utilização e verificar vazões/pressões na rede. | `hydraulic-core` | Implementado para dados de projeto explícitos. |
| `hot-water` | Dimensionar distribuição e retorno hidráulico de água quente; energia do aquecedor fica fora da primeira versão. | `hydraulic-core` | Recirculação calcula vazões térmicas por alça, rateia perdas de troncos comuns, soma vazões nos tubos compartilhados e calcula altura crítica/perda de balanceamento. Exige redes de ida e retorno explícitas no IFC; nenhum dos três IFCs fornecidos marca o retorno, então eles continuam parciais nesse modo. |
| `feed-supply` | Dimensionar a alimentação e avaliar se a pressão disponível da concessionária atende à demanda, indicando a pressão/altura faltante quando não atender. | `hydraulic-core` | Modos de alimentação direta e a reservatório disponíveis. |
| `pump-selection` | Ler curvas dos catálogos Schneider/WDM, calcular pontos de operação e classificar candidatos com dados e critérios rastreáveis. | `hydraulic-core`, `feed-supply` | 24 opções listadas; avaliação automática tabulada somente para WDM VPI1 EEP 1.5 15. |
| `results-and-ui` | Interface para IFC, critérios e pressão de entrada; visualizações 2D/3D; relatórios e memorial com avisos, hipóteses e resultados por trecho. | Módulos de cálculo | Exportação JSON e memorial Word disponíveis; inspeção visual geral ainda pendente. |

## Direção visual aprovada

A interface seguirá o estilo da imagem de referência: aplicativo desktop com barra superior de ações do projeto; painel lateral esquerdo com abas para projeto, trechos/pontos de utilização e bombas; área central ampla para visualizar e inspecionar a rede IFC; controles de enquadramento, seleção, vistas, cores e filtros próximos ao viewport; painel inferior/lateral de propriedades do elemento selecionado; e faixa inferior para status e saída.

As ações principais serão adaptar ao fluxo hidráulico: abrir IFC, analisar/dimensionar, selecionar bomba quando aplicável e gerar memorial. No modo alimentação, o painel Projeto apresentará a entrada da pressão dinâmica da concessionária e o destino configurável (reservatório ou rede direta). A interface manterá densidade visual e hierarquia semelhantes à referência, com rótulos e estados próprios para água fria, água quente e alimentação. O viewport 3D será baseado na visualização existente do Dimensionador Tipo Grelha (Three.js/WebGL em WebView2), reaproveitando e adaptando geometria IFC, seleção/foco, controles de câmera, enquadramento e vistas, em vez de criar um viewer paralelo.

## Estado atual

- Build e 46 testes automatizados foram registrados como aprovados na verificação anterior. O smoke test mais recente do IFC 056-MARLUCI confirmou importação de 753 elementos e interações da interface; o cálculo foi interrompido porque a origem da rede não estava definida, portanto não comprova um cálculo hidráulico completo. Os três IFCs fornecidos não exercitam recirculação porque seus rótulos não identificam retorno. A revisão visual geral continua pendente.

- Água fria e alimentação direta/reservatório calculam vazões, perdas Darcy–Weisbach, velocidade e pressão quando todas as entradas físicas obrigatórias estão explicitadas.
- Água quente calcula a distribuição; a recirculação também é calculada quando o IFC classifica ida/retorno e fecha as alças. O IFC 056-MARLUCI não identifica retorno e, nesse modelo, o resultado segue sinalizado como parcial.
- Para água quente com retorno explicitamente classificado no IFC, o fluxo usa perda térmica informada por tubo (W/m), comprimento e ΔT. As alças são os encontros confirmados entre distribuição e retorno; perdas térmicas comuns são rateadas proporcionalmente às perdas exclusivas. A hidráulica usa Darcy–Weisbach. A válvula de balanceamento e a curva da circuladora ainda exigem validação/dados de fabricante.
- O seletor lista 24 opções WDM/Rowa, mostra as curvas gráficas originais Rowa quando as imagens do catálogo estão na instalação local e avalia automaticamente apenas a WDM VPI1 EEP 1.5 15, cuja curva está tabulada. Compatibilidade final requer revisão do fabricante. Circuladoras Rowa para retorno quente aparecem com suas especificações, mas a hidráulica do retorno segue pendente.
- A exportação inclui relatório JSON e memorial editável em Word (.docx). O catálogo disponível ainda não tem todas as curvas tabuladas.

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
