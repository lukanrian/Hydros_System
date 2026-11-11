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

A aba **Pontos** coleta vazão, pressão requerida e fonte por terminal. Marque os pontos simultâneos; **Calcular vazões** agrega as demandas em cada tubo do grafo radial confirmado. Para perdas e pressões, informe temperatura e, por tubo, diâmetro interno, comprimento, rugosidade absoluta, K localizado total e fonte. Comprimentos IFC reconhecidos podem ser usados com a propriedade/unidade original rastreada. O cálculo usa Darcy–Weisbach e calcula velocidade, atrito e pressão nos nós. A dimensão do tubo permanece a informada pelo projetista; o programa ainda não escolhe diâmetros. As cotas de junção são calculadas pela média das cotas dos endpoints IFC confirmados e precisam ser verificadas contra o datum do projeto.

A aba **Bombas** avalia o ponto contra a curva publicada do sistema WDM VPI1 EEP 1.5 15, com interpolação apenas dentro da faixa tabelada. É uma triagem de um modelo e requer confirmação de temperatura, tensão, sucção e instalação. **Exportar relatório JSON** inclui entradas, fontes, resultados por trecho/ponto, avisos e limitações. A água quente ainda não calcula retorno/balanceamento; esse modo não é dimensionamento final.

A aba **Conexões** agrega somente ligações geométricas confirmadas manualmente e informa extremidades abertas/componentes desconectados. O leitor mostra associações de material e dimensões quando o IFC as fornece; não interpreta diâmetro nominal como diâmetro interno. Consulte [SPEC-hydraulic-engine.md](SPEC-hydraulic-engine.md) para as próximas entregas e requisitos de entrada.

O viewer deriva do padrão Three.js/WebGL e `camera-controls` do Dimensionador Tipo Grelha. As bibliotecas distribuídas e suas licenças estão em `src/Hydros.System.UI/Web/lib`. O app original, os IFCs, catálogos, normas e as pranchas de referência em `PROJETOS MODELO/` não são alterados nem incluídos no Git.

As pranchas ajudam a conferir nomes de sistemas, tags de ramais/colunas, símbolos e materiais declarados em cada projeto. Informações particulares das pranchas (diâmetros, vazões, pressões, bombas e soluções adotadas) não são premissas, coeficientes nem oráculo dos cálculos do Hydros System. Os critérios de cálculo devem vir da norma aplicável, dos dados do fabricante e das entradas aprovadas para o projeto em análise.
