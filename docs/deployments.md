# Deployment environments

Each chain owns its configuration and evidence in `chains/<chain>/deployments/<environment>/<launchpad>/`. Shared business contracts have one source; environments do not duplicate production logic.

| Environment | Contents |
| --- | --- |
| `chains/arc/deployments/mainnet/singlespark/profile.json` | ARC 5042 parameters |
| `chains/arc/deployments/testnet/singlespark/profile.json` | Verified ARC Testnet 5042002 parameters |
| `chains/arc/deployments/testnet/argus/` | Portal, V2, weighted Claim and Keeper evidence |
| `chains/arc/deployments/local/argus/` | Local fork verification evidence |
| `chains/robinhood/deployments/mainnet/pons/reference.json` | Read-only mainnet reference; broadcasting prohibited |
| `chains/robinhood/deployments/testnet/pons/` | Test configuration, deployments and acceptance receipts |

Moving a record does not change its historical status. Read its timestamp, deployment version, transaction scope and result.

Private wallets, frozen compiler inputs and signed journals are ignored under `chains/arc/data/argus-public-testnet*` and `chains/robinhood/data/pons/`. Their contents and original deployment bindings are preserved. Never delete journals to retry or silently recompile signed inputs.

- [ARC Claim receipts](../chains/arc/deployments/testnet/argus/argus-public-testnet-claim.json)
- [ARC V2 receipts](../chains/arc/deployments/testnet/argus/argus-public-testnet-v2.json)
- [ARC custody and rollout](arc/vaults.md)
- [Pons deployment guide](robinhood/pons.md)

Production Solidity retains a 48-hour policy delay. Isolated Claim/gameplay testnet compiler inputs use 10 minutes. Directory selection does not authorize networks or migrate funds.
