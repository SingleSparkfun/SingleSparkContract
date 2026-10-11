#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Exact upstream revisions; dependencies stay outside the application's source tree.
install_repo() {
  local name="$1" repo="$2" revision="$3"
  if [ ! -d "lib/$name/.git" ]; then
    git clone --no-checkout "https://github.com/$repo.git" "lib/$name"
  fi
  git -C "lib/$name" checkout --detach "$revision"
}
install_repo liquidity-launcher Uniswap/liquidity-launcher 1eda9f0c0243e2fdc0cbe0d665200ffa8c2ba53a
install_repo v4-core Uniswap/v4-core 59d3ecf53afa9264a16bba0e38f4c5d2231f80bc
install_repo v4-periphery Uniswap/v4-periphery ad04c9f24a170accf5ea1b2836bbafd514537ca6
install_repo openzeppelin-contracts OpenZeppelin/openzeppelin-contracts 21c8312b022f495ebe3621d5daeed20552b43ff9
install_repo solady Vectorized/solady 33b4b98e350bbcba6aa85642957c313e98b5f911
install_repo solmate transmissions11/solmate 4b47a19038b798b4a33d9749d25e570443520647
install_repo permit2 Uniswap/permit2 cc56ad0f3439c502c246fc5cfcc3db92bb8b7219
install_repo forge-std foundry-rs/forge-std 3b20d60d14b343ee4f908cb8079495c07f5e8981
install_repo bls-solidity randa-mu/bls-solidity 11af179a8287d978659aae07adb66aa60f64b8a6
