# SingleSpark contracts

On-chain project vaults, revenue plugins, governance and launchpad integrations. Each project keeps its own funds and budgets.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `chains/<chain>/launchpads/<platform>/` | Platform contracts and their tests |
| `chains/evm/` | Shared EVM contracts; not a public network |
| `chains/solana/` | Solana programs and shared accounts |
| `scripts/<chain>/launchpads/<platform>/production/` | Production deployment tools |
| `scripts/<chain>/launchpads/<platform>/testnet/` | Public testnet build, deployment and acceptance tools |
| `scripts/<chain>/launchpads/<platform>/local/` | Local forks and integration checks |
| `scripts/arc/shared/`, `scripts/arc/local/` | Existing ARC runtime, deployment preflight and integration checks |
| `deployments/mainnet/`, `deployments/testnet/`, `deployments/local/` | Public configuration and evidence, then chain and launchpad |
| `docs/` | Protocol, custody and operating guides |
| `arc/`, `evm/`, `robinhood/`, `solana/` | Stable Foundry/Cargo build roots and dependencies |

Frontend asset generators and browser checks belong to `SingleSparkFront/scripts/`. Geographic data generators belong to `SingleSparkBackend/scripts/geo/`. Contract integration tools that start the API or read frontend ABI bindings explicitly require the complete SingleSpark workspace; Solidity and Rust builds do not.

## Environments

Business contracts have one source under `chains/`. Production policy delays remain **48 hours**. The isolated ARC Claim and Pons gameplay testnet builds substitute **10 minutes in compiler inputs**, without changing production Solidity. Existing deployments keep their recorded delay.

| Environment | Network | Configuration and evidence |
| --- | --- | --- |
| Mainnet | ARC `5042` / Argus | `deployments/mainnet/arc/`; production launches still require reviewed pins |
| Testnet | ARC `5042002` / Argus and SingleSpark | `deployments/testnet/arc/` |
| Testnet | Robinhood `46630` / Pons | `deployments/testnet/robinhood/pons/` |
| Reference only | Robinhood mainnet `4663` | `deployments/mainnet/robinhood/pons/reference.json`; execution disabled |
| Local | Loopback Anvil forks | `deployments/local/`; never evidence of public-chain execution |

Directory names do not enable a network. RPC identity, configuration, source pins, wallet roles, budgets and explicit broadcast gates remain enforced. ARC profiles are selected by chain ID and checked against their environment. Pons deployment tools reject mainnet.

Private environment files, wallets, frozen builds and signed journals retain their original ignored paths under `arc/data/`, `arc/.env.*`, `.data/` and the operator's configured data directory. They are not public deployment records. Do not move or delete them to retry transactions.

Sanitized environment templates are in [ARC production](deployments/mainnet/arc/argus/.env.example) and [ARC testnet](deployments/testnet/arc/argus/.env.example). Production tools require an explicit owner-only `--env` file. Testnet RPC overrides can be loaded with Node's `--env-file`; the independent deployment still enforces chain `5042002` and dedicated wallet roles.

## Verification

From this repository:

```sh
npm run check:architecture
npm run test:tools
forge test --root arc
forge test --root evm
npm run test:pons:vault
cargo test --manifest-path solana/Cargo.toml --workspace --locked
node --test solana/tests/client.test.mjs
```

The existing npm Pons commands keep their names. Direct Node tools now use the paths under `scripts/`; deployment and acceptance commands can spend funds and are not part of structural checks.

## Guides

- [ARC vault custody, allocation and rollout](docs/arc/vaults.md)
- [ARC isolated Claim testnet build](docs/arc/argus-testnet.md)
- [Robinhood / Pons testnet deployment](docs/robinhood/pons.md)
- [Shared EVM gameplay protocol](docs/evm/protocol.md)
- [Solana programs](solana/README.md) and [business flow](docs/solana/business-flow.md)
- [Deployment records](deployments/README.md)
- [Platform model](docs/platform.md)
