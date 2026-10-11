# Robinhood / Pons test deployment

Feature: launch. Chain: Robinhood EVM. Launchpad: Pons V2. The current integration reuses testnet factory `0xEc987cEb5F08D6bdE2871E78AB67Af145746BC8c` and its dependencies. Its executable code matches the verified production version, but no official testnet deployment announcement exists; it is not labeled an official Pons deployment.

Test configuration: `deployments/testnet/robinhood/pons/config.json`. Read-only mainnet reference: `deployments/mainnet/robinhood/pons/reference.json`. Source pins: `chains/robinhood/launchpads/pons/sources.json`.

## Project Vault launch entrypoint (testnet)

`PonsVaultFactory` atomically clones a Vault, launches through the verified Pons factory and registers the wallet as Vault owner. Pons creator revenue must go to that Vault; callers cannot substitute an external wallet. `collectRevenue()` collects curve fees and lets the Vault claim FeeEscrow revenue itself. `deposit(amount)` accepts native ETH directly.

The first independent Vault retains the 48-hour delay and unallocated-income rules. Later gameplay validation uses a separately identified test factory with a fixed 10-minute delay; production sources still use 48 hours. The two deployments do not migrate funds or signed journals. Only native ETH launches on Robinhood Testnet (46630) are enabled, with Pons built-in buyback disabled. Pons external administrators can still change future creator recipients after its three-day delay.

Verification: `npm run test:pons:vault`. Deployment and reentrancy verification: `npm run deploy:pons:vault -- --wallet <testnet-wallet.json> --broadcast`. New journals stay in `.data/robinhood/pons/testnet/vault-launch/`; public records go to `deployments/testnet/robinhood/pons/vault-launch.json`, preserving earlier base-Pons rehearsal records.

Platform-token plan (2026-10-11): issue SingleSpark's platform token on Robinhood through Pons, with new custody/gameplay integration owned by Robinhood/Pons. Historical ARC platform-token records retain original addresses, funds and recovery. SSPTEST is an old acceptance token; the new platform test token is independently issued SingleSpark / SPARK. Addresses and actual acceptance status appear below. Cloud testnet availability was requested; mainnet issuance is not authorized.

## Base Pons build

Run workspace `npm install` for the contract project's declared viem dependency. Requirements: Node 24, Foundry Anvil, solc 0.8.35 and 0.8.26. Compiler lookup checks `SOLC_0_8_35` / `SOLC_0_8_26`, project `.data/robinhood/pons/compiler/`, then system SVM.

```sh
npm --prefix SingleSparkContract run build:pons
npm --prefix SingleSparkContract run test:pons
npm --prefix SingleSparkContract run test:pons:fork
```

The build reproduces seven verified contracts' creation bytecode and checks runtime code sizes. Cached downloads must match source and compiler-setting hashes. Source versions cannot change once public signed journals exist.

`test:pons:fork` is an optional local rehearsal that starts an Anvil fork at `127.0.0.1:18631`. Current acceptance uses the public test chain directly; the following commands spend test ETH.

## Public test deployment

The wallet file must be readable only by its owner, with format `{"deployer":{"address":"0x…","privateKey":"0x…"}}`, stored in an ignored private directory. Reports contain no keys. An existing ARC test wallet may be passed explicitly with `--wallet`; scripts do not automatically read credentials from other projects.

Run in the contract repository:

```sh
node robinhood/pons/deploy.mjs --wallet /absolute/path/to/testnet-wallet.json
node robinhood/pons/verify.mjs --wallet /absolute/path/to/testnet-wallet.json --broadcast
```

The first checks existing contracts and records addresses without broadcasting. The second accepts only chain ID `46630`, rechecks full code hashes, verified executable code, contract bindings, administrators and launch parameters, then performs native ETH launch, curve buying/selling, creator-fee collection, graduation and Uniswap v4 pool creation. Source comparison excludes only constructor immutable slots and the complete Solidity metadata suffix; full on-chain bytecode remains pinned by hash.

Configuration `match` includes compiler metadata; `executableMatch` excludes only the bounded parts described above. All seven reused contracts pass executable comparison, with full `codeHash` checked each time. Locker compiler metadata differs from mainnet while executable code matches.

The reused test deployment has zero launch fee, 0.000008 ETH virtual reserves and a 0.00002 ETH graduation threshold. Only ETH settlement is accepted; other ERC20 assets remain unverified. Scripts cap per-transaction Gas cost at 0.0015 ETH and cumulative maximum spending at 0.009 ETH, refusing new signatures if insufficient. Third-party administrators may change policy or disable launches; changes fail pinned-parameter checks instead of being accepted automatically.

The acceptance token sends creator revenue to an independent `PonsTestRevenueVault`, which claims through FeeEscrow. It has no withdrawal entrypoint, so small test revenues remain there. This fixture is not a complete SingleSpark gameplay Vault. Repeating the command resumes acceptance without duplicate launch or trades.

Before broadcasting, every raw signature, nonce, transaction hash and expected parameter is atomically persisted in `.data/robinhood/pons/testnet/transactions.json`. Resume with the same command after failure; do not delete journals. Changed configuration, build artifacts or account identities block recovery. A run lock prevents concurrent deployment in the same directory. After abnormal exit, verify no process remains before manually removing stale `run.lock`.

