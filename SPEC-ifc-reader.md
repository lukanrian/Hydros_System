# Spec: ifc-reader — Importação de modelos hidráulicos IFC

## Objetivo

Importar os IFCs hidráulicos do projeto como dados rastreáveis para visualização 3D e reconstrução revisável da rede. A visualização 3D do Dimensionador Tipo Grelha será a base a reutilizar e adaptar; o leitor fornece dados geométricos/identificadores e candidatos de conexão por geometria, sem dimensionar tubulações nem confirmar conexões inferidas automaticamente.

Usuário principal: projetista de instalações prediais que abre um IFC na interface desktop e precisa saber o que foi reconhecido, o que falta e o que foi ignorado antes de analisar a rede.

## Escopo da primeira versão

- Abrir arquivo IFC local e preservar o original.
- Confirmar esquema IFC, unidades do modelo e estrutura espacial.
- Extrair elementos relevantes: segmentos e conexões de tubulação, válvulas, bombas, terminais e componentes hidráulicos reconhecidos pelo IFC.
- Registrar `GlobalId`, classe IFC, nome, tipo, pavimento/contêiner, propriedades e classificação/rede quando explicitamente atribuída no arquivo.
- Disponibilizar geometria/posicionamento dos produtos reconhecidos para visualização no visor 3D existente, mantendo `GlobalId`, coordenadas e fator de conversão rastreáveis.
- Preservar seleção de elemento, foco/orbita no selecionado, enquadramento do modelo, navegação por câmera e troca de vista já presentes no Dimensionador Tipo Grelha, adaptando-os à inspeção de redes prediais.
- Preservar relações IFC explícitas entre portas/elementos e gerar candidatos geométricos separados para revisão no módulo `network-topology`.
- Exibir resumo de importação e avisos por elemento ou arquivo.
- Permitir conferência visual dos rótulos e componentes IFC contra as pranchas PDF correspondentes, preservando a prancha como referência documental separada dos dados calculados.

Não faz parte deste módulo: atribuir água fria/quente/alimentação quando o IFC não informa; confirmar conexões sugeridas por proximidade; escolher diâmetros; calcular vazão, velocidade, perda ou pressão; selecionar bombas. Candidatos geométricos são apenas sugestões para revisão manual em módulos posteriores.

## Base técnica e modelos-alvo

A aplicação de referência usa .NET 10 para Windows. Seu visor usa Three.js/WebGL em WebView2, geometria indexada por `GlobalId`, carregamento IFC separado e `camera-controls` com órbita, pan, dolly/zoom, foco no elemento, enquadramento, perspectiva e vista superior. O novo programa reutiliza essas bibliotecas e padrões em uma UI própria; não referencia nem altera os assemblies/aplicativo de sprinklers. A geometria é lida pelo `web-ifc` em um Web Worker; xBim só será adicionado se uma necessidade de propriedades ou relações não puder ser atendida com os dados atuais. Os três IFCs disponíveis são IFC4 e contêm, respectivamente, cerca de 1.386, 392 e 11.543 `IfcPipeSegment`; também incluem conexões, válvulas, bombas, pavimentos e grandes quantidades de property sets. O maior arquivo tem aproximadamente 100 MB.

## Stack e comandos previstos

- Windows desktop: .NET 10 WinForms + WebView2.
- Viewer: Three.js, `camera-controls` e `web-ifc` reutilizados do programa de referência, com licenças distribuídas junto aos arquivos copiados.
- Evitar um segundo parser até surgir necessidade concreta de metadados que o `web-ifc` não exponha de forma confiável.
- Compilar: `dotnet build Hydros.System.sln`.
- Executar: `dotnet run --project src/Hydros.System.UI/Hydros.System.UI.csproj`.
- Verificação manual: abrir cada IFC de fixture, observar progresso/resumo, interagir com a cena 3D e confirmar que seleção/zoom/foco funcionam.

## Estrutura prevista

