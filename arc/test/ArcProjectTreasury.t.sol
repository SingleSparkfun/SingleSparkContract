// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ArcLaunchV2Fixture} from "./ArcLaunchV2Fixture.sol";
import {ArcLaunchV2} from "../src/ArcLaunchV2.sol";
import {ArcProjectTreasury, IProjectTreasuryFactory} from "../src/ArcProjectTreasury.sol";
import {ArcToken} from "../src/ArcLaunch.sol";

contract ArcProjectTreasuryTest is ArcLaunchV2Fixture {
    ArcProjectTreasury vault;
    address governed;
    address proposer = address(0x1111);
    address yesVoter = address(0x2222);
    address noVoter = address(0x3333);
    bytes32 quote = keccak256("official-checkout-quote");

    function setUp() public {
        _deploy(treasury);
        vault = ArcProjectTreasury(payable(launch.createProjectTreasury()));
        governed = launch.launch("Governed", "GOV", "", 30_000, 30_000, address(vault));
        assertEq(address(vault.token()), governed);
        assertEq(vault.team(), treasury);
        launch.fundFees{value: 7_500e18}(governed);
        launch.claimCommunity(governed);
        assertEq(address(vault).balance, 300e18);
        assertEq(vault.quorum(), 10_000_000e18);
    }

    function _stake(address voter, uint256 id, bool support, uint256 amount) internal {
        deal(governed, voter, amount, false);
        vm.startPrank(voter);
        ArcToken(governed).approve(address(vault), amount);
        vault.vote(id, support, amount);
        vm.stopPrank();
    }

    function testAnyoneProposesSingleServiceAndTeamClaimsOnlyApprovedAmount() public {
        vm.prank(proposer);
        uint256 id = vault.propose(ArcProjectTreasury.Service.TokenInfo, 299e18, quote);
        assertEq(id, 1);
        assertEq(vault.available(), 1e18);
        assertEq(ArcToken(governed).balanceOf(proposer), 0); // proposer only spent Gas
        vm.expectRevert(ArcProjectTreasury.NotReady.selector);
        vault.propose(ArcProjectTreasury.Service.Boost, 1e18, quote);
        _stake(yesVoter, id, true, 6_000_000e18);
        _stake(noVoter, id, false, 5_000_000e18);
        vm.prank(proposer);
        vm.expectRevert(ArcProjectTreasury.Unauthorized.selector);
        vault.claim(id);
        vm.prank(treasury);
        vm.expectRevert(ArcProjectTreasury.NotReady.selector);
        vault.claim(id);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vault.settle(id);
        assertTrue(vault.infoApproved());
        uint256 beforeTeam = treasury.balance;
        vm.prank(treasury);
        vault.claim(id);
        assertEq(treasury.balance - beforeTeam, 299e18);
        assertEq(address(vault).balance, 1e18);
        assertEq(vault.available(), 1e18);
        assertTrue(vault.infoClaimed());
        vm.expectRevert(ArcProjectTreasury.Invalid.selector);
        vault.propose(ArcProjectTreasury.Service.TokenInfo, 1e18, quote);
        vm.expectRevert(ArcProjectTreasury.NotReady.selector);
        vm.prank(treasury);
        vault.claim(id);
        vm.prank(yesVoter);
        vault.withdrawStake(id);
        vm.prank(noVoter);
        vault.withdrawStake(id);
        assertEq(ArcToken(governed).balanceOf(yesVoter), 6_000_000e18);
        assertEq(ArcToken(governed).balanceOf(noVoter), 5_000_000e18);
    }

    function testQuorumAndMajorityRejectAndReleaseBudget() public {
        vm.prank(proposer);
        uint256 id = vault.propose(ArcProjectTreasury.Service.Boost, 300e18, quote);
        _stake(yesVoter, id, true, 5_000_000e18);
        _stake(noVoter, id, false, 5_000_000e18);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vault.settle(id); // 1% participated, but a tie is not a majority.
        assertEq(vault.available(), 300e18);
        vm.prank(treasury);
        vm.expectRevert(ArcProjectTreasury.NotReady.selector);
        vault.claim(id);
        vm.prank(proposer);
        uint256 second = vault.propose(ArcProjectTreasury.Service.Boost, 1e18, quote);
        _stake(yesVoter, second, true, 9_999_999e18);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vault.settle(second); // Majority without the 1% quorum also fails.
        assertEq(vault.available(), 300e18);
        vm.prank(yesVoter);
        vault.withdrawStake(second);
    }

    function testBindingAndProposalValidation() public {
        vm.expectRevert(ArcProjectTreasury.Unauthorized.selector);
        vault.bind(governed);
        vm.expectRevert(ArcProjectTreasury.Invalid.selector);
        vault.propose(ArcProjectTreasury.Service.Boost, 301e18, quote);
        vm.expectRevert(ArcProjectTreasury.Invalid.selector);
        vault.propose(ArcProjectTreasury.Service.Boost, 1e18, bytes32(0));
        vm.prank(proposer);
        uint256 id = vault.propose(ArcProjectTreasury.Service.Boost, 1e18, quote);
        _stake(yesVoter, id, true, 1e18);
        vm.startPrank(yesVoter);
        vm.expectRevert(ArcProjectTreasury.Invalid.selector);
        vault.vote(id, false, 1e18);
        vm.expectRevert(ArcProjectTreasury.NotReady.selector);
        vault.withdrawStake(id);
        vm.stopPrank();
    }

    function testQuorumStaysAtOnePercentOfInitialSupplyEvenAfterBurn() public {
        ArcProjectTreasury delayed = ArcProjectTreasury(payable(launch.createProjectTreasury()));
        address next = launch.launch("Later", "LATE", "", 0, 0, address(delayed));
        vm.warp(vm.getBlockTimestamp() + 3);
        uint256 bought = launch.trade{value: 100e18}(next, true, 100e18, 1, vm.getBlockTimestamp() + 120);
        ArcToken(next).burn(bought);
        assertEq(address(delayed.token()), next);
        assertEq(delayed.quorum(), 10_000_000e18);
    }

    function testFactoryRejectsAnEoaAnUnregisteredVaultAndAnotherCreatorsVault() public {
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        launch.setProjectTeam(proposer);
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        launch.launch("EOA", "EOA", "", 0, 0, proposer);
        ArcProjectTreasury fake = new ArcProjectTreasury(IProjectTreasuryFactory(address(launch)), address(this), treasury);
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        launch.launch("Fake", "FAKE", "", 0, 0, address(fake));
        vm.prank(proposer);
        address other = launch.createProjectTreasury();
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        launch.launch("Other", "OTHER", "", 0, 0, other);
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        launch.launch("Again", "AGAIN", "", 0, 0, address(vault));
    }
}
