# SingleSpark Solana programs

Native Rust / SBF program for SOL-paired Pump and PumpSwap coins. Includes creator-fee accounting, buyback and burn, distributions, caller rewards, project reserves, and token-locked governance. No mainnet program ID or deployment is configured.

## Source and client

| File | Responsibility |
| --- | --- |
| `src/revenue.rs` | Immutable plugin registration, official Pump CPIs, nonce checks, payouts and Claim settlement |
| `src/governance.rs` | 30% token lock, daily rounds, staked votes, team/burn settlement, voter withdrawals |
| `src/state.rs` | Account layouts and checked integer accounting |
| `src/accounts.rs` | PDA, owner, signer, mint/extension checks and SPL transfers/burns |
| `client.mjs` | Instruction builders, account decoders, PDA derivation and v0 transaction construction |
| `tests/local.mjs` | Compiled SBF tests in an isolated local validator |

This is a native Borsh ABI, not an Anchor program. Instruction tags and layouts are defined by the Rust argument structs and matching client builders. All money arguments in JavaScript are `bigint` or canonical integer strings. Token amounts use 6 decimals; SOL amounts use lamports.

## Revenue plugins

Each Hook wallet can register exactly one project PDA. Configuration is namespaced by the platform authority and must be pinned by the backend. Registration requires both the platform authority and that coin's Hook signer, checks the real Pump curve's creator, and fixes plugin choices and the reserve recipient. There is no configuration update instruction.

`Collect` invokes only the official native-SOL creator collection instructions. It credits the actual increase in Hook SOL + wrapped SOL during those CPIs. Prior balances, unrelated deposits, ATA rent and previous collections are not credited again. Creator vaults are aggregated by creator wallet: another project appointing the same Hook as creator can also contribute fees to that wallet.

The immutable `bountySource` parameter must be supplied explicitly:

| Value | Allocation of actual collected revenue |
| --- | --- |
| `0` | Meme: 83% own buyback, 7% platform buyback, 5% distributions, 4% reserve, 1% Claim rewards. Platform coin: 94% own buyback, 5% distributions, 1% Claim rewards. |
| `1` | First reserve 1% for Claim rewards, then split the remaining 99% by the original 83/7/5/4/1 or 94/0/5/0/1 rules, including platform operations. |

Integer rounding stays in own buyback; it never increases the caller reward above `floor(collected / 100)`. Disabled plugin budgets remain reserved and are not reassigned.

Collection alone pays no bounty. The reward pool is released in proportion to completed enabled plugin work. A buyback earns its portion only after the bought tokens are burned. Distribution purchases retain their cost basis; the corresponding reward becomes payable when those tokens reach recipients. Each distribution transfers exactly 10 tokens per address, at most four per instruction, and creates a permanent per-project recipient receipt. A failed buy, burn, transfer, reward floor or receipt check rolls the transaction back. Sub-ten-token inventory remains for later distribution purchases.

Each operation specifies the expected project nonce; the program increments it only on success. Buy instructions bind target mint, canonical Pump curve / PumpSwap pool, Hook authority and token account, maximum debit, minimum tokens, minimum caller reward and a deadline of at most 60 seconds. Only supported buy, wrapped-SOL funding and sync CPIs are accepted. The program performs the burn itself. Transfer-fee, transfer-hook, frozen and unsupported Token-2022 extensions are rejected. Plain SPL Token and metadata-only Token-2022 mints are supported.

Claim transactions use the user as fee payer and reward recipient and the custodial Hook as the other signer. Account rent may also be paid by the user; `sponsorRent` is explicitly bounded to 0.02 SOL. Preview the whole transaction's net cost, including ATA/receipt rent. A failed transaction still consumes its network fee. Reusing a signature does not execute twice; a newly signed transaction with an old nonce fails.

The Hook remains a custodial wallet. Its private-key holder can bypass this program and transfer assets directly; this is not a noncustodial revenue vault. Off-chain price-window and gas-profitability checks remain necessary before the platform co-signs. The program enforces the signed price limits but does not independently compute the backend's TWAP or select recent active wallets.

Project reserve and platform operations can only be withdrawn to their fixed recipients, with signatures from both that recipient and the Hook. These withdrawals earn no Claim reward.

## Governance

The configured platform token must be an initialized, unfreezable Pump coin with revoked mint authority. Initialization transfers **30% of the curve's original token supply** from the funding wallet into the DAO PDA's token account. It does not mint tokens. Buy the funding allocation on Pump before initializing, or include purchase and initialization in an atomic transaction. Historical proof that the funding wallet itself bought every deposited token is not part of this program.

