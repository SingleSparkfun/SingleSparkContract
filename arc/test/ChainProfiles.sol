// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ArcLaunchV2} from "../src/ArcLaunchV2.sol";

/// @notice The numbers a chain profile (`backend/chains/<chainId>.json`) feeds the constructors, for tests.
library ChainProfiles {
    struct Profile {
        string name;
        uint256 halfSupplyCost;
        int24 minLaunchTick;
        uint256 minBuyback;
        ArcLaunchV2.KeeperGas gas;
    }

    /// @dev Arc mainnet and testnet (native USDC): exactly the constants these contracts carried before.
    function arc() internal pure returns (Profile memory) {
        return Profile({
            name: "Arc",
            halfSupplyCost: 10_000e18,
            minLaunchTick: -160_100,
            minBuyback: 5e18,
            gas: ArcLaunchV2.KeeperGas({
                trigger: 2e18, buffer: 1e18, maxTopup: 0.25e18, minTopup: 0.01e18, dailyLimit: 2e18
            })
        });
    }

    /// @dev Synthetic, tests only (also `backend/test/profiles/eth-like.json`): a native currency worth
    ///      k = 10,000 / 3.7 ≈ 2,702.7 USDC. Every USDC amount of the Arc profile is divided by k, so the curve
    ///      and the thresholds mean the same in dollars: halfSupplyCost 3.7e18, minBuyback 5 / k, keeper gas
    ///      2 / 1 / 0.25 / 0.01 / 2 USD divided by k.
    ///      Pool prices are tokens per native unit (currency0 is native), so a k-times dearer native currency
    ///      multiplies every price by k and moves every tick up by ln(k) / ln(1.0001):
    ///        ln(2702.7027) / ln(1.0001) = 7.90201 / 0.000099995 ~ 79,024 ticks,
    ///        -160,100 + 79,024 = -81,076, aligned to the 25-tick spacing: -81,075.
    ///      The last token of the range then costs about the same in dollars as on Arc, and the solved opening
    ///      tick moves up by the same ~79,000 ticks (the tests assert costOfHalf within 1% of 3.7e18).
    function ethLike() internal pure returns (Profile memory) {
        return Profile({
            name: "ETH-like",
            halfSupplyCost: 3.7e18,
            minLaunchTick: -81_075,
            minBuyback: 0.00185e18,
            gas: ArcLaunchV2.KeeperGas({
                trigger: 0.00074e18, buffer: 0.00037e18, maxTopup: 0.0000925e18, minTopup: 0.0000037e18,
                dailyLimit: 0.00074e18
            })
        });
    }
}
