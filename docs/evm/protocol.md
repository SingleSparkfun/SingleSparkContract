# SingleSpark EVM gameplay protocol

This delivery covers protocol contracts, Solidity interfaces and local verification. The on-chain entrypoint is `GameplayVaultFactory`; it does not include web/API integration, public deployment or authorization of new networks. Existing Argus factories, Vaults, EOA recipients, splitters and signed recovery journals remain unchanged. Solana is outside this delivery.

## Contracts and asset model

Sources live in `chains/evm/gameplay/`; shared code has no launchpad dependency.

| Contract | Responsibility |
| --- | --- |
| `GameplayVaultFactory` | Create and register project Vaults, register plugins and swap adapters, enforce fixed 48-hour delays and pause controls |
| `GameplayVault` | One funding asset for one project, with separate balance, plugin budgets, inventory, Claim rewards and permanent payout deduplication |
| `IGameplayProtocol.sol` | Factory, Vault, plugin and swap-adapter interfaces, policy and Claim structures |
| `GameplayBuybackPlugin` | Acquire the policy target asset and send it to `0xdead`; separate plugin IDs reuse code with isolated own/platform-token budgets |
| `GameplayDistributionPlugin` | Acquire inventory and distribute a fixed amount per recipient; inventory purchases do not immediately pay execution rewards |
| `GameplayV4Adapter` | Exact-input swaps through one initialized V4 pool of a pinned PoolManager, with direct native-currency settlement |

`projectToken` identifies the project's ERC20; `asset` is the funding asset; plugin `targetAsset` is the acquired or distributed asset. These are separate roles. Funding and target assets may be equal, in which case spending requires no swap.

- `asset == address(0)`: native currency, funded through `deposit{value: amount}(amount)` or a direct transfer and spent natively. No WETH contract is required.
- `asset != address(0)`: the specified ERC20, funded through approved `deposit(amount)` or direct ERC20 transfers. SafeERC20 handles USDT-style transfers without return values.
- A Vault's project token, funding asset, registrant and factory are fixed after initialization. There is no asset-switch or arbitrary withdrawal entrypoint.
- Amounts use each asset's smallest units, without assuming 6 or 18 decimals or treating values as dollars. The protocol does not require optional `decimals()` metadata; callers must configure and display amounts correctly.
- Other tokens acquired by plugins are plugin inventory, not additional funding assets. Direct transfers of an unspecified ERC20 earn no budget and have no generic recovery entrypoint.
- ERC20 deposits and spending require exact amounts; transfer-tax, reflection and rebase assets are unsupported. Taxed active deposits revert atomically, but the Vault cannot prevent direct transfers. Accounting stops if balances fall below the ledger.
- Stock tokens must permit transfers through the Vault, trading route and recipients. Deposit support does not imply buyback, `0xdead` transfers or unrestricted distribution support. A rejected transfer reverts the entire gameplay operation without skipping recipients.
- Chains where native and ERC20 representations share a balance, such as ARC native USDC, must use one accounting entrypoint. They cannot be treated as separate assets or configured to swap between themselves. Each chain deployment must verify its native-asset behavior.

`0xdead` is an inaccessible recipient; a transfer there does not guarantee a reduction in token `totalSupply`. Stock tokens are not automatically cancelled off-chain either.

## Registering new and existing projects

```solidity
address vault = factory.createVault(projectToken, asset, policies);
address recorded = factory.vaultOf(registrant, projectToken);
address predicted = factory.predictVault(registrant, projectToken);
```

`projectToken` must already be a deployed contract. New and historical tokens use the same entrypoint. The factory neither reissues tokens, changes ownership nor migrates existing funds. Applications must also validate ERC20 behavior; a contract address alone proves no compatibility.

ERC20 has no standard project-owner interface. Registration is scoped by `(chainId, factory, registrant, projectToken)`, allowing one Vault per registrant/token pair. Others may create their own independent Vault for the same token; this does not establish official authorization, and the UI must not display registrants as verified issuers. This avoids excluding the original team through front-running registration.

The factory CREATE2-clones a fixed Vault implementation, creating, registering and initializing it atomically. `VaultCreated` identifies the registrant, original token and funding asset. The implementation and factory are non-upgradeable; gameplay evolves through delayed plugin registration and policies.

