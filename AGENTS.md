# SingleSparkContract development rules

## Mandatory development preflight

- Before every change, read [development and naming rules](../DEVELOPMENT.md) and the workspace architecture. Inspect Git status and preserve existing edits. Classify the feature, chain and launchpad; inspect callers, tests, exports and build paths before editing.
- Follow the file/symbol naming table. Name modules by business responsibility; preserve documented executable and ABI compatibility names. Run the applicable architecture, test and production-build checks before reporting completion.

- Canonical sources belong in `chains/`; existing `arc/` and `solana/` retain their build profiles and compatible operation scripts. Keep ABI, storage layout and deployed addresses unchanged during structural work. Run the relevant Foundry/Rust/client tests for contract changes; do not deploy funded transactions for structural verification.
