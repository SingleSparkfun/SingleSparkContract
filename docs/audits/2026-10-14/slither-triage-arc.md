# ARC Slither High / Medium triage

Input: `/tmp/singlespark-audit-skills/slither-arc.json`, `success=true`, 163 raw results (High 21, Medium 60, Low 59, Informational 23). This triage covers all 81 raw High/Medium entries by detector category, retaining duplicate path-alias entries in the raw counts. Of these, 52 entries concern Argus/shared governance in the assigned scope and 29 concern SingleSpark launch contracts delegated to the parent auditor. Aliases such as `evm/governance/ArcSatisfaction.sol` and `../../../../Users/nat/.../chains/evm/governance/ArcSatisfaction.sol` refer to the same canonical source and are not independent vulnerabilities.

No additional confirmed exploitable High/Medium issue was established in the assigned Argus/shared-governance scope from these detector results. The separately proven conditional governance-proposal spam issue and documented Low plugin-rounding observation remain in `findings-argus.md`; Slither did not identify those directly. Static warnings are not passed-off as vulnerability counts.

All canonical source paths below are relative to `SingleSparkContract/`.

| Detector | Raw count | Assigned scope | SingleSpark / parent scope | Assigned-scope disposition |
|---|---:|---:|---:|---|
| arbitrary-send-erc20 | 1 | 1 | 0 | Fixed authorized source and destination; not arbitrary theft |
| arbitrary-send-eth | 4 | 4 | 0 | Two canonical intended payout/funding helpers, duplicated aliases |
| reentrancy-balance | 8 | 7 | 1 | Intentional before/after balance assertions under outer locks and task authorization |
| reentrancy-eth | 8 | 6 | 2 | Three canonical Satisfaction paths, duplicated aliases; outer locks |
| reentrancy-no-eth | 7 | 4 | 3 | Task callback/state machine plus outer locks |
| divide-before-multiply | 3 | 3 | 0 | Exact quotient/remainder identity or intentional USDC6 quantization |
| incorrect-equality | 7 | 1 | 6 | Zero-income early return, not fragile balance equality |
| locked-ether | 5 | 4 | 1 | ARC native USDC/ERC20 representation; router payable entry always reverts |
| uninitialized-local | 9 | 7 | 2 | Solidity-defined zero initialization, no uninitialized storage pointer |
| unused-return | 29 | 15 | 14 | Selected tuple fields, observed balance accounting and V4 settlement invariants |
| **Total** | **81** | **52** | **29** | |

## Guard/evidence details

### arbitrary-send-erc20 (High; one raw result)

`chains/arc/launchpads/argus/ArgusCustodyRouter.sol:97-101`, `fundPlatformBuybackUsdc6`: source is immutable `operations`; destination is immutable `custody`. Line 98 requires `msg.sender == operations` and nonzero amount. It cannot take tokens from an arbitrary user or change the recipient. `ArgusSatisfaction._fundBuyback` approves exactly the requested amount, calls this route, then resets approval (`ArgusGovernance.sol:34-37`). Disposition: false positive for arbitrary-send exploit, intentional bounded fixed-recipient funding.

### arbitrary-send-eth (High; four raw / two canonical results)

`chains/evm/governance/ArcSatisfaction.sol:284`, `_fundBuyback`: only called from private `_settle` for the fixed computed 10% team share on a Rejected settled round. Factory is configured once by its recorded administrator with reciprocal operations/platform checks (`:118-135`); the public caller cannot choose this target or amount. Argus overrides the method with the fixed ERC20 route (`ArgusGovernance.sol:34-37`).

`ArcSatisfaction.sol:285-288`, `_pay`: internal virtual helper reached through `withdraw` and `claimTeam`. Withdraw pays only `positions[round][msg.sender]`, validates the destination, marks `withdrawn=true` and reduces `reserved` before `_pay` (`:188-206`). `claimTeam` sets fixed `teamCredit` to zero and pays fixed `team` (`:210-216`). Public sponsorship of `claimTeam` does not choose a payout recipient. Failed native calls revert. Argus override pays USDC6. Disposition: intended authorized payouts, no arbitrary third-party balance drain shown.

