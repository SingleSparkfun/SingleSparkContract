# ARC / Argus project vaults

The platform-token issuance plan selected Robinhood/Pons on 2026-10-11. References to the platform token here describe existing ARC deployment or test bindings, not new ARC issuance. Existing contracts, funds and signed recovery journals retain their original bindings.

Scope: new ARC/Argus projects. Solana PDAs and EVM contracts keep their own chain implementations under the same product custody and permission standard.

## Latest allocation design (2026-10-10, deployed on ARC Testnet)

The required flow is: Argus creator rewards → project Vault → isolated plugin budgets allocated by weight; the user pays Gas to call Vault Claim → the Vault checks authorization, pause state and budget → a registered plugin contract executes its gameplay → successful execution settles the reward. Allocation is internal accounting within each project Vault, not a transfer into an unisolated shared plugin fund. Plugin weights and executable contract registration are separate: changing a weight cannot authorize arbitrary external execution or withdrawals.

Vault weights and each plugin's internal spending proportions are independent settings. The latest requested allocation reserves 10% for platform fees and 0.5% for Claim execution rewards, then distributes 89.5% by enabled plugin weights. Three plugins weighted 1:1:1 each receive one third of that remainder and apply their own internal policy. Placement of the 3.5% community share between these layers remains unresolved; do not silently deduct it or charge platform fees and Claim again inside plugins.

Disabling a plugin reallocates only new income among the remaining enabled plugins. If all plugins are disabled, funds remain unallocated in the Vault. Existing plugin budgets are never redistributed retrospectively. Emergency pause stops execution without changing weights. Income collection and fixed-fee settlement must not depend on plugin toggles.

Three independent plugin contracts use restricted callbacks against the current task's budget. Buyback assets go to the dead address; distribution rewards are paid only after inventory reaches recipients. Weight changes and plugin replacements require a timelock. Production sources retain a 48-hour delay; the isolated Claim test build replaces it with 10 minutes only in compiler inputs. Public deployment and transaction evidence: [Claim acceptance](../../deployments/testnet/arc/argus/argus-public-testnet-claim.json). Application release status: [test release report](../../../SingleSparkBackend/deployments/argus-claim-testnet-release.json). V1/V2 percentages below describe historical deployments; old balances and journals were not migrated.

This independent deployment uses factory `0xe5326c9586a12C6EE15273EA59d2c905416605fE` and platform source project TSPARK3 `0xA70b060578389CDd4FdE184C06A0D8e2173bbb21`. Public-chain verification covers actual trade creator fees, 1:1:1 weights, user-paid buybacks and execution rewards, distribution to 100 synthetic test addresses, replay rejection and collection/unallocated accounting with all plugins disabled. The buyback target changed to TSPARK3 after an actual 10-minute wait; all three projects retained their Vault addresses, balances and budgets. `platformTargetSwitch` records the evidence. The new controller's 10-minute queue and the old controller's 48-hour queue are independent.

Online application acceptance: frontend r2 and backend r3. The Claim list, test-wallet login, preparation and user-paid `sync` transaction succeeded; transaction `0x64767572559270121b0c360433cbf68ea1c21316ddbab5d25107cb634079b77c`. That regression passed 1,332 frontend tests, 292 backend tests (2 ignored), 47 native tests, the frontend build and architecture checks. Public RPC quotas can delay indexing and preparation; Keeper safely defers work when indexing is stale. The new platform project did not reach its automatic execution threshold, so funded automatic work was not reverified. Browser wallet popup signing was not tested; these results do not establish mainnet readiness.

Local acceptance record: `deployments/local/arc/argus/argus-weighted-local-verification.json`. It records 1,316 frontend, 290 backend (2 ignored), 47 native and 228 ARC contract tests passing, plus architecture checks and the frontend build. A local fork at a pinned testnet block verified independent plugins, user Claim, buybacks to dead, 100-recipient distribution, collection/unallocated funds with all plugins disabled, activation after 600 seconds, rejection one second early and journal reruns without duplicate transactions. Anvil uses an explicit mock ERC20 for USDC; this does not replace public ARC native USDC/Gas or browser-wallet end-to-end acceptance.

## Execution responsibilities (2026-10-10)

- Platform-token project: identified by its verified source token contract; automatic Keeper pays Gas and maintains its plugins.
- Ordinary projects: users review Claim tasks and costs, sign and pay Gas. Only successful eligible contract work earns execution rewards. Rewards belong to the actual executor, separately from token-distribution recipients.
- An ordinary project's platform-token buyback plugin still runs through that project's Claim, with new budget allocated by weight. Classification follows the source project, not the purchased token.
- The backend continues indexing, quoting, preparing bounded authorizations and reconciling receipts. It creates no new automatic Keeper tasks for ordinary projects. Mode changes preserve signed recovery, old EOA bindings and accounting.

