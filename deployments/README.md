# Deployment environments

Contract sources belong to their chain and launchpad under `chains/`. Environment directories contain parameters, addresses, verification results and deployment records, without duplicating test versions of business logic.

```text
deployments/
  mainnet/robinhood/pons/reference.json   Official mainnet reference; broadcasting prohibited
  testnet/robinhood/pons/config.json      Verified reusable testnet addresses and parameters
  testnet/robinhood/pons/deployment.json  Reuse records and public acceptance transactions
chains/robinhood/launchpads/pons/         Verified upstream source pins
robinhood/pons/                          Build, deployment and verification entrypoints
.data/robinhood/pons/                    Ignored source caches, builds and signed journals
```

Existing ARC and Solana deployment entrypoints, addresses and recovery journals retain compatible paths. New deployments use `mainnet|testnet / chain / launchpad`; existing signed transaction journals are not moved.

- Existing ARC test deployments: [Argus Claim](../arc/deployments/argus-public-testnet-claim.json), [Argus V2](../arc/deployments/argus-public-testnet-v2.json).
- Compatible ARC mainnet and testnet configuration remains in `arc/chains/`; operational rules are in [VAULTS.md](../arc/VAULTS.md).
- Pons test deployment instructions are in [robinhood/pons/README.md](../robinhood/pons/README.md).

A mainnet directory does not authorize mainnet execution. Test scripts enforce Robinhood Testnet `46630`; replacing configuration cannot enable mainnet execution.
