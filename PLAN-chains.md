# Plan: criação de chains para subagentes

## Context

Queremos adicionar ao `pi-background-subagents` uma nova capacidade de orquestração chamada **chain**: um fluxo de fases executadas por subagentes, com handoffs explícitos entre fases, status agregado, retomada manual em caso de falha e suporte planejado para stages paralelos.

A chain deve ser uma abstração acima de `subagent`: cada fase roda como um subagente isolado, mas o runtime da chain controla quais inputs a fase pode ler e qual output ela deve produzir.

## Approach

### Formato e descoberta

- O formato oficial será YAML, com arquivos nomeados como `NOME_DA_CHAIN.chain.yaml`.
- Aceitar `.chain.yml` como alias é permitido, mas a documentação deve recomendar `.chain.yaml`.
- Chains serão descobertas no mesmo padrão dos agents:
  - user: `~/.pi/agent/chains/*.chain.yaml`
  - project: `<project>/.pi/chains/*.chain.yaml`
  - scope: `user | project | both`
- Em `both`, chains de projeto sobrescrevem chains de usuário com o mesmo `name`.
- No MVP, chains serão somente definidas por arquivo. Definições inline/runtime ficam para evolução futura.

### Tooling/UX

Criar uma nova tool chamada `chain`, separada de `subagent`.

Actions propostas:

```ts
chain({ action: "list", chainScope?: "user" | "project" | "both" })
chain({ action: "start", chain: "tdd-pipeline", task: "...", chainScope?: "user" | "project" | "both" })
chain({ action: "status", chainId: "chain-...", verbose?: boolean })
chain({ action: "result", chainId: "chain-..." })
chain({ action: "resume", chainId: "chain-..." })
```

### Modelo de execução

- A chain é composta por **stages** ordenados.
- O modo de execução é declarado por stage, não globalmente.
- Um stage pode conter:
  - uma fase única, executada sequencialmente; ou
  - múltiplas fases em paralelo, via `mode: parallel` e `phases`.
- A chain só avança para o próximo stage quando todas as fases do stage atual completarem com sucesso.
- Fases paralelas podem ler outputs de stages anteriores, mas não podem depender de outputs de siblings no mesmo stage.
- O MVP deve suportar os dois modos: fases sequenciais e stages com `mode: parallel`.

### Handoff entre fases

- Handoff é explícito por arquivo.
- Cada fase declara:
  - `reads`: arquivos de handoff que pode ler;
  - `output` ou `outputs`: arquivo(s) que deve produzir.
- Outputs não são injetados automaticamente no prompt da próxima fase.
- Para preservar tokens, o prompt da fase lista um contrato de inputs e a fase usa `chain_read` sob demanda.
- O último agente normalmente lê os outputs relevantes anteriores e escreve o resumo final da chain.

### Tools de chain

Ao executar uma fase, o runtime deve fornecer tools escopadas à chain/fase:

- `chain_read`
- `chain_output`

Regras:

- `chain_read` só pode ler arquivos declarados em `reads`.
- `chain_output` só pode escrever o arquivo declarado em `output` ou os arquivos declarados em `outputs`.
- Se houver um único `output`, `chain_output({ content })` é suficiente.
- Se houver múltiplos `outputs`, `filename` é obrigatório e deve estar na allowlist.
- `chain_read` deve espelhar a ergonomia da tool `read` do Pi:
  - `filename`
  - `offset` opcional, linha inicial 1-indexed
  - `limit` opcional, número máximo de linhas
- Como `read`, `chain_read` deve truncar resultados grandes por padrão e orientar uso de `offset`/`limit` para continuar em chunks.
- `chain_read` e `chain_output` só existem no processo/fase em execução e não devem permitir path arbitrário.

### Prompt de contrato da fase

O runtime deve complementar o prompt da fase com blocos explícitos:

```text
Chain input contract

The following handoff files are part of your phase contract.
Do not assume their contents from filenames alone.
Use chain_read({ filename }) to inspect every file relevant to your phase before producing output.

Allowed inputs:
- context.md
- red.md
```

```text
Chain output contract

You must produce the required phase output using chain_output.
Do not write handoff files directly.

Allowed outputs:
- green.md
```

### Tools normais do agente

- Se a fase não declarar `tools`, usar as tools do agent selecionado mais as tools de chain necessárias.
- Se a fase declarar `tools`, usar apenas a interseção segura entre tools do agent e tools declaradas na fase, além das tools de chain necessárias.
- O YAML não deve elevar permissões além do que o agent já permite.

### Falha e retomada

Política do MVP:

- Se uma fase falhar, a chain para em estado resumível.
- O agente pai deve ser avisado com:
  - chain id;
  - nome da chain;
  - stage/fase;
  - agente;
  - tentativa;
  - erro resumido;
  - ação sugerida para retomar.
