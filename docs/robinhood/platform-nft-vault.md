# Robinhood platform NFT income Vault

Canonical code: `chains/robinhood/platform/`. This is SingleSpark's platform-owned income and NFT participation contract, separate from `launchpads/pons` project Vaults. It neither changes existing project allocations nor migrates old treasury balances. All constructors reject networks other than Robinhood Testnet (46630); mainnet issuance remains disabled.

## Contracts and deployment

- `PlatformNftVaultFactory` creates one collection and one revenue Vault atomically, binds their immutable owner/controller addresses, and can receive native platform income and forward it into the Vault in the same transaction.
- `PlatformNft` is enumerable ERC-721 with a 10,000 cap, immutable quality and on-chain SVG/JSON metadata. The factory's owner schedules explicit issuances; anyone can execute the exact recipient/quality/nonce after an immutable 48-hour delay. A completed operation cannot be replayed. There is no online arbitrary mint key or mutable issuance delay. This controlled issuance is not a verifiable random claim mechanism.
- `PlatformNftRevenueVault` receives native ETH income. No private-key revenue wallet, token sale receipt or project plugin budget is required by the contract.

The reviewed public testnet record is [nft-vault.json](../../chains/robinhood/deployments/testnet/platform/nft-vault.json). Raw signed deployment transactions are durably journaled in ignored, owner-only `chains/robinhood/data/platform-nft-vault/<build identity>/`. Do not delete or overwrite them to retry an unknown broadcast. The script rejects changed artifacts, identities, receipts and transaction parameters. Its total maximum budget is 0.001 test ETH, with a 0.0005 per-transaction maximum. A single run lock prevents concurrent nonce use.

```sh
npm run build:platform:nft
npm run test:platform:nft
npm run deploy:platform:nft:testnet -- --wallet /absolute/owner-only-testnet-wallet.json
npm run deploy:platform:nft:testnet -- --wallet /absolute/owner-only-testnet-wallet.json --broadcast
```

The wallet format is the existing workspace testnet role file (`deployer` and `admin`, each containing `address` and `privateKey`). Deployer pays deployment/acceptance Gas; admin becomes the immutable Vault owner. Keys never enter reports. Deployment uses canonical chain-local artifacts and dependencies, not executables from another project or a Pons deployment script. Platform operations live in `scripts/robinhood/platform/testnet/` because this is not a launchpad adapter. The separate Foundry `platform` profile leaves default Pons source/test/out paths unchanged.

## Revenue flow

A future Pons factory may set its immutable `treasury` to the platform NFT Vault or the forwarding platform factory. A project Vault's `settlePlatform()` then pays its own recorded platform budget into this receiver. Existing factories retain their fixed treasury recipients; deploying this module does not reroute their income.

Every incoming payment credits owner and NFT ledgers separately. Cumulative rounding guarantees `owner allocation = floor(total received / 2)` even across one-wei payments. The remaining wei belong to NFTs. `claimOwner()` pays only outstanding owner credit to the immutable owner; repeated withdrawals cannot take another half of the remaining contract balance. Forced ETH is recognized once by `sync()` in the epoch in which it is recognized.

`accountedBalance = ownerCredit + nftReserve`. Total received equals outstanding liabilities plus all owner and NFT payouts. NFT sale proceeds should go to a different receiver; sending them here necessarily treats them as distributable platform income.

## NFT custody and seven-day settlement

An epoch is exactly 604,800 seconds from Vault deployment time, not seven days since each user's last claim. Current-epoch claims revert. Closed epochs remain claimable later; claiming multiple closed epochs is bounded to 32 per transaction and cannot pay an epoch twice.

Quality weights are Common 100, Rare 150, Epic 200 and Legendary 300. For each account and the total population, time checkpoints store quality weight and its cumulative integral. Epoch quality-seconds are the integral difference at the cycle boundaries. A user's reward is `floor(epoch NFT income × account quality-seconds / total quality-seconds)`.

Mid-cycle additions and exits count their actual seconds. No extra continuous-time bonus is applied. Stake transfer, ownership, collection, quality and batch size are checked on-chain. Only the recorded staker can withdraw, and NFT transfer after withdrawal never transfers the previous holder's historical rewards. Direct safe-transfer deposits outside `stake()` revert. Do not use raw ERC-721 `transferFrom` to deposit into the Vault.

All accounting uses binary search over checkpoints instead of looping through dormant epochs or all NFTs. No Keeper, arbitrary epoch roots or off-chain reward signer is required. Empty-cycle income stays reserved for NFT holders; anyone may explicitly roll a closed zero-weight epoch into the current epoch. Nonempty epochs cannot be rolled. Distribution rounding dust remains in the NFT reserve and cannot be withdrawn by the owner.

Local and global pauses immediately stop new stakes (global pause also stops issuance). Resumption takes an immutable 48 hours. Exits and earned claims remain available while paused. The contracts have no upgrade, arbitrary native withdrawal or mutable revenue split.

## Actual testnet verification and availability

The deployment acceptance uses a real 0.000001 test ETH transfer through the platform factory, verifies the 50/50 ledger at that receipt block, then has the admin actually withdraw 0.0000005 test ETH while verifying the NFT half remains. Runtime bytecode is compared with local artifacts after masking only declared compiler immutable ranges; complete deployed code hashes and binding addresses are recorded.

Receipt confirmation and finality are reported separately. The first seven-day claim cannot be honestly reported as live-verified before the period ends. Foundry covers cycle boundaries, partial duration, exits, replay, reentrancy, failed payouts, rounding, pause delays and a 256-run conservation fuzz test; this is not an independent audit.

The frontend has no demo wallets, sample NFTs, synthetic rewards or simulated X verification. Its chain-owned adapter verifies the deployed code hashes and factory/NFT/Vault bindings, requires finalized deployment, reads recent on-chain state with an explicit finality label, and journals actual wallet requests before submission. Wallet sends require the verified Robinhood Testnet network configuration plus this explicitly authorized deployment's own pinned code and immutable bindings. The public testnet RPC prunes older state, so displayed balances use a consistent recent block. Pending transactions still recover only after finalized receipts, by the original account/chain/nonce without asking for another signature. Read failures show unavailable data, never invented zero balances.

Paid random claims, X task eligibility and referral reward issuance are not connected or enabled. Those need a reviewed randomness/issuance path and actual X/referral verification; there are no successful-looking placeholders. No mainnet contract or existing project fee recipient was changed.