- `src/Hydros.System.UI/`: janela WinForms/WebView2, host seguro de arquivos locais e recursos web.
- `src/Hydros.System.UI/Web/`: shell visual e viewer Three.js derivado do padrão do app de referência.
- `src/Hydros.System.IfcReader/`: leitura e normalização de IFC, se confirmada pelo plano como necessária além do web-ifc.
- `tasks/`: plano e checklist de entrega.
- `Catalogo/`, `IFC Modelo/`, `Normas/`: fixtures/referências locais, mantidas fora do controle de versão.

## Convenções de código

Manter nomes/contratos explícitos e dados IFC com origem identificável. Nenhum campo dimensional desconhecido vira zero nem é interpretado como unidade conhecida. Exemplo de saída acionável: `IfcPipeSegment { GlobalId, Storey, SystemLabel, Geometry, Warnings[] }`; `SystemLabel` só é preenchido se explícito no IFC. Erros são retornados com o caminho/GlobalId e não substituem projeto previamente carregado.

## Estratégia de verificação

Compilar em fatias; fazer verificação manual com os três IFCs reais. Verificar transformações de unidade/coordenada, quantidade de elementos e estabilidade da seleção na viewport. A geometria IFC não é validada por resultados dos memoriais. Não criar fixtures sintéticas sem lacuna concreta nos IFCs reais; verificações adicionais devem ser pequenas e focadas.

## Limites e segurança

- Sempre: validar extensão/arquivo no limite de abertura, restringir endpoint WebView2 ao IFC selecionado, não permitir caminhos arbitrários vindos da página, preservar o IFC original e sinalizar incerteza.
- Sempre: abrir projeto novo de forma transacional, só trocar o projeto visível após importação válida.
- Nunca: inferir sistema hidráulico silenciosamente, usar memorial como fonte de cálculo ou alterar o Dimensionador Tipo Grelha original.
- As pranchas PDF dos projetos são fontes auxiliares para nomes, legendas e conferência de representação; não são fonte de critérios, coeficientes, demanda, perda de carga ou validação de resultado numérico.
- Dentro deste módulo: importar IFC4 dos modelos fornecidos; IFC2x3 não está garantido na primeira versão.
- Risco: IFC de ~100 MB pode exigir memória elevada ao converter geometria para malhas; medir e limitar a retenção antes de implementar otimização complexa.

## Contrato de saída

A importação produz um modelo intermediário com:

- metadados do arquivo: caminho, esquema IFC, unidades, origem e resumo de contagens;
- produtos reconhecidos: identidade estável (`GlobalId`), classe IFC, nome/tipo, pavimento, classificação/rede explícita, propriedades originais selecionadas e geometria/posicionamento;
- relações IFC explícitas entre elementos/portas, sem converter relações inferidas em fatos;
- avisos: item sem `GlobalId`, classe desconhecida, propriedade necessária ausente, unidade não suportada, produto sem geometria e elemento sem classificação hidráulica;
- erros fatais: arquivo inexistente/inacessível, IFC inválido/corrompido, esquema não suportado ou unidades impossíveis de interpretar com segurança.

Valores dimensionais usados por módulos posteriores devem ser normalizados para unidades internas documentadas (comprimento em metros), com unidade original e fator preservados para auditoria. Propriedades sem unidade ou com unidade desconhecida ficam marcadas como não normalizadas; o leitor não adivinha a unidade.

## Regras de reconhecimento

1. Usar a classe IFC e suas relações/tipos como evidência primária.
2. Ler a identificação de rede/sistema apenas quando existir como propriedade ou relação explícita; guardar o nome e o caminho de origem dessa informação.
3. Não deduzir sistema por cor, nome livre isolado, diâmetro ou proximidade. A proximidade geométrica pode sugerir pares de conexão, mas deve ser identificada como inferência e nunca tratada como relação IFC explícita ou confirmação do usuário.
4. Não remover nem fundir elementos duplicados; reportar `GlobalId` ausente ou repetido.
5. Não descartar silenciosamente classes não reconhecidas: contabilizá-las no resumo e torná-las inspecionáveis quando possível.
6. Não alterar nem regravar o IFC original.