The current backend restricts new automatic execution to the platform source project and preserves all signed recovery. `buy` / `distribute` still require `controller.executor()`. ARC Claim uses bounded authorization and receipt validation for ordinary projects; old public Vaults do not gain Claim automatically. Browser-wallet acceptance follows the separate fields in the application release report.

New execution rewards use the 0.5% Claim budget reserved when income arrives. Legacy 83/7/5/4/1 Vaults retain their accounting without reallocating old funds. Authorization binds the chain, Vault, task, executor, spending, minimum output, deadline and nonce. Removing `onlyExecutor` would permit user-selected trade parameters and distribution lists and is not an acceptable adaptation.

## Historical V1/V2 implementation

User wallet → ArgusVaultFactory → project ArgusRevenueVault → Argus Portal. Portal sees the Vault as `msg.sender`, so TokenCreated.creator, Splitter.creator and the creator-fee recipient are the project Vault. Users pay launch Gas without creating a project private key or prefunding Vault Gas. Keeper uses the original global executor wallet for plugin Gas.

Each project has an independent BeaconProxy, balance, budgets, nonce, reward inventory and paid-recipient records, sharing the ArgusRevenueVault implementation and existing ArgusCustodyRouter. Incoming USDC6 defaults to 83% own-token burn, 7% platform-token burn, 5% distribution purchases, 4% community and 1% platform. Rounding remains in the platform share under the legacy rules. Disabling a plugin stops its spending without reallocating budgets. Policy changes affect subsequently booked income and book prior income first. Donations can fund budgets, but API creatorFeesTotal counts only actual Splitter payout events.

Vaults expose no arbitrary transfer, arbitrary call or administrator withdrawal. Buybacks retain router price guards, approve only the current amount and clear approval afterward. Purchases enforce bucket balance, minimum output, a 30-second deadline and nonce. Distribution spends purchased inventory only, pays 10 tokens per address to at least 100 addresses per batch and permanently rejects duplicate payouts. Platform/community allocations go only to fixed router recipients. Without governance, the 4% community share remains in the Vault without a new withdrawal permission.

ArgusVaultFactory is also the non-upgradeable beacon/controller. Admin and executor must differ; executor has only bounded plugin execution and pause permissions. Either may immediately pause one or all Vaults. Admin-scheduled policy, resume and upgrade operations wait a fixed 172800 seconds; anyone may execute a ready operation. Only one operation may be pending. A new pause invalidates old operations; admin must cancel and reschedule. Global pause covers future Vaults too. V2 upgrades bind the new code hash and layoutVersion=2; V1 factories accept only layoutVersion=1 and preserve proxy state. Administrators must still review storage compatibility; a version number is not a layout proof.

Frontend and backend pin factory and implementation runtime code hashes. Until upgraded code is reviewed and configuration updated, Keeper neither signs nor replays the new code path, and the frontend blocks creation. The on-chain 48-hour upgrade authority belongs to admin, preferably an independent multisig; this is a real trust boundary, not an assertion that upgrades are impossible. Executor identity is currently immutable. Rotation needs a separately designed delayed mechanism, not an environment-variable replacement.

## Compatibility and deployment

Legacy EOA splitters have no creator setter. The new factory migrates neither their future fees nor existing balances or platform tokens. Original custody/keys, budgets and frozen transaction journals remain. New EOA drafts at `/api/arc/argus/launch` are rejected; an existing requestId can still be queried, retried and completed. Existing HTTP routes, database tables and private environment names remain compatible. Added fields include revenueVault, pluginPolicy, vaultBudgets and vaultIncome.

Deploy the two new contracts, configure the backend, then release the frontend. Do not replace the router, platform token, historical start block or data directory. Set all three pins together:

- ARC_ARGUS_VAULT_FACTORY
- ARC_ARGUS_VAULT_FACTORY_CODE_HASH
- ARC_ARGUS_VAULT_IMPLEMENTATION_CODE_HASH

Without verified pins, new launches are disabled while historical reads and recovery continue. Do not relabel an old recipient EOA as a new Vault in configuration.

Build: `forge build --root SingleSparkContract/arc`.

