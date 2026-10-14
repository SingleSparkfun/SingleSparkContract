# Security review: SingleSpark Solana / Pump

- Date: 2026-10-14.
- Baseline: SingleSparkContract commit `55efc39e947472c5a0ae889d46e07800e4a471a6`; working tree reviewed. Existing EVM edits preserved. Solana production sources had no pre-existing modifications.
- Skills applied: `1DanWave2/solana-security-skill` (scope, threat model, account validation, PDA/CPI, arithmetic, tokens, test gaps, report lifecycle) and Trail of Bits `solana-vulnerability-scanner` (all six patterns below). Skill source content hashes are recorded in source-manifest.json; fetched files remain in the temporary audit directory.
- Classification: revenue custody, Claim/gameplay, DAO and upgrade governance; chain Solana; launchpad Pump; native Rust.
- Scope: ~2,116 Rust production lines across `shared/`, `governance/governance.rs`, `programs/dao/lib.rs`, `programs/timelock/lib.rs`, `launchpads/pump/{lib,revenue}.rs`, and `legacy/lib.rs`; client and existing local-test evidence.
- Out of scope: off-chain keeper/frontend policy, RPC trust, external Pump/SPL implementation internals, deployed code/pins and historical signed journals. No production edit, deployment or network transaction was performed.

## Scope, actors and invariants (recorded before searching for findings)

Anonymous users can submit arbitrary instruction bytes/accounts and deploy substitute programs. Funded attackers can manipulate market state and transaction order. The online config authority is trusted for bounded strategy approval and registration, including price windows/recipient eligibility. The offline administrator is trusted to propose delayed upgrades/policy changes. External Pump/SPL programs are trusted only at their allowlisted IDs.

Invariants reviewed:
1. Each project has a mint/config-bound PDA vault; project/plugin budgets and lamport conservation remain isolated.
2. Privileged actions require the correct signer, owner/type/key relationship and canonical PDA; substituted CPI targets cannot gain vault authority.
3. Immediate pause remains available; policy changes/resumption/upgrades require the immutable production 48-hour controller. Online execution cannot directly withdraw arbitrary assets or upgrade code.
4. Execution never overspends its isolated budget, rejects within-batch duplicate recipients, and binds the nonce/deadline. Repeat recipients across batches are explicitly authorized and are not a finding. Receipt-shaped tag-4 payout compatibility remains available alongside tag 6.
5. DAO staking/voting/settlement/withdrawal preserve ownership, timing and amount bounds. Loader changes cannot bypass controller authorization.

## Summary

No confirmed exploitable vulnerability was found by this manual source/checklist pass. This is not a full audit or a deployed-contract attestation. One new test file adds six targeted native account-validation regressions; production code is unchanged.

| Severity | Confirmed findings |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Informational | 0 |

Readiness: **READY WITH CONDITIONS for a deeper external audit; deployment readiness is not established**. Required conditions and unrun tools are stated below.

## Trail of Bits coverage table

All locations below are relative to `SingleSparkContract/chains/solana/`. `clear` means the pattern was examined and no instance was found, not a universal safety guarantee.