### reentrancy-balance (High; seven assigned-scope raw results)

`ArgusRevenueVault.sol:258-291`, `_buy`: five results cover the three legacy route variants and before-quote / before-token balances. Every entry into `_buy` is through external `buy`, `buyPlatform` or `claim`, all `nonReentrant` (`:246-257`, `:388`). `_enabled` consumes the task nonce before executing; `_debit` reduces bucket/accounted balances before router calls. Before/after assertions intentionally verify exact quote consumption and token receipt. Router is the controller's immutable router; router swap methods also have `nonReentrant` and a verified fixed Portal/PoolManager route.

`ArgusRevenueVault.sol:344-359`, `pluginSwap`: two results concern before-quote and before-target balances. Callback requires the active registered plugin at phase 0 (`:340-346`), sets phase 1 before external trade and debits only the active task's bucket. The only production path establishing `activeTask` is private `_executePlugin` called beneath the same outer locked entries. Unrelated token/router callers cannot impersonate the active plugin. Repeating `pluginSwap` fails the phase check; executing other Vault money entrypoints fails the outer lock. Other allowed plugin callbacks must satisfy task kind and exact output. Fixed reviewed plugin code is selected by a delayed registration and checked by code hash. Existing callback/incomplete-plugin rollback tests and scoped Claim tests support this disposition. No stale-balance exploit confirmed for the pinned assets/routes. Deliberately malicious replacement plugin plus malicious token/router callbacks is a separate delayed-admin trust assumption, not a proven unprivileged exploit.

### reentrancy-eth (High; six assigned-scope raw / three canonical results)

`ArcSatisfaction.vote`, `_open`, `withdraw` (`:158`, `:265`, `:188`) are each reported twice due aliases. External `vote`, `openVoting`, `settle`, `withdraw`, `claimTeam` are all `nonReentrant` (`:145`, `:158`, `:180`, `:188`, `:210`). `_open` is private, reached only from the locked vote/openVoting routes; `_settle` marks the round settled before optional buyback funding (`:238-260`). Factory callbacks cannot call another vote/withdraw/settle to double-spend. Remaining unguarded `configure` is administrator-only and one-shot, and getters do not mutate money state. Read-only getters exposing in-flight state are not used as a security decision by another scoped contract. Argus overrides native funding/payment with fixed USDC6 transfers. Disposition: no confirmed mutating or demonstrated read-only reentrancy exploit.

### reentrancy-no-eth (Medium; four assigned-scope results)

- `pluginSwap` (`ArgusRevenueVault.sol:344-359`): authorized callback within the locked task; guard described above.
- `_executePlugin` (`:325-339`): establishes one active task, checks plugin kind/code hash, requires phase 2 completion, then deletes task. Registered plugin callbacks are intentional; external money entrypoints remain locked. Incomplete work reverts the entire transaction.
- `claim` (`:388-412`): has `nonReentrant` at the public boundary, verifies EIP-712 authorization and nonce, then checks reward against the returned successful-work limit and current Claim budget. Reward bookkeeping happens before transferring quote.
- `_distributeInventory` (`:302-318`): although `totalPaid` increments after router distribution, every route into it is covered by the outer Vault lock / active task phase, and the router itself is locked. Permanent recipient flags and inventory/reward debit happen before the router call. No permissionless callback can distribute twice using the transient old total.

Disposition: detector does not model the parent lock and intentionally permitted callback state machine; no confirmed exploit.

### divide-before-multiply (Medium; three results)

- `ArgusRevenueVault._sync`, line 196: `(income / 10000) * w + (income % 10000) * w / 10000` equals `floor(income*w/10000)` exactly for integer weights. The quotient/remainder split intentionally avoids full-width multiplication overflow. This is legacy fixed-allocation accounting; latest weighted math uses `Math.mulDiv` with fractional carry. No missing precision from this expression.
- `ArgusSatisfaction.payoutOf`, `ArgusGovernance.sol:29`: `/1e12*1e12` intentionally quantizes the inherited native18 payout to a whole USDC6 base unit before reducing reserved state and paying. Any sub-USDC6 fraction stays reserved; this is documented dust behavior, not an accidental 12-decimal loss in a USDC6 transfer.
- `ArgusSatisfaction._teamShare`, `ArgusGovernance.sol:31`: converts a native18 representation of USDC6 to raw USDC6, floors the 10% team share, then converts the accounting amount back to native18. For a balance comprised of whole ERC20 units, `/1e12` is exact. Disposition: intentional asset-unit normalization. Do not replace these mechanically with a formula that records unpayable native18 fractions.

