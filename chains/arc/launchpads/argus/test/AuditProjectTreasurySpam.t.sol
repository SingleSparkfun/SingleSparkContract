// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ArgusGovernanceTest} from "./ArgusGovernance.t.sol";
import {ArcProjectTreasury} from "../../../../evm/governance/ArcProjectTreasury.sol";

contract AuditProjectTreasurySpamTest is ArgusGovernanceTest {
    function testTokenlessProposerCanOccupyConsecutiveVotingWindows() public {
        address spammer = address(0xbad);
        q.mint(address(project), 300e6);
        assertEq(token.balanceOf(spammer), 0);
        for (uint256 i; i < 2; ++i) {
            vm.prank(spammer);
            uint256 id = project.propose(ArcProjectTreasury.Service.Boost, 300e18, bytes32(uint256(1)));
            assertEq(project.available(), 0);
            vm.expectRevert(ArcProjectTreasury.NotReady.selector);
            project.propose(ArcProjectTreasury.Service.TokenInfo, 299e18, bytes32(uint256(2)));
            vm.warp(vm.getBlockTimestamp() + 7 days);
            project.settle(id);
            assertEq(project.available(), 300e18);
        }
        assertEq(token.balanceOf(spammer), 0);
        assertEq(q.balanceOf(spammer), 0);
        assertEq(q.balanceOf(address(project)), 300e6);
    }
}