Required immutable initialization parameters:

- `team`: fixed team recipient.
- `releaseBasis`: `0` for the initial locked amount, `1` for remaining locked tokens.
- `quorum`: minimum raw stake, in token base units.
- `weightCapSeconds`: explicit time-weight cap, 1–86,400 seconds.

Rounds last 24 hours. Opening a round moves 0.1% of the selected release basis from the lock into that round's vault, capped by remaining funds, with a one-base-unit minimum for the final dust. Missed days do not unlock a backlog. A previous open round must settle before another opens.

Vote weight is `stake × min(seconds until round end, weightCapSeconds)`. Additional stake keeps the same side and is weighted at its own deposit time. Stake cannot leave before settlement. Quorum requires both the configured raw stake and total weight of at least `quorum × weightCapSeconds / 2`.

- Satisfied wins: 90% of the release goes to the fixed team ATA, 10% to the winning voters.
- Not satisfied wins: the program burns 90%; 10% goes to the winning voters.
- Tie or insufficient quorum: the release returns to the lock; all voters can recover their stake.

Voters withdraw their principal and any winning reward exactly once. Winning rewards are proportional to weight; the final winning withdrawal receives rounding dust. DAO and round vaults are PDA-controlled; there is no administrative principal-withdrawal instruction. Unsolicited token deposits do not block initialization or rounds and are not counted as locked funds or rewards. The deployment's upgrade authority remains a separate trust decision.

## Build and verify

From the workspace root:

```sh
npm run test:sol-contracts
npm run build:sol-contracts
npm run test:sol-contracts:local
```

Requires Rust, `cargo-build-sbf` / Solana CLI, and Node dependencies (`npm ci --prefix SingleSparkContract/solana --ignore-scripts`). The lockfile is compatible with platform-tools v1.48 / Rust 1.84; use `--locked` and do not blindly update its compiler-sensitive transitive versions. On the current workstation the installed tools are under `/private/tmp/singlespark-solana-v4.3.0/solana-release/bin`. A build with its existing cached compiler is:

```sh
CARGO_HOME=/private/tmp/singlespark-contract-cargo \
RUSTC=/Users/nat/.cache/solana/v1.48/platform-tools/rust/bin/rustc \
/private/tmp/singlespark-solana-v4.3.0/solana-release/bin/cargo-build-sbf \
  --manifest-path SingleSparkContract/solana/Cargo.toml --workspace \
  --tools-version v1.48 --skip-tools-install --no-rustup-override -- --locked

SOLANA_TEST_VALIDATOR=/private/tmp/singlespark-solana-v4.3.0/solana-release/bin/solana-test-validator \
  npm run test:sol-contracts:local
```

The production artifact is `target/deploy/singlespark_solana.so`. The separately named `singlespark_pump_fixture.so` is **only a deterministic test implementation**; never deploy it. Local tests execute the actual compiled SingleSpark program, real System/ATA/SPL/Token-2022 programs and signature/rollback rules, while substituting Pump/PumpSwap liquidity and fee collection. Governance settlement tests reload isolated genesis fixtures with an elapsed round timestamp. They are not a mainnet Pump acceptance test.

## Integration status

The client exports builders for all instructions and `decodeState`. `buildTransaction` creates a v0 transaction with the user as payer, supports supplied address lookup tables, and rejects wire payloads over 1,232 bytes. Production Pump account sets may require a lookup table; do not silently drop accounts or plugin operations to fit a legacy transaction.

No service configuration, live Hook balance, program deployment, database ledger or frontend Claim endpoint has been switched by this change. Before activating the backend, bind the deployed program/config/genesis, use its on-chain ledger and nonce, retain frozen co-signing and receipt recovery, and stop the old keeper from independently spending the same Hook budgets. The existing legacy-only wallet validator also needs a v0 path before enabling these transactions in the UI.

The reward funding policy and DAO initialization parameters above must be chosen before deployment. Mainnet deployment, real Pump/PumpSwap acceptance, SDK dependency advisory remediation and external security review remain outstanding. The pinned existing Solana JS dependency family reports the `bigint-buffer` buffer-overflow advisory and `jayson` / `stream-json` / `uuid` advisories; npm's proposed fixes require incompatible major changes or a downgrade of SPL Token. They have not been automatically applied. This Node SDK dependency risk does not affect the separately built Rust SBF artifact.

Protocol references: [Pump creator-fee instructions](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md), [Solana cross-program invocations](https://solana.com/docs/core/cpi), [Solana transactions](https://solana.com/docs/core/transactions).
