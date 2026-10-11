# Solana business-flow rules and remaining work

> 2026-10-09: new projects use **per-project PDA vaults, a shared revenue program and a non-upgradeable 48-hour timelock controller**. This document describes the current architecture and explicitly identifies unfinished product work. Deployment and ABI details follow the [README](../../chains/solana/README.md).

Scope: Solana / Pump and PumpSwap revenue, Claim plugins and platform-token DAO. Each mint/config has an independent PDA vault and ledger. Buyback, burn and distribution share the revenue program; no per-Meme plugin deployment is required. Global pause covers old and new vaults under the same revenue configuration, with funds and budgets always isolated. DAO is separately deployed and does not share revenue vaults.

The EVM product model uses contract vaults, but historical Argus/Clanker adapters retain custody-wallet revenue paths and project treasuries receive only their allocated shares. This is not a completed migration of all revenue to vaults. Chains sign, validate and recover independently without pooled funds or automatic bridging.

Users voluntarily pay execution costs, including account-creation rent. The backend holds registration/policy authorization keys but cannot directly sign as a PDA or arbitrarily withdraw vault assets; only the deriving revenue program can produce PDA signatures. New plugins, weight changes, resumption and upgrades require 48 hours. Initial registration choices and emergency pause take effect immediately. Historical test Memes are not migrated; old transactions recover under their original bindings.

The existing Claim page has per-transaction review, automatic income accounting and recovery. Conservative upfront cost budgets, invalid-recipient skipping and administrative wallet withdrawals have been added. Budgets use current quotes and per-transaction fee caps; unquotable future inventory costs remain unknown without profit guarantees. Atomic combined Claim and separate public DAO settlement remain future work.

## Existing Claim page and remaining scope

Reuse `/claim` and `front/features/claim/` to show available projects and estimated rewards so users can decide whether execution is worth its costs. Integrate accounting and preparation here without another Claim page or platform subsidy.

| Page section | Available now | Clarification still needed |
| --- | --- | --- |
| Claimable project list | Search, pagination, PDA vault address, potential rewards and Claim action | Potential reward is a pool estimate, not this execution's payable reward; a nonzero pool does not prove net profit |
| Pre-signing transaction review | Estimated reward, fees and net amount, with backend profitability checks on rewarded work | Reuse review and show prior paid collection/inventory steps and overall costs upfront |
| Execution progress | Per-transaction confirmation, pause, resume, stop and recovery | Explain accounting and failure causes; re-estimate changed conditions without labeling one completed step as full completion |
| Results | Received rewards, actual fees/rent, actual net amount and history | Use finalized success/failure receipts and include paid preparation costs |

Without a connected wallet or valid quote, potential reward pools may be shown but not guaranteed net earnings. After selecting a project, users review steps, potential rewards and a conservative cost budget before continuing. Pool minus budget is a comparison, not guaranteed profit; future inventory costs without quotes stay unknown. The overall estimate is read-only, not advance signing of transactions dependent on future state. Each transaction is reviewed again against execution-time state.

## Participants and fund ownership

| Participant/account | Responsibility and ownership |
| --- | --- |
| Platform | Register projects, validate markets and recipients, co-sign bounded policies; no PDA private key or user execution subsidy |
| Project PDA vault | Receive creator revenue and voluntary deposits, hold SOL, authorize WSOL and inventory accounts; signed only by the revenue program |
| On-chain project account | Separately record cumulative allocated income, budgets, reward pool, spending, burns, distributions and local policy |
| Shared revenue program/configuration | Share buyback/distribution instructions and configuration-level pause gates without aggregating project balances |
| Claim executor | Review estimates, voluntarily sign/pay costs and receive rewards for successfully completed eligible work |
| Distribution recipient | Receive 10 project tokens when selected and valid, once per round; unsupported recipients are skipped and may be selected in later rounds |
| Project reserve recipient | Withdraw only the reserve share fixed at registration |
| Platform operations recipient | Withdraw only the operations share actually assigned by configuration |
| DAO voters/team | Receive principal, rewards or team shares under voting rules, separately from project Claim rewards |

Creator fees are not gross trading volume. Pump collects by creator address; other tokens assigning the same vault as creator may send revenue to the same address. Current `received` means income allocated by the vault, not verified per-token provenance of every fee.

## Revenue collection and automatic accounting

Before every successful Claim or withdrawal, the revenue program books available SOL/WSOL above existing reserved budgets, excluding rent. Income includes fees collected by SingleSpark, externally collected fees and voluntary deposits. It does not trust a backend cumulative-income amount or require a separate bookkeeping instruction.