| # | Pattern | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Arbitrary CPI | clear | Pump collection allows only exact Pump/PumpSwap discriminator/account shapes (`launchpads/pump/revenue.rs:264–284`); buy permits Pump, canonical PumpSwap pool, bounded WSOL funding and sync only (`:330–392`). Shared token CPIs bind target to validated mint owner (`shared/accounts.rs:154–216`, mint owner allowlist `:115–116`; DAO `governance/governance.rs:46–50`). Controller only calls pinned loader/System or its fixed adopted program (`programs/timelock/lib.rs:74–82`, `:129–132`, `:224`). |
| 2 | Improper PDA validation | clear | `shared/accounts.rs:43–46` derives via `find_program_address` and compares keys. Project/config/vault binding `launchpads/pump/revenue.rs:106–115`; signing rederives canonical vault bump `:519–522`; DAO/round/vote/claim use fixed-length domain-separated seeds. Controller rederives adopted target lock (`programs/timelock/lib.rs:126–130`). No production `create_program_address` usage or caller-supplied bump. Added explicit noncanonical-bump regression. |
| 3 | Missing ownership check | clear | Generic native load rejects foreign program owners, executable accounts, incorrect tags, malformed/trailing Borsh bytes (`shared/accounts.rs:48–53`). SPL token/mint validate owner, mint/authority/state/extensions (`:115–151`); Pump curve checks pinned owner/address/discriminator (`:219–242`). Loader validates executable owner, ProgramData address and binary variant (`shared/loader.rs:8–28`). Controller Lock lacks a separate tag but has one state type, exact Borsh layout and canonical owner/PDA validation. |
| 4 | Missing signer check | clear | Shared signer helper `shared/accounts.rs:29–33`; revenue payer/common `launchpads/pump/revenue.rs:98`, config authority co-signature `:617–618`, fixed withdrawal recipient signature `:498–507`; pause/update signature `:649`, `:715`. DAO init/open/vote/withdraw/team claim require appropriate signers (`governance/governance.rs:83`, `:139`, `:195`, `:331`, `:369`). Permissionless settle/execute require no arbitrary authority signature by design; timelock schedule/cancel/adoption check the stored administrator (`programs/timelock/lib.rs:75`, `:136`, `:179`). |
| 5 | Sysvar account check | n/a | The pre-1.8.1 spoofing pattern does not apply: `Cargo.toml:18` pins `solana-program = 2.3.0`. Security time/rent reads use `Clock::get()` / `Rent::get()` syscalls (`launchpads/pump/revenue.rs:124`, `:630`; `programs/timelock/lib.rs:168`, `:185`), not caller-deserialized sysvars. Loader CPI supplies its own required accounts and loader validates them. |
| 6 | Improper instruction introspection | n/a | Production source contains no `load_instruction_at`, `load_current_index` or `get_instruction_relative` usage. No instruction-sysvar authentication is implemented; replay is nonce/state/transaction-signature based. |

## Instruction and invariant walkthrough

- Config tag 0: authority and payer signatures, six-decimal restricted mint, pinned Pump curve, explicit bounty policy and bounded min/max. Namespace is the authority-derived config PDA (`shared/configuration.rs:13–42`). Configuration creation is intentionally permissionless per independent namespace.
- Revenue tag 1: config-authority registration, canonical vault and project, fixed reserve recipient, curve creator equality, controller immutability/loader authority, per-config plugin gate. Init uses system-owner/empty-data create, canonical PDA and rent exemption; reinit fails (`launchpads/pump/revenue.rs:161–240`; `shared/accounts.rs:63–98`).
- Revenue tags 2–6: both user and strategy-authority signatures; project/config/vault/nonce check; reconcile SOL/WSOL excluding rent before execution; pinned CPI targets and min-out/max-debit; funding bounded to existing bucket; post-execution conservation/solvency (`launchpads/pump/revenue.rs:96–117`, `:252–511`, `:603–637`). Tags 4 and 6 reject duplicate wallets inside a batch and transfer only to each wallet's validated ATA (`:425–480`). Tag 4 creates legacy receipts; tag 6 does not consult/create permanent receipts, so authorized cross-batch repeats remain possible.
- Revenue tags 7/9: only config authority can add local/global pause bits immediately. Tag 7 advances policy revision and execution nonce. Tags 8/10: only the controller PDA signer can change policy/resume; revision equality defeats stale queued actions. Global pause still gates a locally resumed project. Old income is reconciled with old weights before applying new policy; old budget balances remain unchanged by flags/weights (`:647–737`).
- Controller tags 0–5: adopt only an immutable controller and target whose loader authority is the signing admin; move authority to the canonical lock PDA. Freeze/hash upgrade buffer at schedule; immutable `172800`-second delay; fixed target and recipient; recheck buffer authority/hash at execution. No arbitrary CPI, authority rotation or immediate upgrade entrypoint (`programs/timelock/lib.rs:21`, `:69–232`). Permissionless delayed execution is intentional.
- DAO tags 16–22: init locks bought tokens rather than minting; requires revoked mint authority and checks original Pump supply. Round/vote/team-claim types have separate tags and canonical identities; votes are time bounded and cannot switch sides; settlement is single-use; withdrawals return only stored voter stake and winning reward, last winner receives residual dust; team entitlement is single-use and fixed-recipient. Permissionless round creation/settlement is intentional (`governance/governance.rs:81–427`).
- Legacy dispatcher retains combined ABI routing but current tag-7 PDA layout is not a claim that old EOA deployment binaries or wallet-signed journals were migrated. Those historic artifacts were not audited here.

## Arithmetic and external-token review

`shared/state.rs:12–27` uses checked add/sub and widened checked ratios. `Project::conserve` asserts reserved + spent + bountyPaid == received; sync cannot credit the same available balance twice. Unit coverage includes 1/99/100/10,000/u64::MAX allocations for both bounty policies and project kinds (`shared/state.rs:201–255`). Allocation floors fee/weights, with explicitly documented residual buyback assignment; no share-price conversion or first-depositor share inflation mechanism exists. This Solana policy is separate from the new weighted EVM policy. Reward costs are accounted at inventory purchase and used later only for proportional bounty settlement.