### incorrect-equality (Medium; one assigned-scope result)

`ArgusRevenueVault._sync`, line 178: `income == 0` is an idempotent early return after checking `quote.balanceOf(this) >= accounted`. Positive donations/income are handled by the other branch; this is not `balance == fixedExpectedBalance` that an attacker can invalidate by force-sending. Disposition: false positive.

### locked-ether (Medium; four assigned-scope results)

`ArgusRevenueVault.receive`, inherited `ArgusProjectTreasury.receive` and `ArgusSatisfaction.receive` are ARC-specific contracts whose quote is the canonical native-USDC ERC20 interface `0x3600...0000`. On ARC, native18 USDC and ERC20 USDC6 are representations of the same asset; income and spending use that canonical ERC20 interface. Project docs and recorded public-testnet acceptance explicitly cover native/ERC20 consistency (`docs/arc/vaults.md:85`, `:103`). Slither treats native and ERC20 balances as unrelated and cannot infer the native-USDC precompile. For the intended verified ARC chain this warning does not establish locked revenue. Below-USDC6-unit native dust and precompile/address restrictions remain chain-specific limitations; a standard Anvil ERC20 mock does not prove those semantics. No fresh live RPC/precompile verification was performed by this triage.

`ArgusCustodyRouter.fundPlatformBuyback()` at line 96 is payable but always reverts; ordinary value sends through it cannot succeed or lock funds. Router is not a user-deposit custody account and offers no generic sweep. Forced or wrong-asset sends are not a demonstrated third-party fund-drain exploit. Disposition: chain-semantic false positive / unsupported forced-deposit limitation, not a new arbitrary-withdrawal requirement.

### uninitialized-local (Medium; seven assigned-scope results)

Scalar locals are initialized to Solidity-defined zero: `_sync.allocated` (`ArgusRevenueVault.sol:194`), `_allocatePlugins.total/last` (`:216-217`), router distribution `previous` (`ArgusCustodyRouter.sol:192`), factory `_policy.sum` and `_revenuePolicy.sum` (`ArgusVaultFactory.sol:109`, `:151`). `last` is used only after at least one enabled nonzero-weight plugin is found; total=0 returns first. `setRevenuePolicy.original` is a fixed-size memory array whose five indices are assigned by the bounded loop before use (`ArgusRevenueVault.sol:156-158`). These are not uninitialized storage references or missing sentinel assignments. Disposition: false positives; adding redundant zero assignments does not fix a bug.

### unused-return (Medium; fifteen assigned-scope raw results)

- Portal `launches` tuple reads in router constructor/register/poolKey/distribute/_owns and Vault launch, and `getSlot0`/opening-boundary reads in `keeperSwapState`, intentionally select the fields needed for their decision. Owner, quote asset, position ID and hook are validated at the owning route; ignored fees/ticks/other metadata are not booleans indicating transfer success.
- `ArcProjectTreasury.bind` (`ArcProjectTreasury.sol:76`, duplicated aliases) uses `terms.community` to verify this treasury and ignores the unrelated fee/rewards fields; supply and one-time factory binding are separately checked.
- `ArgusRevenueVault.collect` (`:230-232`) ignores reported locker/splitter amounts and accounts actual canonical quote balance delta through `_sync` after all calls. External calls still bubble up reverts; no reported return value is treated as proof of money received.
- Vault launch ignores `router.register` return (`:120`): router checks creator ownership and fixes `community[token]` internally; Vault custody is independently validated by token creator and splitter creator checks. The returned community address is not needed for the Vault ledger.
- `ArgusCustodyRouter.unlockCallback` ignores `poolManager.settle` amount (`:181`): it transfers the exact checked swap input after `sync`, explicitly verifies swap paid delta equals input (`:175`), calls settle and takes the checked positive output. The trusted Uniswap V4 manager enforces all deltas are settled when unlock closes; a short settlement reverts atomically. Fixed native-USDC token support is assumed, not arbitrary fee-on-transfer assets.