Review a deployment plan: `node SingleSparkContract/scripts/arc/launchpads/argus/production/deploy-argus-vault.mjs --env /absolute/private.env`. The default neither signs nor broadcasts. The owner-readable configuration contains ARC_CHAIN_ID=5042, ARC_RPC_URL, ARC_DEPLOYER_PRIVATE_KEY, ARC_ARGUS_ROUTER_ADDRESS, ARC_ARGUS_ROUTER_CODE_HASH, ARC_ARGUS_CUSTODY_ADDRESS (executor), ARC_ARGUS_VAULT_ADMIN, ARC_DEPLOY_GAS_BUDGET_USDC (at most 1) and ARC_DATA_DIR. Add `--broadcast` only after verifying addresses and Gas limits. The script persists raw signatures before broadcasting, verifies receipt finality and emits three deployment pins. Retry with the same journal and configuration; never delete the journal or invent another salt. Do not use the deployer wallet concurrently for other transactions.

Administrator entrypoints on a verified factory, signed by a controlled wallet/multisig: pause(vault,mask), schedulePolicy(vault,plugins,weights), executePolicy(...), scheduleResume(mask), executeResume(mask), scheduleUpgrade(implementation), executeUpgrade(implementation), cancel(). V2 masks: 1 own-token buyback/burn, 2 distribution, 4 platform-token buyback/burn, 7 all. V1 mask 1 still controls both buybacks and must not be decoded as V2. A zero vault address means global scope. Local resumption uses delayed policy; global resumption uses delayed resume. Review complete parameters and pending/readyAt offline before executing.

## Verification

- `forge test --root SingleSparkContract/arc`: project isolation, budgets/nonces, distribution deduplication, pause, delays, upgrade state and fixed recipients.
- `npm run check:architecture`, `npm run test:app`, frontend build, `npm run test:runtime`, `npm run test:native`.
- After starting the local database and building the Rust binary: `node SingleSparkContract/scripts/arc/launchpads/argus/local/verify-argus-fork.mjs --vaults`. This uses a real Argus/V4 fork and a separate local schema to verify deployment retry, Vault creator identity, absence of project private keys, indexing, Keeper execution, 100-recipient distribution and restart recovery. Results: `deployments/local/arc/argus/argus-vault-local.json`.
- Anvil cannot reproduce the ARC native USDC precompile or address restrictions. Tests explicitly substitute the ERC20 quote asset and synthetic Gas. They do not constitute mainnet transactions, native mainnet USDC verification or an independent audit.

Before launch, configure actual deployment pins, verify admin, platform-token and payout addresses, and complete authorized small-value mainnet acceptance. Passing code and local tests does not mean deployment is complete.

## Independent public testnet deployment

`scripts/arc/launchpads/argus/testnet/` contains ARC/Argus deployment and acceptance tools restricted to authorized ARC Testnet 5042002. It uses Sourcify-verified mainnet V7 Portal, LaunchToken7, HookedLocker and HookedSplitter7 sources pinned by source/compiler-setting hashes in `scripts/arc/launchpads/argus/testnet/sources.json`, recompiling to verify creation bytecode. The GitHub example Portal has a different interface and cannot replace current V7.

This instance reuses the repository's verified testnet Uniswap V4 PoolManager/PositionManager and the real native USDC ERC20 interface. Only USDC quoting is enabled; `UsdcOnly` reverts other quote assets and conversions without simulating trades or fees. Upstream V7 sources remain unchanged. Local compiler inputs only change the SingleSpark Router/Vault Factory chain restriction to 5042002 and bind the Router Portal constant to the independent predicted address. Production sources, mainnet entrypoints and existing test-site configuration remain unchanged.

Deployment, admin and executor use three dedicated accounts in `arc/data/argus-public-testnet/wallets.json` (0600 permissions, Git-ignored). Projects still have contract Vaults without project private keys. Preserve and back up signed journals; do not delete them to retry or use these accounts concurrently or with mainnet funds.

`TSPARK` is an independent platform-buyback test asset, launched by the global executor to satisfy existing Router constructor compatibility. It is not a migration of platform income. `TVLT1` / `TVLT2` verify new project Vault creation and creator-fee receipt.

Run from the workspace root:

```sh
node SingleSparkContract/scripts/arc/launchpads/argus/testnet/build.mjs
node SingleSparkContract/scripts/arc/launchpads/argus/testnet/rehearse.mjs
node SingleSparkContract/scripts/arc/launchpads/argus/testnet/deploy.mjs
node SingleSparkContract/scripts/arc/launchpads/argus/testnet/deploy.mjs --broadcast
node SingleSparkContract/scripts/arc/launchpads/argus/testnet/verify.mjs --broadcast
```