Raw payout multiplication is bounded by at most four recipients (`revenue.rs:427–442`). DAO vote weight is `u64 * min(remaining_seconds, u32 cap)`, which fits u128; reward multiplication is checked, stake totals are checked, guarded withdrawal subtraction cannot underflow. Release profile enables overflow checks (`Cargo.toml:28`). These proof bounds do not replace invariant fuzzing.

There is no on-chain oracle feed, borrowing or collateral valuation. Swap minimum output/maximum input are on-chain enforced; price-window policy remains the explicitly trusted backend's job. Mint extensions permit MetadataPointer/TokenMetadata only; token accounts permit ImmutableOwner only. Transfer fees/hooks/permanent delegate/frozen/nontransferable extensions are rejected rather than silently supported (`shared/accounts.rs:115–151`). Classic SPL and restricted Token-2022 CPIs select the validated owner program. DAO additionally requires mint authority revoked.

## Tests and remaining gaps

Added `tests/security_validation.rs` (six tests):
- Correct config authority must sign; a different signer is rejected.
- Both config and project reject foreign program owners and wrong type tags.
- Substituted config/project addresses fail.
- A valid off-curve but noncanonical config bump fails.
- A project bound to another config fails.
- Authorized emergency pause increments policy revision/nonce and preserves budgets.

Root reports existing Rust/client tests passed, and `cargo test --locked --test security_validation` passed all six new tests. Both default and explicit security Clippy completed with exit 0 and warnings; the guard-by-guard triage is below. The updated online cargo-audit result is also recorded below; warnings are not described as a clean dependency bill. These are host checks, not SBF runtime coverage: native AccountInfo tests check guards, not CPI execution/atomic runtime rollback. The complete workspace test logs are owned by the root runner.

Existing `tests/local.mjs` contains real local SBF/SPL assertions for replay, duplicate batch rollback, repeated recipients, legacy receipt-shaped payout, old-income allocation, immutable controller adoption, global/local pause inheritance, stale resumes, frozen/tampered buffers, delayed upgrade, DAO voting/settlement/independent claims. It uses an explicit Pump fixture, and was read as test evidence but not run during this delegated source review. A current run with the split production artifacts is still needed.

Further gaps: systematic per-instruction owner/signer/account substitutions (especially nested CPI metas); negative Token-2022 extension matrix and wrong token-program tests; rent/WSOL-close-recreate boundary tests; randomized cross-project budget/reward/nonce invariants; multi-voter DAO dust/claim-order fuzzing; adversarial official Pump/PumpSwap integration rather than only fixture programs. Security Clippy and online cargo-audit were run and triaged as below. A separate automated Solana static analyzer was not run; the Trail of Bits skill was applied as a manual scanner checklist.

## Security tooling results and warning triage

Root ran `cargo clippy --workspace --all-targets --locked -- -W clippy::arithmetic_side_effects -W clippy::unwrap_used -W clippy::expect_used`; exit 0, **with warnings**. Log: `solana-security-clippy.log`. Shared modules are included by multiple crates, so repeated diagnostics were deduplicated by canonical source location. Unused imports/types and deprecated Solana module imports are hygiene issues, not confirmed exploit paths. Production warnings were triaged individually:

