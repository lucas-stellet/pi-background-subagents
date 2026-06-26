# Chain examples

Chains use YAML files named `NOME_DA_CHAIN.chain.yaml`.

- `tdd-pipeline.chain.yaml`: sequential TDD pipeline.
- `parallel-review.chain.yaml`: mixed chain with a parallel review stage.

Each phase declares `reads` and `output`/`outputs`. During execution, phases use `chain_read` to inspect declared inputs and `chain_output` to produce official handoff outputs.