`build` uses local solc 0.8.24 and 0.8.26 (overridable with `SOLC_0_8_24` / `SOLC_0_8_26`), saving sources and standard inputs in the data directory. `rehearse` uses an independent Anvil fork to verify constructors, runtime code, actual Portal launches and journal recovery without public broadcasts. `deploy` defaults to a read-only plan. Public broadcasting verifies RPC chainId, budget, nonce, signed content, runtime code and finalized blocks. The test budget is capped at 10 test USDC, conservatively including maximum committed Gas, inter-account Gas transfers, a fixed 0.5 USDC trade and a marked 0.5 USDC donation. Each transaction is capped at 0.5 Gas cost.

Acceptance creates two separate Vaults and checks actual trade fees, 83/7/5/4/1 budgets, native/ERC20 USDC consistency, both burn types, inventory purchase, 100 explicitly synthetic recipients, permanent deduplication, permission rejection, fixed platform payout and per-project pause. Without governance, the 4% community share remains in the Vault. The 48-hour policy queue and early-execution rejection are checked, then cancelled; this does not claim execution after an actual 48-hour wait. Public acceptance covers contracts; backend Keeper and browser release need separate verification.

Public addresses, successful receipts, source provenance and acceptance results are in `deployments/testnet/arc/argus/argus-public-testnet.json`. Status becomes `passed` only after actual on-chain acceptance.

## V2 three plugins and platform-token switching

V2 has three independently enabled plugins. New frontend projects default to platform-token buyback (7%); creators select own-token buyback (83%) and distribution (5%). Disabled buckets retain their funds; community 4% and operations 1% remain. V1 selections and signed transactions retain original semantics and cannot reuse V2 masks in place.

The shared Factory stores the platform target. `schedulePlatformToken(next)` binds target code, the registered Argus pool and controller revision; `executePlatformToken(next)` activates after 48 hours. Project Vaults, tokens and balances remain unchanged. V2 `buyPlatform(expectedToken,...)` binds quotes to the target; transactions for the old target fail after switching rather than silently buying another token. The target appears in token fund details at `pluginPolicy.platformToken`.

In this historical V2 stage, the backend creates automatic Keeper work only for the verified platform source project and prioritizes signed recovery. Ordinary-project public Claim authorization, executor rewards and menu were still pending, and their funding source had not been determined; this stage must not be described as supporting them or changing allocation percentages.

On 2026-10-10, online and local test data resets and use of the independent Argus Portal were authorized. V2 compiler output, signed journals and reports use the separate `argus-public-testnet-v2` directory, preserving V1 journals. Entrypoints: `scripts/arc/launchpads/argus/testnet/build.mjs --v2`, `scripts/arc/launchpads/argus/testnet/deploy-v2.mjs --broadcast`, `scripts/arc/launchpads/argus/testnet/verify.mjs --v2 --broadcast`. Verified Portal/Router are reused. New platform/test projects launch through the new Factory with Vault creator/splitter recipients. Switching the platform buyback target requires the actual 48-hour wait recorded by readyAt; local time travel is not a public-network wait.

Explore: New sorts by launch time. Argus Hook `bonded()` latches when the price target is first reached and displays Bonding/Bonded independently of sorting. It is not liquidity migration; do not display a fabricated graduation time or transaction.

## Additional backend automatic-execution acceptance (2026-10-10)

`scripts/arc/launchpads/argus/testnet/verify-keeper.mjs --broadcast` uses fixed recoverable journal labels to fund the TSPARK2 Vault with 6.1 test USDC and the dedicated executor with 1 test USDC for Gas. This funding is not creator fees. The script signs funding only, leaving plugin execution to the backend. Without `--broadcast`, it only reconciles on-chain results.

Online Keeper automatically completed `sync` and an own-token buyback/burn spending 5.063 USDC. Checks covered executor identity, successful receipts, finality, minimum output, actual burn and cleared approvals. Both database operations remained `applied` after restart; ordinary projects had no automatic work. Evidence: `deployments/testnet/arc/argus/argus-keeper-public-testnet.json`. This verifies the buyback path, not automatic distribution or public Claim.

`scripts/arc/launchpads/argus/testnet/rehearse-platform-target.mjs` used a local fork of current public state to verify rejection one second early, successful execution after expiry, replay rejection and unchanged project tokens/Vaults/balances/budgets. The public chain received only an early read-only simulation. Its actual target remains pending until 2026-10-12 12:56:12 Beijing time, followed by `scripts/arc/launchpads/argus/testnet/finalize-v2.mjs --broadcast`. Fork evidence: `deployments/local/arc/argus/argus-platform-target-rehearsal.json`; it is not a completed public switch.

Direct `buy` simulation from an ordinary wallet still fails. In this legacy path, bounded Claim authorization and a separate 48-hour upgrade require an agreed execution reward funding source. The factory allows only one pending operation, so it cannot queue that upgrade alongside the scheduled platform-target switch.