Test ETH faucet: https://faucet.testnet.chain.robinhood.com/ . It requires human verification and Google login. Consult public report status: local builds, transaction confirmations, public finality and application integration are separate stages.

## Completed public acceptance

On 2026-10-11, eight test transactions completed with total Gas cost 0.0000505478 ETH. Actual transactions, addresses, code hashes and finality status are in `deployments/testnet/robinhood/pons/deployment.json`.

- Test token: `0x07e4F508582fCf81f76B7a3b4cBc0A15a9661A3F`.
- Recipient contract: `0xF952414504c8D892e21a8fa7Cb40C63822F3B91f`, with browser source verification completed.
- Buying/selling, stale-economic-parameter rejection, automatic collection at graduation, contract revenue claims and Uniswap v4 pool creation passed.
- `testnet_acceptance_passed_pending_finality` means execution and confirmations passed, but RPC `finalized` has not covered all transactions. Finality is not complete.

Manual `sweepFees` permits only the creator recipient contract or platform operator. Acceptance used automatic graduation collection without operator permissions. Six deployment-boundary unit tests and architecture checks passed. Frontend architecture initially hit its default five-second timeout under machine load and passed with a 60-second timeout.

## Application integration boundaries

`/create?chain=46630&network=robinhood&platform=pons` launches atomically through `PonsVaultFactory`; adding `vault=<address>` enables revenue collection or direct ETH deposits. Frontend `VITE_PONS_TESTNET_ENABLED` and separate signed configuration jointly control availability. Backend `/api/robinhood-testnet/api/v2/chain-config` publishes only chain 46630 wallet-signed configuration, signed by `PONS_TESTNET_CONFIG_SIGNING_KEY`, without starting a Pons Keeper or private-key custody wallet.

Deployment addresses and full code hashes from `vault-launch.json` are pinned in separate frontend/backend `chains/robinhood/launchpads/pons/deployment.json` files. Deployment changes must update both pins, signed configuration and tests together. Every send checks code, bindings, current economics and wallet chain. Before opening the wallet, the browser persists nonce and parameters, then waits for finalized-block verification. Unknown broadcast outcomes cannot be resent directly. New gameplay-factory Claim availability follows independent acceptance; historical Vaults are not labeled Claim-ready. Mainnet stays disabled.

Contract provenance follows official deployments and Sourcify verification. This deployment has no independent security audit, and test parameters are unsuitable for mainnet launch.

## SingleSpark platform token and gameplay (2026-10-11)

| Item | Robinhood Testnet address |
| --- | --- |
| SingleSpark / SPARK platform test token | `0x79133018bf9cfd9049a428b5b16469c10c038a58` |
| Separate platform Vault | `0xcb78a9897bfaf2b1ac886a2d867ea292da23f0b9` |
| SSPLAY gameplay acceptance token | `0x4d2a257dcc5172a2540bc0f4b56e80bb9921c72e` |
| Separate SSPLAY Vault | `0xc4319ce7c81bd5fe0835ac2cf1e26aa3ee63d0de` |
| Gameplay factory (10-minute test delay) | `0xee540b1ab519a2f8076591e4db2380a965f0bf88` |
| Native ETH curve / V4 adapter | `0xc26b4cae05cae344038ea599fe4ba376bdf4b56e` |

`build-gameplay.mjs` creates a chain-46630, 10-minute test build in memory only. Build artifacts cannot change after public signed journals exist. Production `GameplayVaultFactory` retains its immutable 48-hour delay. Three plugins separately budget own-token buyback/burn, Robinhood SPARK buyback/burn and distribution inventory. New income reserves 10% platform and 0.5% Claim, then distributes 89.5% by enabled weights. Policy changes do not move existing budgets.

```sh
node robinhood/pons/build-gameplay.mjs
node robinhood/pons/verify-gameplay.mjs --wallet /absolute/testnet-wallet.json --broadcast
```

The script requires separate deployer/admin/executor test identities. Raw signatures are first persisted to `.data/robinhood/pons/testnet/gameplay/transactions.json`; public results go to `deployments/testnet/robinhood/pons/gameplay.json`. The same command resumes registration, waiting, policy, funding, all three plugins, Claim rewards and post-graduation V4 execution. Never delete journals to bypass the wait. `finalityComplete` separately tracks RPC finalized coverage; confirmation is not finality.

The web app reuses shared transaction review and EVM recovery journals. Optional backend `PONS_TESTNET_CLAIM_SIGNING_KEY` signs bounded tasks only. Caller, Vault, chain, policy revision, nonce, budget, minimum output and deadline are bound; the backend does not pay ordinary-project Gas. Historical ARC tokens lose current platform designation without changing their funds, immutable recipients or recovery records.

Production still requires issuance authorization and binding, the production 48-hour deployment/wait, an independent audit, distribution eligibility/indexing, a persisted 180-second platform-source Keeper interval and browser-wallet end-to-end acceptance. Test distribution uses 100 explicit fixture addresses, not a production eligibility scheme. No automatic Pons Keeper or mainnet transaction is added.
