# SingleSparkContract development rules

## Mandatory development preflight

- Before every change, read [development and naming rules](../DEVELOPMENT.md) and the workspace architecture. Inspect Git status and preserve existing edits. Classify the feature, chain and launchpad; inspect callers, tests, exports and build paths before editing.
- Follow the file/symbol naming table. Name modules by business responsibility; preserve documented executable and ABI compatibility names. Run the applicable architecture, test and production-build checks before reporting completion.

- Canonical sources belong in `chains/`. Build profiles remain in `arc/`, `evm/`, `robinhood/` and `solana/`. Operational scripts belong in `scripts/<chain>/launchpads/<platform>/<production|testnet|local>/`; shared ARC tools belong in `scripts/arc/shared/`. Preserve existing npm commands and private journal/build paths when moving tools. Keep ABI, storage layout and deployed addresses unchanged during structural work. Run the relevant Foundry/Rust/client tests for contract changes; do not deploy funded transactions for structural verification.
- Public configuration and evidence belong in `deployments/<mainnet|testnet|local>/<chain>/<launchpad>/`; guides belong in `docs/`. A directory entry never authorizes a new network. Production policy delays remain 48 hours; isolated testnet compiler substitutions must not modify production sources.