- `chain({ action: "resume", chainId })` deve reexecutar somente a fase que falhou.
- Fases anteriores bem-sucedidas não rodam de novo.
- A fase retomada deve receber contexto da falha anterior:
  - task original;
  - prompt original;
  - `reads` declarados;
  - outputs anteriores já promovidos;
  - erro/exit code;
  - stdout/stderr/eventos relevantes;
  - output parcial, se existir.
- O diretório da chain deve guardar tentativas por fase, por exemplo:
  - `{chain_dir}/phases/red/attempt-1/...`
  - `{chain_dir}/phases/red/attempt-2/...`
- O output oficial da fase só deve ser promovido para `{chain_dir}/outputs/<file>` quando a tentativa terminar com sucesso e chamar `chain_output` validamente.
- Retry automático fica para evolução futura.

## Files to modify

- `index.ts` — registrar a nova tool `chain`, orquestrar execução, status/result/resume e integração com `startJob`/processos.
- `agents.ts` — reutilizar descoberta de agents e, se necessário, extrair helpers compartilháveis.
- `chains.ts` — novo módulo para descoberta, parsing, normalização e validação de `*.chain.yaml`.
- `README.md` — documentar formato YAML, discovery, UX e exemplos.
- `examples/chains/README.md` — documentar exemplos.
- `examples/chains/tdd-pipeline.chain.yaml` — exemplo sequencial.
- `examples/chains/parallel-review.chain.yaml` — exemplo com stage paralelo.

## Reuse

- `startJob()` em `index.ts` como base para lançar cada fase como subagente.
- `JobMetadata`, status files, stdout/stderr/messages/result artifacts e diretórios em `os.tmpdir()/pi-subagents/...`.
- `discoverAgents()` em `agents.ts` para resolver agentes por nome.
- `readJson/writeJson`, `safeName`, `getBaseDir/getSessionId` em `index.ts` para persistência.
- Semântica da tool `read` do Pi para `chain_read` (`offset`/`limit`).

## Steps

- [ ] Criar `chains.ts` com tipos `ChainConfig`, `ChainStage`, `ChainPhase`, discovery user/project/both e parsing YAML.
- [ ] Adicionar suporte a arquivos `*.chain.yaml` e alias `*.chain.yml`.
- [ ] Criar exemplos YAML em `examples/chains/`.
- [ ] Registrar nova tool `chain` com actions `list`, `start`, `status`, `result`, `resume`.
- [ ] Implementar criação de `chain_dir`, `chain status.json`, diretório `outputs/` e diretórios por fase/tentativa.
- [ ] Implementar execução sequencial usando subagentes existentes.
- [ ] Implementar execução de stages paralelos com `mode: parallel`, aguardando todas as fases do stage completarem antes de avançar.
- [ ] Implementar injeção dos blocos `Chain input contract` e `Chain output contract` no prompt da fase.
- [ ] Implementar `chain_read` escopado por fase, com `filename`, `offset`, `limit`, truncamento e validação contra `reads`.
- [ ] Implementar `chain_output` escopado por fase, validando `output`/`outputs` e promovendo output oficial ao final da tentativa bem-sucedida.
- [ ] Implementar restrição de tools por fase via interseção entre agent tools e YAML `tools`.
- [ ] Implementar falha resumível, notificação ao agente pai e `chain resume`.
- [ ] Implementar status/result agregados da chain.
- [ ] Documentar formato, exemplos, limitações do MVP e comportamento de resume.
- [ ] Documentar e validar `mode: parallel` como parte do MVP.

## Verification

- `chain list` mostra chains de usuário/projeto conforme `chainScope`.
- `chain start` executa uma chain sequencial curta com duas fases.
- `chain start` executa uma chain com stage `mode: parallel`, roda siblings em paralelo e só avança após todas as fases concluírem.
- A primeira fase só completa após chamar `chain_output` corretamente.
- A segunda fase consegue ler o output da primeira via `chain_read`.
- `chain_read` nega arquivos não declarados em `reads`.
- `chain_output` nega arquivos não declarados em `output`/`outputs`.
- `chain_read` respeita `offset`/`limit` e truncamento.
- Fase com `tools` no YAML recebe apenas a interseção segura esperada mais tools de chain necessárias.
- Falha em fase para a chain, notifica o agente pai e preserva estado resumível.
- `chain resume` reexecuta apenas a fase falhada e, se passar, continua a chain.
- `chain status` e `chain result` mostram estado agregado, fases, tentativas, outputs e erros relevantes.

## YAML examples

### `examples/chains/tdd-pipeline.chain.yaml`