Historical revenue requires voluntary funding by its recipient or an original protocol's supported collection mechanism. Creating a Vault cannot change an immutable historical Argus Splitter creator. Binding new creator revenue directly to a Vault still needs a launchpad-specific integration; a predicted address alone cannot establish that binding.

## Funding, allocation and inventory

`deposit(amount)` books funds after a successful transfer. Anyone may call `sync()` after a direct transfer. Balance increases are booked once; pause does not prevent deposits or fixed platform-fee settlement.

New income reserves 10% platform fees and 0.5% Claim rewards, distributing 89.5% by relative enabled-plugin weights. No additional community fee is deducted. Calculations round down in smallest units; the last enabled plugin receives the allocation remainder, accounting for every unit.

- `weight == 0`, or omission of an existing plugin from the policy list: no new income or execution for that plugin. Its existing budget remains and does not move to other plugins.
- All disabled: plugin income stays `unallocated`; re-enabling a policy allocates funds not previously assigned to a plugin.
- Emergency pause only stops execution; economic weights remain.
- Policy updates book existing income under the old policy first. `maxSpend` caps funding-asset spending per plugin Claim, independently of allocation weights.
- Budgets stay inside the Vault; plugins do not hold pooled project funds. Swap adapters settle atomically, returning output directly to the current Vault.
- Distribution inventory is isolated by plugin. A plugin with inventory cannot change target asset. `sync()` does not count inventory as new income.
- Permanent `paid(recipient)` records persist within each Vault across plugins, policies and target assets. Disabling, re-enabling or replacing plugin code cannot clear them. Other projects have separate records and funds.
- `settlePlatform()` pays only the factory's fixed `treasury`; callers cannot choose a recipient.

## Policy and plugin interfaces

`GameplayPolicy` fields:

| Field | Meaning |
| --- | --- |
| `id` | Registered plugin ID and permanent isolated-budget identifier |
| `weight` | Relative weight for new income; 0 disables the plugin |
| `targetAsset` | Gameplay output asset; 0 means native currency |
| `adapter` | Registered swap adapter; 0 when no swap is required |
| `maxSpend` | Per-execution cap in funding-asset smallest units |
| `route` | On-chain trading route; Claim callers cannot replace it |
| `rules` | Plugin-internal rules, independent of allocation weights |

A project may register at most 16 plugin IDs over its lifetime. Omitting an existing plugin does not delete its budget or inventory.

Plugins implement `validate(projectToken, asset, policy)` and `execute(data)`. The factory activates only explicitly registered code hashes; Vaults validate rules during policy setup and each execution. Plugins operate through restricted `pluginAcquire`, `pluginBurn`, `pluginStore` and `pluginDistribute` callbacks. They cannot choose arbitrary external calls, transfer arbitrary Vault funds or spend another plugin's budget.

The built-in buyback plugin requires empty `rules` and execution `data`. The distribution plugin uses `rules = abi.encode(amountPerRecipientRaw, minimumBatch)` with batches of 1–200 recipients. Empty `data` acquires inventory; `data = abi.encode(recipients)` distributes it. Recipients must be strictly ascending and never previously paid by that project. Configure `amountPerRecipientRaw` in target-asset smallest units: 10 units of a 6-decimal asset is `10_000_000`.

Plugin registration does not grant unlimited execution. New gameplay may use only existing restricted callbacks. New asset-operation primitives require a reviewed protocol version, not an arbitrary-call bypass.

## Claim and permissions

Users call Vault `claim(request, data, signature)` and pay native Gas on that chain. Signatures use EIP-712:

- Domain: `name = "SingleSpark Gameplay"`, `version = "1"`, current `chainId`, `verifyingContract = vault`.
- Primary type: `GameplayClaim(address caller,bytes32 pluginId,uint256 amount,uint256 minimumOutput,uint256 reward,uint256 deadline,uint256 nonce,uint256 policyRevision,uint256 registryRevision,bytes32 dataHash)`.
- `dataHash = keccak256(data)`; the signer is the factory's fixed `authorizer`.
- `caller` must match the actual caller; validity cannot exceed 300 seconds from the current time. Nonce, Vault policy revision and factory registry revision must match exactly.
- Output asset, adapter and route come from on-chain policy. The signature binds amount and `minimumOutput`. Callers cannot change recipients, route or reward and reuse it.

