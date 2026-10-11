# Deployment environments

Public configuration and evidence use `deployments/<environment>/<chain>/<launchpad>/`. Contracts have one source under `chains/`; environment records do not duplicate business logic.

| Environment | Contents |
| --- | --- |
| `mainnet/arc/singlespark/profile.json` | Existing ARC 5042 chain parameters |
| `testnet/arc/singlespark/profile.json` | Verified ARC Testnet 5042002 chain parameters |
| `testnet/arc/argus/` | Independent Portal, V2, weighted Claim and Keeper evidence |
| `local/arc/argus/` | Local fork and structural verification evidence |
| `mainnet/robinhood/pons/reference.json` | Read-only mainnet reference; broadcasting prohibited |
| `testnet/robinhood/pons/` | Verified test configuration, deployments and acceptance receipts |

Moving a public record does not change its historical status. Read its timestamp, deployment version, transaction scope and result; older blocked or pending records describe those earlier checks.

Private wallets, frozen compiler inputs and signed journals stay at their original ignored paths: `arc/data/argus-public-testnet*`, `.data/robinhood/pons/` and configured operator data directories. They are not moved with public reports.

- [ARC Claim receipts](testnet/arc/argus/argus-public-testnet-claim.json)
- [ARC V2 receipts](testnet/arc/argus/argus-public-testnet-v2.json)
- [ARC custody and rollout](../docs/arc/vaults.md)
- [Pons deployment guide](../docs/robinhood/pons.md)

Production Solidity retains a 48-hour policy delay. The isolated Claim/gameplay testnet builds use 10 minutes. Selecting a directory or replacing configuration cannot authorize another network or migrate funds.
