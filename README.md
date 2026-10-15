# SingleSpark contracts

On-chain contracts for project vaults, revenue plugins, token launches and NFTs. Project funds and plugin budgets are accounted for separately.

## Repository structure

| Directory | Contents |
| --- | --- |
| [`chains/arc/`](chains/arc/) | ARC contracts and launchpad integrations |
| [`chains/evm/`](chains/evm/) | Shared EVM gameplay, revenue and governance contracts |
| [`chains/robinhood/`](chains/robinhood/) | Pons integration and platform NFT contracts |
| [`chains/solana/`](chains/solana/) | Rust programs, shared accounts and JavaScript client |
| [`chains/bsc/`](chains/bsc/) | Launchpad interface definitions |
| [`scripts/`](scripts/) | Build, deployment and verification tools |

Tests, build profiles and deployment records live alongside their owning chain.

## Contracts

| Module | Main contracts / programs | Responsibility |
| --- | --- | --- |
| [ARC / Argus](chains/arc/launchpads/argus/) | `ArgusCustodyRouter`, `ArgusVaultFactory`, `ArgusRevenueVault`, `BuybackBurnPlugin`, `PlatformBuybackPlugin`, `TokenDistributionPlugin`, `ArgusGovernance` | Launch integration, project vaults, revenue allocation and governance binding |
| [ARC / SingleSpark](chains/arc/launchpads/singlespark/) | `ArcLaunch`, `ArcLaunchV2`, `ArcLaunchStrategy`, `ArcRewards` | Token launch, launch strategy and rewards |
| [EVM revenue Hooks](chains/evm/hooks/) | `HookVaultFactory`, `HookVault`, `BuybackHook`, `DistributionHook`, `V4SwapAdapter` | Isolated vaults and bounded plugin execution |
| [EVM revenue](chains/evm/revenue/) | `NativeRevenueDistributor` | Revenue distribution |
| [EVM governance](chains/evm/governance/) | `ArcProjectTreasury`, `ArcProjectTreasuryDeployer`, `ArcSatisfaction`, `ArcDrandVerifier` | Treasury, voting and randomness verification |
| [EVM execution](chains/evm/execution/) | `ArcKeeperExecutor` | Authorized execution of bounded operations |
| [Robinhood / Pons](chains/robinhood/launchpads/pons/) | `PonsVaultFactory`, `PonsHookVault`, `PonsSwapAdapter` | Project creation, revenue custody and gameplay execution |
| [Robinhood NFTs](chains/robinhood/platform/) | `PlatformNft*`, `PlatformRandomNft*` | NFT issuance, staking and income accounting |
| [Solana](chains/solana/) | Revenue, DAO and timelock programs | PDA vaults, revenue operations, governance and delayed administration |

Source code describes the implementation; network deployment records identify deployed versions. Updating this repository does not upgrade existing contracts or migrate funds.

### Hook naming compatibility

Shared EVM revenue implementations live in `chains/evm/hooks/`: `HookVaultFactory`, `HookVault`, `BuybackHook`, `DistributionHook` and `V4SwapAdapter`. Pons owns `PonsVaultFactory`, `PonsHookVault` and `PonsSwapAdapter`. Hooks execute only through the project Vault’s authorized Claim callbacks; this name does not turn them into Uniswap pool callbacks.

The external ABI and executable bytecode remain unchanged by this source rename. Existing EIP-712 `GameplayClaim` / `SingleSpark Gameplay` wire names, signed journals, deployment evidence and documented `build-gameplay.mjs` / `verify-gameplay.mjs` entrypoints retain compatibility. `verify-hooks.mjs --deployment-id hooks-redeploy-20261015` checks the fresh Robinhood Testnet deployment's runtime, roles, registry and finalized receipts without signing or broadcasting transactions. Production policy remains 48 hours; the isolated testnet build remains 10 minutes.

For a fresh Hook deployment, build with a new `--deployment-id`, provide its reviewed `<deployment-id>-roles.json`, then run `deploy-revenue-fix.mjs --deployment-id <id> --deploy-hooks --wallet <owner-only-testnet-wallet>` for preflight and add `--broadcast` to deploy. This replaces the factory, its Vault implementation, adapter and both Hook implementations without issuing another platform token. Resume the same journal after the 10-minute registry delay, wait for finality, and only then derive matching frontend/backend pins with `revenueFixPins` and run `verify-hooks.mjs`. Historical factories, implementation/adapter/Hook code pins and signed journals remain bound to their original deployments.

The [2026-10-15 fresh Hook deployment](chains/robinhood/deployments/testnet/pons/hooks-redeploy-20261015.json) records five new contract addresses, 12 finalized deployment/registry transactions and a successful read-only launch simulation. Explorer source verification covers the factory, adapter and both Hooks; the internally created Vault implementation is runtime-verified on-chain but is not yet indexed as a contract by the explorer.