Eligible buyback rewards are capped at `spent * 50 / 8950` and the unreserved Claim budget. Acquiring distribution inventory only reserves its reward; successful distribution releases it proportionally to delivered inventory. Failed execution pays no reward, and failures or excessive rewards revert atomically. Rewards use the Vault funding asset; they need not cover Gas or be native currency.

Factory `admin` and online `authorizer` must differ. The online role may authorize bounded Claims and immediately pause, but cannot register plugins, change policy, resume or select arbitrary withdrawals. The signing service must verify business eligibility and quotes. Contracts enforce signature bindings, on-chain policy, spending caps, actual delivery and permanent deduplication.

| Operation | Permission and activation |
| --- | --- |
| Initial/replacement plugin `schedulePlugin` → `executePlugin` | Admin queues; fixed 48-hour wait; anyone may execute a ready operation |
| Adapter `scheduleAdapter` → `executeAdapter` | Admin queues with the same 48-hour wait |
| `schedulePolicy` → `executePolicy` | Project registrant or admin queues with a 48-hour wait |
| `pauseVault(vault, id)` | Registrant, admin or authorizer acts immediately; id=0 pauses the entire Vault |
| `pause()` | Admin or authorizer immediately pauses globally |
| Local/global resumption | Authorized queue with a fixed 48-hour wait |
| `cancel(operation)` | Admin cancels a pending operation |

New pauses invalidate relevant previously queued policy/resume operations. Plugin or adapter registry changes invalidate old Claim revisions. Plugins and adapters must use reviewed fixed-code deployments, not proxies that silently bypass code-hash and timelock checks at the same address. Code-hash checks do not replace review.

The shared protocol adds no automatic Keeper or signing service. The separate Robinhood/Pons test integration includes bounded Claim authorization; it does not change the existing ARC platform source's maximum one automatic operation per 180 seconds. Future clients must preserve signed recovery journals, nonces and receipt checks without enabling automatic execution for other projects. New protocol authorizer/treasury identities are immutable; redeployment is not fund migration.

## Native currency and Uniswap v4

`GameplayV4Adapter` pins its factory and PoolManager in the constructor. The route is `abi.encode(PoolKey, uint160 sqrtPriceLimitX96)`. A zero price limit uses the protocol boundary for that direction; signed `minimumOutput` still constrains acceptable output.

Only registered Vaults of that factory may call the adapter. It checks input/output assets against an initialized pool. Native currency settles through payable PoolManager `settle`; ERC20 uses `sync`, transfer and `settle`. Output goes directly to the caller Vault through `take`. Only complete exact-input swaps are accepted; partial fills, insufficient output, forged callbacks and mismatched received amounts revert. ERC20 approvals clear after calls.

The protocol therefore does not require conversion to WETH. Platforms restricted to wrapped assets need separately implemented and verified platform adapters without changing Vault funding-asset identity. The shared delivery includes a single-pool V4 adapter. Robinhood/Pons has a separately pinned native ETH curve→V4 adapter; see `../robinhood/pons/README.md`. Other DEXs, pools needing extra hookData and launchpad fee collection need their own integrations. V4 deployments require its EVM features, including transient storage.

## Local verification and artifacts

Run from the workspace root:

```sh
npm run test:evm-gameplay
npm run build:evm-gameplay
npm run check:architecture
```

Standalone equivalents are `forge test --root chains/evm` and `forge build --root chains/evm --sizes`. Builds use only existing `chains/arc/lib` dependencies in this repository, without neighboring-project tools or contracts. ABI, bytecode and metadata go to ignored `chains/evm/out/<Source.sol>/<Contract>.json`.

Tests cover native/ERC20 funding, no-return ERC20, varying decimals, restricted stock-token behavior, historical-token registration, isolated budgets, delayed policy/code registration, replay/cross-chain/cross-Vault rejection, atomic distribution, permanent cross-plugin deduplication and real Uniswap v4 bidirectional native swaps deployed in a local EVM. Real V4 means actual protocol contract code, not public-network or funded transactions.

The shared protocol has no independent third-party audit. Robinhood/Pons public test deployment and application acceptance are recorded separately in `../robinhood/pons/README.md` and do not authorize other networks. Public network/platform availability remains subject to workspace deployment policy.
