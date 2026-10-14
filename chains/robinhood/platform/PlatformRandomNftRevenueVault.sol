// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PlatformNftRevenueVault} from "./PlatformNftRevenueVault.sol";
import {IPlatformNft, IPlatformNftController} from "./IPlatformNft.sol";

/// Reuses the existing isolated 50/50 ledgers and historical quality-seconds accounting.
contract PlatformRandomNftRevenueVault is PlatformNftRevenueVault {
    uint16[8] public gradeWeights;
    constructor(address owner_, IPlatformNft nft_, IPlatformNftController controller_, uint16[8] memory weights)
        PlatformNftRevenueVault(owner_, nft_, controller_)
    {
        for (uint256 i; i < 8; ++i) if (weights[i] == 0) revert Invalid();
        gradeWeights = weights;
    }
    function qualityWeight(uint8 quality) public view override returns (uint16) {
        if (quality < 1 || quality > 8) revert Invalid();
        return gradeWeights[quality - 1];
    }
}
