// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ArcProjectTreasury, IProjectTreasuryFactory} from "./ArcProjectTreasury.sol";

/// @notice Keeps treasury creation code out of the launch factory's EIP-170 runtime limit.
contract ArcProjectTreasuryDeployer {
    function deploy(address creator, address team) external returns (address) {
        return address(new ArcProjectTreasury(IProjectTreasuryFactory(msg.sender), creator, team));
    }
}