Disposition: no unchecked ERC20 success values (SafeERC20 is used), no confirmed missed necessary error/result check. Third-party Portal/V4 implementations remain pinned external dependencies, not independently audited here.

## SingleSpark warnings reviewed by parent (29 raw High/Medium)

- High: `ArcRewards.buyOwnToken` balance assertion; `ArcLaunchV2.collectFees` and `_topUpKeeper` reentrancy (3 raw total).
- Medium reentrancy: `ArcLaunch.executeBurn`, `ArcLaunchV2.executeBurn`, `ArcLaunchV2.launch` (3).
- Medium equality: `ArcLaunchStrategy._accrue`; `ArcLaunchV2.claimOperations`, `_topUpKeeper`, `_known`, `keeperGasAvailable`; `ArcLaunch._known` (6).
- Medium locked native currency: `ArcLaunchStrategy.receive` (1).
- Medium locals: `ArcLaunchStrategy._beforeSwap.tax`, `ArcRewards.distribute.previous` (2).
- Medium ignored results: strategy keeper state/fee collection/distribution initialization; launch pool-position reads; V1/V2 settlement return values; V2 fee and keeper-state tuple reads (14).

The parent reviewed the flagged functions and their caller/target guards. No additional unprivileged exploit was confirmed in these warnings:

- `ArcRewards.buyOwnToken` is keeper-only and nonreentrant, debits pending funding and timestamps before calling its immutable launch. The before/after token assertion verifies actual receipt; it does not grant credit from a stale balance. The project token and launch are configured by the factory, not supplied by the calling attacker.
- V2 `collectFees` is nonreentrant; strategy collection is launcher-only/nonreentrant and sends its V4 claim to the fixed launcher. `_credit` funds the project-owned fixed rewards account. `_topUpKeeper` updates ledgers and the daily limit before its fixed-keeper send; post-call writes only restore them when the send fails. The outer public money paths share the reentrancy guard. Reward `fundNative` rejects callers other than its launch.
- V1/V2 `executeBurn` are keeper-only/nonreentrant, debit their budgets before swaps and call the project token burn. V2 `launch` is nonreentrant and uses the one-time administrator-configured strategy/PositionManager. Permissionless `createProjectTreasury` does not transfer or alter another project's funds. PoolManager callbacks authenticate their sender; the fixed manager checks unlock settlement. No caller-controlled target or callback into a second spending entrypoint was established.
- Six equality warnings are intentional zero-work/sentinel or day-bucket comparisons: `tax == 0`, zero payable amount, unknown position ID, and timestamp day identity. They do not require an attacker-influenceable balance to equal a fixed constant.
- Both flagged value-type locals initialize to zero. `tax` stays zero when native tax is handled afterSwap; `previous` is the sorting sentinel with zero recipients rejected.
- Fourteen unused-return warnings project tuple fields or ignore V4 return metadata that is independently enforced through initialized pools, exact input/output deltas and zero unsettled deltas at unlock close. Strategy fee collection's callback burns its V4 claim and takes the fixed amount directly to `launcher`; its unused unlock result is not used as proof of payment.
- The `ArcLaunchStrategy.receive` locked-native warning is a real unsupported direct-deposit limitation: the contract accepts arbitrary direct native transfers and exposes no sweep. Its authorized revenue path holds V4 ERC6909 claims and collects them directly to `launcher`, so the intended fee path does not deposit native funds into this receive balance. Do not send native funds directly to the strategy. No third-party theft or trapped ordinary fee revenue was demonstrated; no arbitrary withdrawal was added during the audit.

## Limits

Low/Informational entries were not individually adjudicated in this High/Medium pass. No new tests, source edits or live transactions were needed for these detector dispositions. Existing audit PoCs remain the only additions from the earlier Argus source pass. The overall audit must preserve external-contract, deployed-code, hardware/chain-semantic and backend-scheduling gaps stated in `findings-argus.md`.