1. Validate project, PDA, configuration, market, budget and sequence; actual assets must cover existing budgets.
2. Sync lamports directly transferred to WSOL accounts and unwrap under program rules. User-funded account creation is separate from income; `sponsorRent=0`.
3. Allocate only available balance above reserved budgets using current weights. Re-execution cannot allocate the same balance twice.
4. Failed execution rolls back accounting and business transfers; users still pay network fees according to chain results.
5. Delayed weight changes settle prior increases under old weights before updating future allocation. Existing budgets, inventory and history are never redistributed.

Balance accounting does not prove fee provenance. Backend receipt history supports display and reconciliation without authorizing arbitrary bookkeeping or withdrawals. Below-threshold funds wait for later work. Changing a vault address does not migrate historical balances or transactions.

## Allocation and pending budgets

The frontend must show each project's actual bound configuration rather than hardcode 1% platform operations. Percentages below precede integer rounding. Actual lamport calculations assign rounding remainder to own-token buyback under existing rules.

| Project type and bountySource | Own-token buyback | Platform-token buyback | Distribution | Project reserve | Platform operations | Claim pool |
| --- | --- | --- | --- | --- | --- | --- |
| Meme, 0 | 83% | 7% | 5% | 4% | 0% | 1% |
| Platform token, 0 | 94% | 0% | 5% | 0% | 0% | 1% |
| Meme, 1 | 82.17% | 6.93% | 4.95% | 3.96% | 0.99% | 1% |
| Platform token, 1 | 93.06% | 0% | 4.95% | 0% | 0.99% | 1% |

`bountySource=1` first reserves 1% income for Claim and distributes the remaining 99%. Every successful accounting operation uses the same integer allocation function. Batch-dependent remainders cannot go to executors or operations.

Pausing or disabling a plugin retains its budget without sending it to other plugins, the project or platform. Initial choices activate at confirmed registration; later toggles, weights and resumption are queued by the timelock administrator for 48 hours. The configuration authority may immediately pause one project or all projects under that configuration. Either local or global pause blocks corresponding execution. New emergency pauses invalidate old resume plans. New plugin implementations require delayed program upgrades, not arbitrary uploaded executable plugins.

SOL below minimum trade size and insufficient distribution inventory wait for accumulation. Waiting is neither completed work nor withdrawable funds.

## User-paid costs and Claim rewards

Evaluate eligibility against the transaction about to be signed:

```text
Estimated net amount = currently payable Claim reward
                     - network and priority fees
                     - user-funded account-creation rent
                     - other explicitly user-paid execution costs
```

Only simulation meeting the configured minimum net amount may be labeled profitable Claim. Pool balances, uncollected fees and round estimates are funding information, not this user's current earnings. Rewarded steps already have pre-signing simulation and profitability checks. Lists still use potential rewards/budgets for readiness; preparation steps and total cost budgets are now shown upfront, while each review determines the actually payable reward.

| Operation | Current immediate reward | Required user flow |
| --- | --- | --- |
| Collect fees with automatic accounting | None | Prefer combining with rewarded work atomically; standalone execution is voluntary paid preparation |
| Buy and burn own/platform token | Settled after successful burn | Simulate complete costs and minimum net amount, then reward successful execution |
| Buy distribution inventory | None | Account jointly with distribution when atomic composition is feasible; otherwise voluntary paid preparation |
| Distribute inventory | Settled after successful transfers | Include necessary account-creation costs in this execution's net amount |
| Reserve/operations withdrawal | None | Separate withdrawal entrypoint with recipient-paid fees |

Atomic composition places related steps in one chain transaction, reverting all business changes if any fails. Offer it only when account limits, transaction size, compute, balance and price constraints permit successful simulation. Never omit validation or steps merely to compress a transaction. The current stepwise SDK does not implement these cross-step combinations.

When composition is impossible, per-transaction review explicitly shows preparation, fees and zero immediate reward. The existing page already explains that collection and inventory purchases have no immediate rewards, includes those costs in upfront budgets and requires explicit acceptance of preparation risk before review. Users may decline preparation while projects wait for other volunteers; execution is not guaranteed for every project.

Preparation does not reserve future rewards. Whoever successfully completes the later burn or distribution earns them. A user paying preparation costs may receive no later reward; show this before signing. Guaranteeing preparation cost recovery would require a separate reward-ownership change, not an implicit promise.

