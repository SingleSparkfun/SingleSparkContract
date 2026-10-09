# SingleSpark Solana programs

Separate native Rust / SBF programs for token-locked governance and SOL-paired Pump/PumpSwap revenue plugins. No mainnet program ID or deployment is configured.

## Deployment boundaries

New deployments use three separate artifacts: `singlespark_revenue.so`, `singlespark_dao.so`, and `singlespark_timelock.so`. Revenue accepts tags 0–10; DAO accepts configuration tag 0 and governance tags 16–20. DAO code and accounts retain their existing rules. The combined `singlespark_solana.so` entrypoint is retained for regression tests, not for new production deployments.

The revenue program remains upgradeable, but its loader upgrade authority must be the controller PDA derived by `timelockAddress(timelock, revenueProgram)`. The controller itself **must be immutable** before it can adopt revenue. There is no immediate upgrade, shortened delay, arbitrary CPI, administrator rotation or upgrade-authority escape instruction in the controller. An upgrade approved after 48 hours can still change the revenue rules; this is a delayed administrator trust model, not immutable financial policy.

This is a new revenue account version (tag **7**), with a global plugin gate (tag **8**). Old private-key Hook projects and their signed transactions are not compatible with this revenue binary. Use a fresh revenue program/configuration; existing test launches are not migrated. Changing a program ID does not move funds. Do not overwrite an existing combined deployment with either split artifact or claim its old accounts have been migrated. DAO pins and its old withdrawal/settlement access remain independent.

The backend keeps `SOLANA_PROGRAM_ID`, `SOLANA_PROGRAM_CONFIG`, `SOLANA_PROGRAM_PLATFORM_MINT` and adds `SOLANA_TIMELOCK_PROGRAM_ID`. `SOLANA_DAO_PROGRAM_ID` / `SOLANA_DAO_CONFIG` remain an optional separate pair. Registration and Claim strategy approval use the config authority's key in `SOLANA_PROGRAM_AUTHORITY_FILE`; the timelock administrator can be a different offline key and must not be confused with that online signer. Startup pins are verified against finalized account owners, PDA derivations and loader authorities before new Pump creation or Claim preparation.

## Source and client

| File | Responsibility |
| --- | --- |
| `src/revenue.rs` | PDA custody, guarded Pump CPIs, plugin controls, income accounting and Claim settlement |
| `programs/timelock/src/lib.rs` | Immutable 48-hour queue for upgrades, project policy changes and global resumes |
| `src/loader.rs` | Loader-v3 Program / ProgramData authority validation |
| `src/governance.rs` | 30% token lock, daily rounds, staked votes, team/burn settlement, voter withdrawals |
| `src/state.rs` | Account layouts and checked integer accounting |
| `src/accounts.rs` | PDA, owner, signer, mint/extension checks and SPL transfers/burns |
| `src/configuration.rs` | Immutable configuration initialization in each program's own namespace |
| `client.mjs` | Instruction builders, account decoders, PDA derivation and v0 transaction construction |
| `tests/local.mjs` | Compiled SBF tests in an isolated local validator |

This is a native Borsh ABI, not an Anchor program. Instruction tags and layouts are defined by the Rust argument structs and matching client builders. All money arguments in JavaScript are `bigint` or canonical integer strings. Token amounts use 6 decimals; SOL amounts use lamports.

## PDA revenue vaults

**One shared revenue program, separate project vaults.** The buyback and distribution plugins are built-in instructions of the deployment's revenue program, not separately deployed contracts for each token. Each mint/config pair gets its own vault and ledger. The global plugin gate belongs to that config; sharing code or a gate never pools project balances. DAO is an independent program with its own vaults. EVM vault contracts are a separate runtime model and do not share Solana accounts or signatures.

`vaultAddress(program, config, mint)` derives a system-owned PDA from `['hook-vault', config, mint]`. There is no vault private key or address application process. SOL sits at this address; token accounts, including WSOL and distribution inventory, use it as their authority. Only the revenue program can give it signer privileges with `invoke_signed`. `projectAddress(program, vault)` stores the ledger separately.

