// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ArcLaunchV2} from "../launchpads/singlespark/ArcLaunchV2.sol";
import {ArcToken} from "../launchpads/singlespark/ArcLaunch.sol";

/// @notice Testnet-only probe: launch and buy atomically, so the first-second tax is reproducible.
contract ArcOpeningProbe {
    ArcLaunchV2 public immutable launch;

    constructor(ArcLaunchV2 factory) {
        require(block.chainid == 5042002, "Testnet only");
        launch = factory;
    }

    function launchAndBuy(string calldata metadataURI) external payable returns (address token) {
        require(msg.value > 0 && msg.value <= 10e18, "Test budget");
        token = launch.launch("Opening Tax Test", "OTAX", metadataURI, 30_000, 30_000, launch.createProjectTreasury());
        uint256 bought = launch.trade{value: msg.value}(token, true, msg.value, 1, block.timestamp + 120);
        require(ArcToken(token).transfer(msg.sender, bought), "Token return failed");
    }
}