Recalculate before every signature; independent transactions do not guarantee overall profit. Completed steps are not rolled back if later work stops. Failed on-chain business transfers revert, but users still pay network fees. Simulation is not a profit guarantee.

## Plugin execution and distribution failures

Own/platform-token buybacks retain isolated budgets, official markets and target bindings, spending caps, minimum output and deadlines. Burn accounting and rewards occur only after purchase and burn succeed atomically. Unacceptable market prices wait; do not relax limits to empty budgets.

Each distribution round has **at most 100 distinct recipients**, 10 tokens each, with 1–4 recipients per transaction. Filling all 100 is unnecessary. Inventory sufficient for one recipient can start a round; inventory and eligible candidates determine its list. Eligibility remains SOL or official Solana USDC holdings. The backend persists candidates; contracts validate actual transfers, budgets, within-batch deduplication and sequence.

1. Before preparation, read finalized recipient wallets/token accounts. Skip addresses definitely incompatible with existing contract validation, persisting address, reason and time without replacements.
2. RPC timeout, incomplete responses, price changes and insufficient rewards/balances do not invalidate recipients. If the executor appears in the batch, record `executor_address` and skip that position to preserve contract role isolation.
3. Until the original transaction is definitively failed or expired, project in-flight restrictions prohibit new preparation or skipping, preventing late duplicate payouts.
4. Paid count increases only from finalized successful receipts using actual batch size. Skips do not increase it. Retries remove skipped addresses and continue unpaid positions.
5. The round ends when paid plus skipped count reaches list length, possibly below 100. If all remaining recipients are unsupported, record terminal `skipped` without sending or charging a transaction.
6. Inventory and unused budgets remain. Later rounds may select historical recipients again. Public records show actual counts, skipped counts and confirmed signatures without exposing recipient lists.

## Reserve withdrawal and asset coverage

The `/traffic` Withdrawals menu connects a Solana wallet, queries its project budgets and reuses existing program withdrawal instructions. Project reserves pay only the registration-pinned recipient; operations pay only current configuration authority. Recipients initiate, sign and pay network fees. The platform validates/co-signs a bounded policy; the revenue program transfers through PDA signatures. APIs reject substituted recipients and amounts exceeding that bucket.

Withdrawals and Claim share per-project in-flight restrictions, sequence and recovery. Only finalized success marks completion. Duplicate requests or timeout retries cannot debit twice. Configurations without operations shares show zero rather than taking operations fees from Claim rewards.

Before execution, actual assets must cover unspent SOL budgets, rewards and undistributed inventory. Deficits pause affected operations while preserving accounting. Do not conceal deficits by altering income or budgets. Restore coverage before continuing.

Revenue may involve WSOL. The program syncs/unwraps it, while preparation still accounts for native SOL, rent and complete costs without treating user account creation as income.

## DAO settlement and personal claims

Existing economics remain: lock 30% of original supply; release 0.1% per period against the chosen base; if participation meets threshold and Satisfied wins, 90% goes to the team and 10% to winning voters. If Not satisfied wins, burn 90%. A tie or insufficient participation returns the release to the lock. Voter principal always follows original ownership rules.

Current code uses 24-hour windows from initialization. Opening late does not restart a full 24 hours, and missed dates do not accumulate releases. Show actual on-chain deadlines and remaining time. A 600-second build is for isolated testing only.

Current settlement depends on a usable team recipient account and may block voter principal returns. The proposed supplement separates public settlement from personal team claims:

| Stage | Completion and fund changes |
| --- | --- |
| Round settlement | After expiry, determine outcome and shares, burn or relock as needed, independently of team/voter recipient accounts |
| Team claim | Only a Satisfied win creates a fixed team entitlement, separately claimable to a valid account of the fixed identity without duplication |
| Voter claim | After settlement, claim principal and eligible rewards individually; one invalid account affects only its own claim |
| Next round | Open within its time window after prior settlement, without waiting for every team/voter claim |

Unclaimed shares remain reserved for their original round and cannot fund later rounds, other team withdrawals or other voters. Winning rewards remain weighted, with the last winning claimant receiving rounding remainder. Personal claim failures cannot reverse the result or affect others' principal.

This requires governance-instruction, entitlement-state and compatibility design; moving one account check does not complete it. Existing immutable programs do not change when new code ships. Historical locks/rounds must retain their original settlement, query and withdrawal entrypoints.

## Recovery and user-visible states