Registration requires the config authority, checks the actual Pump curve creator against the derived vault, records a fixed reserve recipient, verifies the immutable timelock controller and the revenue loader authority, and funds only the vault's rent shortfall. It creates/reuses `pluginGateAddress(program, config)`. The backend reserves only a mint secret; the retained 64-byte encrypted database payload has a zero sentinel in its old Hook-secret half. Existing encryption AAD, mint signing and transaction journals remain in use.

A new launch's initial selection of the implemented plugins takes effect when registration confirms, with **no 48-hour wait**. Subsequent additions/changes/resumption take the delay. A globally paused plugin remains paused for a newly registered vault too.

Before each successful Claim/withdrawal, the program reconciles available native SOL and WSOL with outstanding budgets. Surplus includes externally collected fees and voluntary deposits; it is **not proof of fee provenance**. Account rent is excluded. Direct WSOL lamport deposits are synchronized and unwrapped inside the program; the persistent WSOL ATA is recreated with its rent retained. User-funded ATA/volume-account setup stays outside revenue accounting. A failed operation rolls back reconciliation too; the same surplus can be reconciled on the next successful call without double credit.

The immutable `bountySource` still explicitly selects the initial allocation:

| Value | Initial allocation |
| --- | --- |
| `0` | Meme: 83% own buyback, 7% platform buyback, 5% distributions, 4% reserve, 1% Claim rewards. Platform coin: 94% own buyback, 5% distributions, 1% Claim rewards. |
| `1` | Reserve 1% for Claim rewards, then split the remaining 99% by 83/7/5/4/1 (Meme) or 94/0/5/0/1 (platform coin), including platform operations. |

Weights are five integer basis-point values: own buyback, platform buyback, distribution, reserve, operations. All-zero stored weights select the initial rule. Explicit weights must total 9,900 for source 0 or 10,000 for source 1; source 1 applies them to the post-reward 99%. Platform coins cannot allocate platform-buyback or reserve buckets. Rounding stays in own buyback. Policy execution first books existing surplus using **old** weights, then changes weights for subsequent receipts. Previously allocated balances, reward inventory and payout history are never redistributed by a plugin change.

Every Claim needs the user's fee-payer signature and config authority's strategy signature (one signature if they are the same wallet). The strategy signer cannot transfer vault assets directly. The program binds the canonical Pump/PumpSwap market, target mint, source/destination accounts, expected nonce, spending bucket, maximum debit, minimum tokens/reward and a deadline within 60 on-chain seconds. Only supported official buy/collect, WSOL funding and sync CPIs are permitted. Arbitrary plugin program calls are not exposed. Price-window checks and selection of up to 100 eligible distribution recipients remain backend responsibilities.

Collection and inventory purchases pay no immediate bounty. Buyback rewards settle only after burning the bought tokens; distribution rewards settle only after successful transfer (10 tokens each, up to four recipients per instruction). Tag 6 has no permanent recipient receipt. Tag 4 retains the receipt-style payout shape for regression coverage on **new PDA projects**, not compatibility with old wallet-signed transactions. Batch duplicate checks, nonce replay protection, rollback and existing Token-2022 restrictions remain.

The user pays network fees and any ATA / Pump volume-account rent. `sponsorRent` must be zero: user funding cannot be mistaken for vault income. Simulation checks the complete user cost and existing profitability thresholds; separate preparation transactions have no guaranteed future reward. Reserve/operations withdrawals need the fixed recipient and strategy authority signatures, pay only that bucket, and give no Claim reward.

## Plugin administration and global emergency stop

| Action | Signer / delay | Effect |
| --- | --- | --- |
| `pausePlugins({authority, config, hook, mask})` | Config authority, immediate | Pause one project's selected plugins; preserve budgets/history |
| `pauseAllPlugins({authority, config, mask})` | Config authority, immediate | Pause selected plugins for **all current and future vaults under that config**, in one transaction |
| `schedulePlugins({admin, config, buffer: project, change})` | Timelock administrator; wait 48h | Add/enable the built-in plugins, change weights, remove via flags, or resume local pauses |
| `scheduleGlobalResume({admin, config, mask})` | Timelock administrator; wait 48h | Clear selected global pause bits |
| `scheduleUpgrade({admin, buffer})` | Timelock administrator; wait 48h | Upgrade revenue with the exact queued ELF |
| `cancelScheduled(...)` | Timelock administrator, immediate | Cancel pending action; close a frozen upgrade buffer back to the fixed administrator |
| `executeScheduled(...)` | Any transaction fee payer after maturity | Execute the immutable queued action; cannot substitute parameters or refund recipient |
| `decodeState` / `decodeTimelock` | Read-only | Inspect project flags/weights, gate, revisions, queued action, digest and on-chain execution time |