## Interface com módulos vizinhos

- `network-topology` recebe os produtos, portas e relações IFC explícitas, além de candidatos geométricos identificados separadamente; conexões sugeridas exigem confirmação e permanecem revisáveis.
- Para recirculação de água quente, preservar a classificação explícita da rede de retorno (rótulo contendo “retorno” ou “recirculação”) separada da rede de distribuição. A topologia hidráulica deriva as alças nos nós confirmados comuns às duas redes; rótulos ausentes/ambíguos ou conexões abertas devem bloquear essa etapa.
- `hydraulic-core` recebe geometria, propriedades normalizadas e classificação confirmada, nunca dados dimensionais ambíguos como se fossem válidos.
- `results-and-ui` apresenta barra de ações (abrir/analisar), painel lateral de projeto/elementos/bombas, viewport central, propriedades da seleção, status e saída, conforme a direção visual aprovada. O viewport deve reaproveitar/adaptar a cena WebGL, a navegação por câmera, o enquadramento, seleção/foco e carregamento de geometria do Dimensionador Tipo Grelha. O leitor fornece dados e identificadores para o viewer; não controla o layout.

## Fluxo de erro e estado

- A leitura acontece sem bloquear indefinidamente a interface e informa progresso/status.
- Cancelamento interrompe a importação e libera os recursos do modelo.
- Um IFC que abre parcialmente não recebe status de importação válida sem relatório explícito dos itens omitidos.
- Falhas não substituem o projeto atualmente carregado até que uma nova importação termine com sucesso.

## Verificação e critérios de aceite

- Os três IFCs fornecidos abrem sem alterar os arquivos de origem.
- Antes do cálculo, a geometria do IFC aparece no viewer 3D derivado do Dimensionador Tipo Grelha, com seleção por elemento, foco/orbita e enquadramento operantes.
- O resumo reconhece contagens de segmentos, conexões, válvulas, bombas e pavimentos compatíveis com o conteúdo de cada arquivo. Contagens divergentes são explicadas e rastreáveis, nunca corrigidas por estimativa silenciosa.
- Unidades e coordenadas são coerentes com a escala do IFC; uma geometria em mm não é interpretada como metros.
- Propriedades ausentes, unidades desconhecidas, GlobalIds duplicados e classes não reconhecidas produzem avisos acionáveis.
- Relações IFC explícitas e candidatos geométricos são apresentados separadamente; nenhum candidato é confirmado sem revisão manual.
- Arquivo malformado ou unidade ambígua gera erro claro e não substitui o modelo carregado.
- O maior IFC pode ser lido com progresso, cancelamento e sem congelar a interface; o consumo de memória será medido no plano/implementação antes de fixar um limite numérico.

## Estratégia de verificação

Fixtures: os três IFCs fornecidos; adicionar fixtures sintéticas pequenas para unidades e casos inválidos somente se os modelos reais não cobrirem esses casos. Verificação unitária das conversões/extração de propriedades e integração de leitura para cada IFC. Inspeção manual do resumo e da geometria no viewport. Não usar resultados dos memoriais como oráculo de cálculo.

## Limites e riscos

- Exportadores BIM variam na forma de representar sistemas, portas, diâmetros e propriedades; classes IFC são evidência mais confiável que rótulos livres, mas podem ser incompletas.
- O IFC maior e os property sets podem elevar o uso de memória; avaliar leitura incremental e retenção seletiva antes de introduzir abstrações de streaming.
- A aceitação de IFC2x3 ou outros esquemas não está incluída nesta primeira especificação; os modelos atuais são IFC4.

## Questões em aberto

Nenhuma para redigir esta especificação. O plano deve decidir o menor corte de código reutilizável do viewer existente e como adaptar seleção/coloração para elementos hidráulicos, preservando o comportamento atual do Dimensionador Tipo Grelha.