States must explain the next required action instead of labeling every problem retry later.

| State | Next action |
| --- | --- |
| Unbooked vault increase | Next successful execution allocates the available increase; unverified deposits are not labeled trading fees |
| Plugin paused | Distinguish project/global pause, retain budgets and require a 48-hour resume timelock |
| Waiting for budget/inventory | Wait for income without displaying completed buyback/distribution |
| Waiting for eligible addresses | Retain inventory, rounds and paid records while gathering candidates |
| Costs exceed rewards | Show both and pause profitable Claim; zero-reward preparation still requires voluntary acceptance |
| Profitable Claim | Current simulation meets the configured net threshold; show complete signing content |
| Awaiting signature/confirmation | Keep transaction content fixed; users may pause later steps while signed work is reconciled first |
| Definitive failure/expiry | Show paid fees or no execution result, reread chain state and then prepare again |
| Insufficient asset coverage | Pause affected operations while the platform investigates and restores coverage |
| Batch/round complete | Update amounts and progress from finalized successful receipts, distinguishing partial from full completion |

Preserve persist-before-broadcast for signed transactions. Network errors or missing receipts are not proof of failure; do not immediately pay again with a replacement transaction. Withdrawals, skips and combined Claims must share recovery rules.

## Implementation scope and acceptance

Classification: accounting, buyback and distribution belong to Claim / Solana / Pump; signing and recovery belong to shared Solana execution; DAO belongs to Solana governance. Cross-chain pages compose these capabilities without changing public availability or authorizing other networks/launchpads.

| Location | Current implementation and remaining work |
| --- | --- |
| `src/revenue.rs`, client and revenue entrypoint | PDA automatic accounting, project/global pause and delayed policy exist; continue validating recipient boundaries, conservation and replay protection |
| Backend Pump receipt index and Solana task records | Preserve provenance display, original recovery and historical isolation; receipt indexing does not replace on-chain balance accounting |
| Backend Claim plans and existing Claim page | Clarify list/current rewards, prerequisites, total estimates and feasible atomic composition; reuse cost review, profitability checks and signing |
| Backend distribution rounds | Persist skipping reasons and old-transaction terminal constraints; advance by actual paid count |
| Backend/frontend withdrawals | Integrated into administration statistics; fixed-recipient authorization, budget queries, signing and recovery reuse journals |
| Governance contracts, client and DAO UI | Separate public settlement/team claims, reserve entitlements and preserve old-round compatibility |
| Launch/details/history pages | Display actual configured allocation, separating budgets, potential rewards, actual spending and actual earnings |

Update callers, exported client copies, tests, deployment documentation and old/new compatibility entrypoints together. Future team-claim instructions belong only in governance, not in the revenue program or reverse cross-program calls.

Current architecture and proposed supplements require separate acceptance. Combined Claim and DAO separation remain unfinished. Skipping, cost budgets and withdrawals require these checks:

1. After external collection of 0.1 SOL, the next successful execution automatically books it and proceeds with buyback/distribution without duplicate accounting on rerun.
2. SOL/WSOL, voluntary deposits and external collection use actual available increases; rent/user-funded creation stay separate. Failure rollback and weight changes conserve budgets.
3. Historical income is not counted again in new projects; old transactions recover against saved program/configuration.
4. Zero-reward work is not labeled profitable, and costs above rewards do not induce automatic paid execution. Voluntary preparation clearly shows rewards belong to the successful executor.
5. Atomic-step failure reverts all business state. Independent steps display their risks and record actual network costs.
6. Distribution of at most 100 resumes correctly across executors, restarts and batch-N failures. Supported accounts receive funds; only unpaid unsupported positions skip, rounds may end below 100, and unresolved old transactions prevent skipping.
7. Non-fixed recipients cannot withdraw, repeats cannot pay twice and withdrawals cannot spend other budgets. Deficits prevent further spending.
8. Satisfied, Not satisfied, ties and insufficient participation settle. Invalid team recipients do not block settlement or voter principal returns. Team/principal/reward claims pay only once.
9. Coexisting old/new programs retain old DAO query, settlement and claims. A new test program cannot be enabled as a production-period program.
10. Launch percentages, chain configuration, project budgets and final receipts agree; retained disabled-plugin budgets and waiting conditions are visible.

After tests, full acceptance still requires the actual target network, production builds and official Pump/PumpSwap. Under user-paid execution, low-reward projects may legitimately wait indefinitely for volunteers. Continuous execution is not guaranteed.
