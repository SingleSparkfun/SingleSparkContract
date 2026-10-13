// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {PlatformNftVaultFactory} from "../PlatformNftVaultFactory.sol";
import {PlatformNftRevenueVault} from "../PlatformNftRevenueVault.sol";
import {PlatformNft} from "../PlatformNft.sol";

contract ForceNative {
    constructor(address payable target) payable { selfdestruct(target); }
}
contract RejectNative { receive() external payable { revert(); } }
contract ReenterRewards {
    PlatformNftRevenueVault public vault;
    bool public blocked;
    constructor(PlatformNftRevenueVault vault_) { vault = vault_; }
    receive() external payable {
        uint256[] memory epochs = new uint256[](1);
        try vault.claimRewards(epochs, payable(address(this))) { } catch { blocked = true; }
    }
}

contract PlatformNftRevenueVaultTest is Test {
    PlatformNftVaultFactory factory;
    PlatformNftRevenueVault vault;
    PlatformNft nft;
    address constant OWNER = address(0x1000);
    address constant ALICE = address(0x2000);
    address constant BOB = address(0x3000);
    uint256 start;

    function setUp() public {
        vm.chainId(46630); vm.warp(1_800_000_000);
        factory = new PlatformNftVaultFactory(OWNER); vault = factory.vault(); nft = factory.nft();
        _schedule(ALICE, 1, bytes32(uint256(1)));
        _schedule(BOB, 3, bytes32(uint256(2)));
        vm.warp(block.timestamp + 48 hours);
        factory.executeMint(ALICE, 1, bytes32(uint256(1)));
        factory.executeMint(BOB, 3, bytes32(uint256(2)));
        start = block.timestamp; vm.deal(address(this), 100 ether);
    }
    function _schedule(address to, uint8 quality, bytes32 nonce) private { vm.prank(OWNER); factory.scheduleMint(to, quality, nonce); }
    function _ids(uint256 id) private pure returns (uint256[] memory ids) { ids = new uint256[](1); ids[0] = id; }
    function _stake(address account, uint256 id) private {
        vm.startPrank(account); nft.approve(address(vault), id); vault.stake(_ids(id)); vm.stopPrank();
    }
    function _close(uint256 epoch) private { vm.warp(vault.epochStart(epoch + 1)); }
    function _claim(address account, uint256 epoch) private {
        vm.prank(account); vault.claimRewards(_ids(epoch), payable(account));
    }
    function _conserved() private view {
        assertEq(vault.accountedBalance(), vault.ownerCredit() + vault.nftReserve());
        assertEq(address(vault).balance, vault.accountedBalance());
        assertEq(vault.totalReceived(), address(vault).balance + vault.totalOwnerClaimed() + vault.totalNftClaimed());
    }
    function testAtomicFactoryBindingAndNoMainnetDeployment() public {
        assertEq(vault.owner(), OWNER); assertEq(address(vault.nft()), address(nft));
        assertEq(address(vault.controller()), address(factory)); assertEq(nft.issuer(), address(factory));
        assertEq(factory.DELAY(), 48 hours); assertEq(vault.EPOCH_DURATION(), 7 days);
        vm.chainId(4663); vm.expectRevert(); new PlatformNftVaultFactory(OWNER);
    }
    function testDelayedIssuanceCannotBeReplayedOrChanged() public {
        bytes32 nonce = bytes32(uint256(3)); _schedule(ALICE, 4, nonce);
        vm.expectRevert(); factory.executeMint(ALICE, 4, nonce);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(); factory.executeMint(BOB, 4, nonce);
        uint256 id = factory.executeMint(ALICE, 4, nonce);
        assertEq(nft.ownerOf(id), ALICE); assertEq(nft.qualityOf(id), 4);
        vm.expectRevert(); factory.executeMint(ALICE, 4, nonce);
        vm.expectRevert(); nft.mint(ALICE, 4);
        vm.prank(BOB); vm.expectRevert(); factory.scheduleMint(BOB, 1, nonce);
        assertTrue(bytes(nft.tokenURI(id)).length > 0);
    }
    function testOwnerCanOnlyWithdrawHalfOfNewIncome() public {
        vault.deposit{value: 10 ether}();
        assertEq(vault.ownerCredit(), 5 ether); assertEq(vault.nftReserve(), 5 ether);
        vm.prank(BOB); vm.expectRevert(); vault.claimOwner();
        vm.prank(OWNER); vault.claimOwner(); assertEq(OWNER.balance, 5 ether);
        vm.prank(OWNER); vm.expectRevert(); vault.claimOwner();
        vault.deposit{value: 2 ether}(); vm.prank(OWNER); vault.claimOwner();
        assertEq(OWNER.balance, 6 ether); assertEq(address(vault).balance, 6 ether); _conserved();
    }
    function testCumulativeRoundingAndForcedIncomeAreAccountedOnce() public {
        vault.deposit{value: 1}(); vault.deposit{value: 1}(); vault.deposit{value: 1}();
        assertEq(vault.ownerCredit(), 1); assertEq(vault.nftReserve(), 2);
        new ForceNative{value: 7}(payable(address(vault))); vault.sync(); vault.sync();
        assertEq(vault.totalReceived(), 10); assertEq(vault.ownerCredit(), 5); assertEq(vault.nftReserve(), 5); _conserved();
    }
    function testTreasuryForwardingAutomaticallyRecordsIncome() public {
        (bool ok,) = address(factory).call{value: 2 ether}(""); assertTrue(ok);
        assertEq(address(factory).balance, 0); assertEq(vault.ownerCredit(), 1 ether); assertEq(vault.nftReserve(), 1 ether); _conserved();
    }
    function testQualityTimesActualDurationAndNoEarlyOrRepeatedClaim() public {
        _stake(ALICE, 1); vault.deposit{value: 12 ether}();
        uint256 epoch = vault.currentEpoch(); uint256 end = vault.epochStart(epoch + 1);
        vm.warp((start + end) / 2); _stake(BOB, 2);
        vm.prank(ALICE); vm.expectRevert(); vault.claimRewards(_ids(epoch), payable(ALICE));
        vm.warp(end);
        // Common full period and Epic half period have equal quality-seconds.
        assertEq(vault.epochWeight(ALICE, epoch), vault.epochWeight(BOB, epoch));
        assertEq(vault.claimable(ALICE, epoch), 3 ether); assertEq(vault.claimable(BOB, epoch), 3 ether);
        _claim(ALICE, epoch); _claim(BOB, epoch);
        assertEq(ALICE.balance, 3 ether); assertEq(BOB.balance, 3 ether);
        vm.prank(ALICE); vm.expectRevert(); vault.claimRewards(_ids(epoch), payable(ALICE));
        _conserved();
    }
    function testUnstakingPreservesOldRewardsAndStopsFutureWeight() public {
        _stake(ALICE, 1); uint256 epoch = vault.currentEpoch(); vault.deposit{value: 2 ether}();
        vm.warp(block.timestamp + 1 days);
        vm.prank(ALICE); vault.unstake(_ids(1), BOB);
        assertEq(nft.ownerOf(1), BOB); assertEq(vault.currentWeight(ALICE), 0); assertEq(vault.stakedCount(ALICE), 0);
        uint256 historical = vault.epochWeight(ALICE, epoch); _close(epoch);
        assertEq(vault.epochWeight(ALICE, epoch), historical); _claim(ALICE, epoch);
        assertEq(ALICE.balance, 1 ether); assertEq(vault.epochWeight(ALICE, epoch + 1), 0);
        assertEq(vault.claimable(BOB, epoch), 0); _conserved();
    }
    function testSameTimestampExitAndRestakeDoNotInventTime() public {
        _stake(ALICE, 1); vm.prank(ALICE); vault.unstake(_ids(1), ALICE); _stake(ALICE, 1);
        uint256 epoch = vault.currentEpoch(); vm.warp(block.timestamp + 1 days);
        assertEq(vault.epochWeight(ALICE, epoch), 100 * 1 days);
        assertEq(vault.totalEpochWeight(epoch), 100 * 1 days);
    }
    function testForeignAndDirectSafeDepositsCannotLockAnUnrecordedNft() public {
        vm.prank(ALICE); vm.expectRevert(); nft.safeTransferFrom(ALICE, address(vault), 1);
        vm.prank(BOB); vm.expectRevert(); vault.stake(_ids(1));
        _stake(ALICE, 1); vm.prank(BOB); vm.expectRevert(); vault.unstake(_ids(1), BOB);
        uint256[] memory duplicates = new uint256[](2); duplicates[0] = 1; duplicates[1] = 1;
        vm.prank(ALICE); vm.expectRevert(); vault.unstake(duplicates, ALICE);
        assertEq(nft.ownerOf(1), address(vault)); assertEq(vault.stakedTokens(ALICE, 0, 64)[0], 1);
    }
    function testEmptyEpochRolloverCannotBecomeOwnerCredit() public {
        uint256 epoch = vault.currentEpoch(); vault.deposit{value: 2 ether}(); _close(epoch);
        vault.rolloverEmptyEpoch(epoch);
        assertEq(vault.epochRevenue(epoch), 0); assertEq(vault.epochRevenue(epoch + 1), 1 ether);
        assertEq(vault.ownerCredit(), 1 ether); assertEq(vault.nftReserve(), 1 ether);
        vm.expectRevert(); vault.rolloverEmptyEpoch(epoch); _conserved();
    }
    function testNonemptyEpochCannotBeRolledAndFutureStakeCannotClaimPastIncome() public {
        _stake(ALICE, 1); uint256 epoch = vault.currentEpoch(); vault.deposit{value: 2 ether}(); _close(epoch);
        vm.expectRevert(); vault.rolloverEmptyEpoch(epoch); _stake(BOB, 2);
        assertEq(vault.claimable(BOB, epoch), 0); assertEq(vault.claimable(ALICE, epoch), 1 ether);
        vm.warp(block.timestamp + 1000 weeks); _claim(ALICE, epoch); _conserved();
    }
    function testDuplicateBatchAndFailedRecipientRollBackClaimFlags() public {
        _stake(ALICE, 1); uint256 epoch = vault.currentEpoch(); vault.deposit{value: 2 ether}(); _close(epoch);
        uint256[] memory epochs = new uint256[](2); epochs[0] = epoch; epochs[1] = epoch;
        vm.prank(ALICE); vm.expectRevert(); vault.claimRewards(epochs, payable(ALICE));
        assertFalse(vault.epochClaimed(ALICE, epoch));
        RejectNative receiver = new RejectNative();
        vm.prank(ALICE); vm.expectRevert(); vault.claimRewards(_ids(epoch), payable(address(receiver)));
        assertFalse(vault.epochClaimed(ALICE, epoch)); assertEq(vault.nftReserve(), 1 ether);
        _claim(ALICE, epoch); _conserved();
    }
    function testReentrantRecipientCannotDrainOtherClaims() public {
        _stake(ALICE, 1); uint256 epoch = vault.currentEpoch(); vault.deposit{value: 2 ether}(); _close(epoch);
        ReenterRewards receiver = new ReenterRewards(vault);
        vm.prank(ALICE); vault.claimRewards(_ids(epoch), payable(address(receiver)));
        assertTrue(receiver.blocked()); assertEq(address(receiver).balance, 1 ether); _conserved();
    }
    function testPauseIsImmediateAndResumeAlwaysWaits48HoursWithoutBlockingExit() public {
        _stake(ALICE, 1); vm.prank(OWNER); factory.pause();
        vm.prank(BOB); nft.approve(address(vault), 2);
        vm.prank(BOB); vm.expectRevert(); vault.stake(_ids(2));
        vm.prank(ALICE); vault.unstake(_ids(1), ALICE);
        vm.prank(OWNER); factory.scheduleResume(); vm.prank(OWNER); vm.expectRevert(); factory.resume();
        vm.warp(factory.resumeAfter()); vm.prank(OWNER); factory.resume();
        _stake(BOB, 2); vm.prank(OWNER); vault.pause();
        vm.prank(OWNER); vault.scheduleResume(); vm.prank(OWNER); vm.expectRevert(); vault.resume();
        vm.warp(vault.resumeAfter()); vm.prank(OWNER); vault.resume(); assertFalse(vault.paused());
    }
    function testFuzzConservationAndTwoUserRounding(uint96 rawIncome, uint32 delay) public {
        uint256 income = bound(uint256(rawIncome), 2, 100 ether);
        _stake(ALICE, 1); uint256 epoch = vault.currentEpoch();
        vm.warp(block.timestamp + bound(uint256(delay), 1, 1 days)); _stake(BOB, 2);
        vault.deposit{value: income}(); _close(epoch);
        uint256 alice = vault.claimable(ALICE, epoch); uint256 bob = vault.claimable(BOB, epoch);
        assertLe(alice + bob, income - income / 2);
        if (alice > 0) _claim(ALICE, epoch); if (bob > 0) _claim(BOB, epoch);
        vm.prank(OWNER); vault.claimOwner(); _conserved();
        assertLe(vault.nftReserve(), 1);
    }
}