Every builder above also takes `program`; timelock builders take `timelock`. Masks are **1 = buyback** (own + platform), **2 = distribution** (inventory + payout), **3 = both**. Effective pause is local OR global; a project update cannot override a global stop. Collection and fixed reserve withdrawals remain available. “Emergency removal” is a pause/tombstone, never deletion of the funded state. Resuming it takes the delay. A genuinely new plugin implementation requires a delayed code upgrade.

Project and gate policy revisions make a queued policy/resume stale after a new emergency pause. It must be canceled and queued again for a fresh 48-hour wait. Global pause does not iterate or mutate individual vault balances. It gates subsequent on-chain executions, including previously signed transactions that have not executed; it cannot undo a finalized transaction. Multiple platform configs have separate gates.

The controller has **one pending action per revenue program**. Inspect it before proposing; complete or cancel it before another action. This intentionally small queue means project updates are sequential. Upgrade proposal creation atomically transfers the loader buffer authority to the controller PDA and hashes its ELF bytes. Both authority and hash are checked again at execution; the admin cannot edit the buffer during the wait. The delay is a fixed `172800` seconds in immutable controller code, not an API timer or editable environment setting.

Example SDK calls (construct instructions; send them through the operator's reviewed wallet flow):

```js
import * as sdk from './client.mjs';
const gateAddress = sdk.pluginGateAddress(program, config);
const pauseAllBuybacks = sdk.pauseAllPlugins({ program, config, authority, mask: 1 });
const resumeAllBuybacks = sdk.scheduleGlobalResume({ program, timelock, admin, config, mask: 1 });
const gate = sdk.decodeState(await connection.getAccountInfo(gateAddress), program, 8);
const queue = sdk.decodeTimelock(
  await connection.getAccountInfo(sdk.timelockAddress(timelock, program)), timelock, program);
// After maturity; for global resume queue.buffer is gateAddress.
const executeResume = sdk.executeScheduled({ program, timelock, admin, config, buffer: queue.buffer });
// For a project-policy execution also pass that project's hook (vault address).
// For code upgrades omit config and hook; pass the frozen buffer address.
```

## Governance

The configured platform token must be an initialized, unfreezable Pump coin with revoked mint authority. Initialization transfers **30% of the curve's original token supply** from the funding wallet into the DAO PDA's token account. It does not mint tokens. Buy the funding allocation on Pump before initializing, or include purchase and initialization in an atomic transaction. Historical proof that the funding wallet itself bought every deposited token is not part of this program.

Required immutable initialization parameters:

- `team`: fixed team recipient.
- `releaseBasis`: `0` for the initial locked amount, `1` for remaining locked tokens.
- `quorum`: minimum raw stake, in token base units.
- `weightCapSeconds`: explicit time-weight cap, 1–86,400 seconds.

Rounds last 24 hours. Opening a round moves 0.1% of the selected release basis from the lock into that round's vault, capped by remaining funds, with a one-base-unit minimum for the final dust. Missed days do not unlock a backlog. A previous open round must settle before another opens.

The explicitly opt-in Cargo feature `devnet-ten-minute-rounds` builds 600-second rounds with a maximum 600-second vote weight cap. Default builds remain 86,400 seconds. Build the test artifact into a separate `--sbf-out-dir target/deploy-devnet-10m`, deploy it only to a separate Devnet program, and initialize a fresh DAO with `weightCapSeconds: 600`. Existing round deadlines are stored on chain and are not rewritten by changing a compile-time constant. Do not upgrade an existing 24-hour DAO with this test artifact or use it on mainnet. The account layouts and instruction ABI remain unchanged.

Vote weight is `stake × min(seconds until round end, weightCapSeconds)`. Additional stake keeps the same side and is weighted at its own deposit time. Stake cannot leave before settlement. Quorum requires both the configured raw stake and total weight of at least `quorum × weightCapSeconds / 2`.

- Satisfied wins: 90% of the release goes to the fixed team ATA, 10% to the winning voters.
- Not satisfied wins: the program burns 90%; 10% goes to the winning voters.
- Tie or insufficient quorum: the release returns to the lock; all voters can recover their stake.

Voters withdraw their principal and any winning reward exactly once. Winning rewards are proportional to weight; the final winning withdrawal receives rounding dust. DAO and round vaults are PDA-controlled; there is no administrative principal-withdrawal instruction. Unsolicited token deposits do not block initialization or rounds and are not counted as locked funds or rewards. The deployment's upgrade authority remains a separate trust decision.

## Build, provision and verify

Use Rust, Node dependencies and Solana platform-tools v1.57 or newer with SBF-v3 support. From the workspace root:

```sh
npm run test:sol-contracts
npm run build:sol-contracts:split
npm run test:sol-contracts:split
npm run check:architecture
```

`build:split` builds the workspace, including the controller and the clearly named test-only `singlespark_pump_fixture.so`, into `target/deploy-split/`. Never deploy the fixture to a public network. Standalone `npm run test:split` here runs without backend dependencies; the workspace command additionally loads the backend runtime explicitly. `test:sol-contracts:local` uses the combined entrypoint from that same build directory.

Provision **fresh** revenue and controller program IDs; verify the exact artifacts. Finalize the controller's upgrade authority with the Solana loader, then call `initializeTimelock({program, timelock, admin})` signed by the revenue program's current upgrade authority. This transfers that authority directly to the controller PDA, with no intermediate unlocked period. The initializer rejects a mutable controller. The administrator cannot be rotated through this implementation; keep that key available and private. Verify both ProgramData authorities and the lock state before enabling any public launch.

Derive the platform mint's vault before its Pump creation and set it as the curve creator. Bootstrap platform creation using the SDK, initialize revenue config with explicit bounty policy/minimum/maximum, then register its project. Normal backend launch requires this initialized config and the registration signer. Independently purchase/fund the DAO's 30% allocation and initialize DAO using its unchanged rules. No automatic funding, deployment, authority revocation or migration is performed by source changes.

For a later code upgrade, upload the reviewed ELF into a loader buffer controlled by the timelock administrator, then call `scheduleUpgrade`. Publish the buffer digest and execution time for review. Execute after maturity with `executeScheduled`, or cancel. Do not use direct `solana program deploy` to bypass the controller after adoption; the loader authority is no longer a wallet.

The local SBF suite verifies real PDA signer privileges, System/ATA/SPL/Token-2022 transfers and burns, budget conservation, nonce rollback, 100-recipient payouts, independent DAO operations, global/local pauses, new-vault inheritance, stale-resume rejection, old-income allocation, frozen upgrade buffers, hash tampering, cancellation and actual delayed upgrade execution. It reloads isolated genesis snapshots with expired timestamps to test the passage of time; deployed programs contain no test-clock bypass. Pump liquidity is an explicit fixture, so this does not replace official Pump/PumpSwap network acceptance or an external security audit.

The fixture distributes 0.001 SOL of Claim rewards but intentionally incurs higher user costs creating recipient ATAs (`minReward=0` for transfer coverage). Actual costs are written to `claim-result.json` in the temporary validator directory. Production Claim retains its per-transaction profitability guard; the test is not evidence of a profitable multi-step strategy.

After changing `client.mjs`, run `npm run export:backend` here. Workspace architecture checks byte-compare that standalone ABI copy. Frontend/api routes, database schema, encrypted mint custody, network pins and signed recovery journals remain stable. There is no new administrative browser UI; the validated SDK builders above are the operator interface.

[BUSINESS_FLOW.md](BUSINESS_FLOW.md) records other business-flow work and its remaining gaps. It uses the same PDA/shared-program model and separates implemented accounting from outstanding distribution replacement, combined Claim profitability and DAO settlement work.

The pinned existing Solana JS dependency family reports the `bigint-buffer` buffer-overflow advisory and `jayson` / `stream-json` / `uuid` advisories; npm's proposed fixes require incompatible major changes or a downgrade of SPL Token. They have not been automatically applied. This Node SDK dependency risk does not affect the separately built Rust SBF artifact.

Protocol references: [Solana PDAs](https://solana.com/docs/core/pda), [cross-program invocation](https://solana.com/docs/core/cpi), [program deployment](https://solana.com/docs/programs/deploying), [Pump fee collection](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md).