| Location | Warning | Guard / proof and disposition |
| --- | --- | --- |
| `shared/loader.rs:31` | unwrap on `[13..45]` conversion | Prior `d.len() >= 45` at `:24` proves a 32-byte slice. Conversion cannot fail after the guard. |
| `shared/accounts.rs:80` | `bytes.len() + 1` | Callers serialize fixed-size Config/Project/PluginGate/Round/Vote/TeamClaim and u64 receipt values; no unbounded vector/string state type is passed to create. Their sizes are far below usize::MAX. |
| `shared/accounts.rs:240` | unwrap on `[40..48]` conversion | Prior Pump data length `>=125` at `:229` proves the exact eight-byte slice. |
| `programs/timelock/lib.rs:161` | `project.len()-8` and unwrap | Prior `project.len() >= 41` at `:155` proves subtraction and exact final eight bytes. Owner/tag/config validation also precedes revision use. |
| `programs/timelock/lib.rs:164` | `data.len()-1` | Entrypoint only allows lengths 1, 2 or 14; this branch reaches policy actions only for tag 4 length 14 or tag 5 length 2. Thus parameter copy length is exactly 13 or 1 into a 13-byte array. |
| `governance/governance.rs:144,156,205,227` | timestamp subtraction, round + 1, weight multiplication | Genesis originates from unspoofable `Clock::get()` at init. With real Solana positive Unix time and `now >= genesis`, elapsed seconds cannot exceed i64::MAX; ROUND_SECONDS is 86400 production or 600 isolated feature, so round + 1 is far below u64::MAX. Round end is constructed with checked add/mul. Voting requires `end-ROUND_SECONDS <= now < end`, bounding remaining seconds to the round length. u64 amount times u32 cap fits u128. This proof relies on valid initialized state and chain Clock, not arbitrary synthetic timestamps. |
| `governance/governance.rs:280` | quorum multiply/divide | u64 quorum times u32 cap fits u128; denominator is literal 2. Init further bounds quorum by supply and cap by round duration. |
| `governance/governance.rs:397–405` | reward division and remaining-weight subtraction | Winning outcome implies selected side's total weight > other side >=0, so `total > 0`. Numerator multiplication is checked. `:390` proves `p.weight <= r.weight_remaining` before subtraction. |
| `launchpads/pump/revenue.rs:384` | unwrap on `[4..12]` conversion | System-transfer allowlist requires data length exactly 12 at `:378` before conversion. |
| `launchpads/pump/revenue.rs:422` | `v.kind + 1` | Buy instruction first bounds kind <=2 at `:293`, so result <=3. |
| `launchpads/pump/revenue.rs:427,441,442,450` | payout length/index/count arithmetic | Stride is fixed 2 or 3. Short-circuit first guard ensures `a.len() >= 8+stride` before subtracting 8; remainder check and count <=4 precede later indexing. Count*10,000,000 <=40,000,000; index*stride+8 is bounded by the validated slice. |
| `launchpads/pump/revenue.rs:614–615` | account-count subtraction and nonce unwrap | `:613` requires account count >=11 and data length >=8; therefore split at len-6 and eight-byte conversion are safe. |
| `launchpads/pump/revenue.rs:729` | global-resume nonce unwrap | Same short-circuit expression checks data length exactly 9 before slicing first 8. |

Remaining unwrap/expect diagnostics are in `#[cfg(test)]` state assertions and the new regression tests; panic is the intended test failure behavior. Pump fixture code has unchecked parsing/raw lamport arithmetic (`tests/pump-fixture/src/lib.rs:19,43–44,109–115`); it is explicitly a test-only substitute, not production Pump code, and its success cannot certify hostile-input handling in the official external programs.

Root ran online `cargo audit` with the current advisory database. Result JSON: `solana-cargo-audit-online.json`; database commit `6aed84668c23d7f535077a9fe918bf1fa0f6a5bc`, last updated 2026-10-13T17:07:33+02:00, 1,310 advisories, 237 locked dependencies. Result: **0 vulnerability entries, 3 informational dependency warnings**:

- `bincode 1.3.3`: RUSTSEC-2025-0141, unmaintained.
- `libsecp256k1 0.6.0`: RUSTSEC-2025-0161, unmaintained.
- `rand 0.7.3`: RUSTSEC-2026-0097, unsound under the advisory's combination of log/thread_rng, a custom logger invoking RNG, reseeding and logging conditions.

`cargo tree --locked -i rand@0.7.3 -e features` traces rand via `libsecp256k1 -> solana-secp256k1-recover -> solana-program`; the current host feature tree enables rand std/getrandom/alloc/libc but not rand's log feature. The reviewed program does not install the custom RNG-using logger required by the advisory. No reachable on-chain exploit is demonstrated here; nevertheless this warning remains tracked, and dependency maintenance/SBF-target feature reachability must be reviewed before release. A version upgrade was not made because upgrading the pinned Solana SDK is beyond this audit task and requires compatibility validation.

## Conditions and deployment trust

Verified deployment pins must be checked against actual deployed ELF/loader state. Registration proves the chosen controller is immutable and owns the revenue loader authority, but does not verify its bytecode equals this 48-hour controller source (`revenue.rs:189–200`). The verified controller program pin is therefore part of the trust model, not an on-chain code-identity guarantee. The offline administrator can intentionally change revenue rules after 48 hours; the documented model is delayed admin trust. The online signer can choose eligible recipients and trading bounds only within budgets; its off-chain policy was out of scope.

This pass skipped deployments, live RPC verification, external-network transactions and historical journal inspection. No safety claim about deployed contracts or untouched off-chain policy follows from zero source findings.
