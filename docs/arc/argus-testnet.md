# ARC Claim deployment preparation

This is a separate deployment on ARC Testnet 5042002. It reuses the pinned independent Portal and deploys a new Router, Vault implementation and Factory. Existing contracts, V1/V2 artifacts, balances and journals remain intact. The isolated Claim Factory build uses a 10-minute delay; production Solidity remains fixed at 48 hours.

**Deployment status:** the weighted Claim deployment and its public acceptance receipts are recorded in `chains/arc/deployments/testnet/argus/argus-public-testnet-claim.json`. Earlier local or preflight reports retain their historical status. New Vaults reserve 10% platform fees and 0.5% Claim rewards, then divide 89.5% among enabled plugins with initial relative weights 1:1:1. Three independently registered contracts implement own-token burn, platform-token burn and distribution. All-disabled income remains unallocated; existing balances are retained. Community funding inside plugins remains a separate unresolved policy.

Run from the Contract repository after the design and code are final:

```sh
forge test --root chains/arc
node scripts/arc/launchpads/argus/testnet/build.mjs --claim
node scripts/arc/launchpads/argus/testnet/rehearse-claim.mjs
node scripts/arc/launchpads/argus/testnet/deploy-claim.mjs
node scripts/arc/launchpads/argus/testnet/deploy-claim.mjs --broadcast
node scripts/arc/launchpads/argus/testnet/verify-claim.mjs --broadcast
```

`chains/arc/data/argus-public-testnet-claim` contains the new build and durable signed journal. `chains/arc/deployments/testnet/argus/argus-public-testnet-claim.json` contains public addresses, code hashes and receipts after deployment. Builds become immutable once a transaction journal exists. Never delete a journal to retry or silently recompile its signed inputs.

`rehearse-claim.mjs` pins public testnet block 66440020 and writes only to a loopback Anvil fork with a separate temporary journal. It explicitly substitutes the existing test ERC20 for ARC's unsupported native-USDC precompile. Native USDC/gas mirroring and ARC blocklist behavior are therefore outside this rehearsal; only public testnet receipts can establish those. The same bounded acceptance routine runs without this substitution on public testnet. Rehearsal also checks the one-second-early rejection, activation at 600 seconds and re-running without extra transactions.

The dedicated test accounts are reused from the owner-only original wallet file. The script refuses another chain, unresolved external pending transactions, a per-transaction gas commitment above 0.5 test USDC, or a total commitment above 10 test USDC. Of that total, 7 is reserved for test trading/donations; the current acceptance uses 0.5 and 0.1 trades, a separately labelled 6.25 donation and a 0.05 all-disabled fixture donation. No account keys are written into the public report.

The bootstrap platform target remains the original router-compatible test asset. A new platform-token target, if required by the final plan, needs its own verified launch and the actual 10-minute policy change on this isolated testnet controller (old controllers still require 48 hours). Do not mark a scheduled change as executed or switch backend identities while old signed transactions remain unresolved.

Contract acceptance and frontend/backend rollout are separate. Verify chain bindings, source/build versions, each project's actual on-chain allocation, Claim gas/reward previews, final receipts and recovery before reporting the web flow available. An all-plugins-disabled project must retain the intended fee collection and fixed-recipient settlement behavior; the final dynamic allocation policy decides where its unallocated income stays.
