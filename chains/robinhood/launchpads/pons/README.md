# Pons V2 verified sources

`sources.json` pins seven verified deployments on Pons mainnet `4663`, including source addresses, verification record IDs, compiler versions, source and compiler-setting hashes, and creation-bytecode hashes. The sources are the factory listed in the official documentation and its on-chain dependency getters.

The `robinhood/pons/build.mjs` entrypoint fetches complete Solidity standard inputs from Sourcify. Each version compiles separately and reproduces the verified creation bytecode byte for byte. Complete sources and compiler inputs are cached in `.data/robinhood/pons/sources/` for local review and browser source verification. Upstream SPDX declarations and source paths remain unchanged. This follows the existing ARC upstream-source build approach without merging or modifying incompatible compilation units.

The factory, Hook and related contracts use Solidity 0.8.35. The verified mainnet locker retains the contract name `RobinFunFiV2LaunchLocker` and uses 0.8.26. This is its actual on-chain verification name; a platform rename does not justify substituting different sources. Interfaces with the same name differ across compilation units and must use their respective pinned inputs.

Official sources:

- https://docs.ponsfamily.com/v2
- https://github.com/ponsdotdev/pons-labs
- https://sourcify.dev/server/v2/contract/4663/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e?fields=all