```yaml
name: tdd-pipeline
description: Execute a task through context, red, green, refactor, and review phases

stages:
  - id: context
    agent: context-builder
    output: context.md
    outputMode: file-only
    prompt: |
      Architecture & Context Analysis.

      Goal: resolve the implementation surface for the task below and produce a compact handoff for the next phases.

      Task:
      {task}

      Contract:
      - Inspect the relevant project files, docs, tests, configuration, and tracker context needed to understand the task.
      - Identify affected modules, dependencies, entry points, existing patterns, risks, and constraints.
      - Define a validation contract: expected behavior, acceptance criteria, focused test commands, full validation commands when practical, and any manual checks needed.
      - Do not modify project/source files.

      Output: call chain_output with sections for task summary, affected surface area, validation contract, assumptions, risks, and recommended next-step guidance for RED.

  - id: red
    agent: red
    reads:
      - context.md
    output: red.md
    outputMode: file-only
    prompt: |
      RED phase.

      Goal: create the smallest failing tests that specify the required behavior.

      Contract:
      - Use chain_read to inspect context.md before producing output.
      - Use the original task: {task}
      - Write failing tests only. Do not implement production behavior.
      - Run the smallest relevant test command and prove the new tests fail for the expected reason.

      Output: call chain_output with changed test files, commands run with exit codes, expected failure evidence, and any constraints for GREEN.

  - id: green
    agent: green
    reads:
      - context.md
      - red.md
    output: green.md
    outputMode: file-only
    progress: true
    prompt: |
      GREEN phase.

      Goal: implement the minimum production change needed to pass the RED tests.

      Contract:
      - Use chain_read for every declared input relevant to the phase before producing output.
      - Make the smallest safe production change that satisfies the failing tests.
      - Run the focused test command from RED and confirm green status.

      Output: call chain_output with changed files, implementation summary, commands run with exit codes, validation evidence, surprises/risks, and guidance for REFACTOR.

  - id: refactor
    agent: worker
    reads:
      - context.md
      - red.md
      - green.md
    output: refactor.md
    outputMode: file-only
    progress: true
    prompt: |
      REFACTOR phase.

      Goal: clean up the green implementation while preserving behavior and tests.

      Contract:
      - Use chain_read for every declared input relevant to the phase before producing output.
      - Inspect the current diff directly.
      - Improve clarity and maintainability without expanding product scope.
      - Preserve green tests throughout refactoring.

      Output: call chain_output with refactors performed, files changed, commands run with exit codes, validation evidence, remaining risks, and guidance for REVIEW.

  - id: review
    agent: reviewer
    reads:
      - context.md
      - red.md
      - green.md
      - refactor.md
    output: review.md
    outputMode: file-only
    prompt: |
      QA & Code Review phase.

      Goal: verify the final diff against the task, validation contract, and project standards.

      Contract:
      - Use chain_read for every declared input relevant to the phase before producing output.
      - Inspect the actual repository diff and relevant files directly.
      - Verify tests pass or report exactly what could not be validated.
      - Check correctness, regressions, scope control, test quality, simplicity, maintainability, and project conventions.

      Output: call chain_output with verdict, validation evidence, findings with file/line references when available, and any deferred follow-ups with durable context.
```

### `examples/chains/parallel-review.chain.yaml`

```yaml
name: parallel-review
description: Build context once, then run independent review agents in parallel, then summarize

stages:
  - id: context
    agent: context-builder
    output: context.md
    outputMode: file-only
    prompt: |
      Context phase.

      Task:
      {task}

      Contract:
      - Inspect only what is needed to understand the requested review.
      - Identify relevant files, commands, risks, and acceptance criteria.
      - Do not modify project/source files.

      Output: call chain_output with a compact review brief.

  - id: review
    mode: parallel
    reads:
      - context.md
    phases:
      - id: code-review
        agent: reviewer
        output: code-review.md
        outputMode: file-only
        prompt: |
          Code review phase.

          Contract:
          - Use chain_read to inspect context.md before producing output.
          - Inspect the current diff and relevant files.
          - Do not modify files.
          - Review correctness, scope, maintainability, regressions, and test coverage.

          Output: call chain_output with findings grouped by severity.

      - id: decision-review
        agent: oracle
        output: decision-review.md
        outputMode: file-only
        prompt: |
          Decision consistency review phase.

          Contract:
          - Use chain_read to inspect context.md before producing output.
          - Inspect the current diff and relevant files.
          - Do not modify files.
          - Look for hidden assumptions, inconsistent decisions, architecture drift, and missing product/scope decisions.

          Output: call chain_output with blockers, risks, and recommended decisions.

      - id: test-review
        agent: red
        output: test-review.md
        outputMode: file-only
        prompt: |
          Test quality review phase.

          Contract:
          - Use chain_read to inspect context.md before producing output.
          - Inspect tests relevant to the task.
          - Do not modify files.
          - Evaluate whether tests encode the real behavior at the correct seam.

          Output: call chain_output with test-quality findings and suggested commands.

  - id: summarize
    agent: worker
    reads:
      - context.md
      - code-review.md
      - decision-review.md
      - test-review.md
    output: summary.md
    outputMode: file-only
    prompt: |
      Synthesis phase.

      Contract:
      - Use chain_read for every declared input relevant to the phase before producing output.
      - Use the original task: {task}
      - Do not modify project/source files.
      - Consolidate duplicate findings.
      - Separate blockers from optional follow-ups.

      Output: call chain_output with final verdict, prioritized findings, validation evidence, and recommended next action.
```
