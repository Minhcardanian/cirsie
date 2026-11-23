# Cirsie · ZKIR Explorer for VS Code

![Cirsie logo](extension/logo.png)

Cirsie lets you inspect and compare Midnight circuit artifacts in VS Code. It reads the files locally and shows how values flow between instructions.

## What is ZKIR?

**ZKIR** stands for **zero-knowledge intermediate representation**. When the Midnight Compact compiler builds a smart contract circuit, it produces ZKIR instructions that describe its arithmetic, constraints, and data flow. The Midnight toolchain evaluates those instructions and can compile the circuit into proving and verifying keys. [Midnight ZKIR reference](https://github.com/midnightntwrk/midnight-zkir#readme)

```text
Compact source (.compact) → Compact compiler → circuit artifact (.zkir)
```

Cirsie opens the text artifact at the end of this pipeline. The bundled artifacts use ZKIR 3.1 and were compiled with Compact 0.36.1. Cirsie recognizes ZKIR 2.0, 3.0, and 3.1 with partial opcode coverage. [Compact 0.36 release notes](https://docs.midnight.network/relnotes/compact/toolchain-0.36.0)

## Why use Cirsie?

- **Trace a value through the compiled circuit.** Select an instruction to inspect its operands and follow links to the instructions that produce or consume its values.
- **See what changed between builds.** Compare the same circuit before and after a source change to see opcode counts and changed instructions. The bundled comparison shows how changing `x + 1` to `x * x + 1` introduces a `mul` instruction.
- **Investigate an unfamiliar artifact.** Inspect raw instructions alongside decoded operands and warnings for unsupported opcodes or unresolved identifiers.

Cirsie performs structural inspection. Proof verification, semantic equivalence, and estimates of proving cost are outside its scope.

## Set up Cirsie

### Build and install the extension

Use desktop VS Code and Node.js 22. Clone the repository and build the VSIX.

```sh
git clone https://github.com/Minhcardanian/cirsie.git
cd cirsie
npm ci
npm run package -- --out ./cirsie.vsix
```

In VS Code, open the Command Palette and run **Extensions: Install from VSIX…**. Select `cirsie.vsix`. For a Remote WSL workspace, install from the window connected to WSL and confirm the extension appears under the WSL group in Extensions. [VS Code WSL extension guide](https://code.visualstudio.com/docs/remote/wsl#managing-extensions)

### Try the bundled circuits

1. Run **ZKIR Explorer: Load Example Baseline**. Select **#0 add** and follow its consumer **#2 impact** in the dependency graph.
2. Run **ZKIR Explorer: Compare with Candidate** and choose `public/examples/changed.zkir`. The report should show **4 → 5 instructions** and **`mul` 0 → 1**.

### Inspect a circuit from your own contract

If you already have a UTF-8 JSON `.zkir` file, run **ZKIR Explorer: Open Baseline** and select it. To generate one from Compact source, install the Compact toolchain and use a compiler version appropriate for your project. This example pins the same compiler release used for the bundled circuits. [Compact installation guide](https://docs.midnight.network/getting-started/installation)

```sh
compact update 0.36.1 --no-set-default
compact compile +0.36.1 --skip-zk path/to/contract.compact ./build
```

Open the relevant `build/zkir/<circuit>.zkir` file. The `--skip-zk` option emits the circuit artifacts while skipping key generation.

### Development checks

```sh
npm test
npm run build
```
