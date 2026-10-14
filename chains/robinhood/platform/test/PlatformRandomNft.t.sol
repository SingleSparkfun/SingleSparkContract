// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IOpenVrf} from "../IOpenVrf.sol";
import {PlatformRandomNftFactory} from "../PlatformRandomNftFactory.sol";
import {PlatformRandomNft} from "../PlatformRandomNft.sol";
import {PlatformRandomNftRevenueVault} from "../PlatformRandomNftRevenueVault.sol";

contract MockOpenVrf is IOpenVrf {
    uint256 public requestFee = 7;
    uint256 public nextId = 1;
    mapping(uint256 => address) public consumers;
    function setFee(uint256 fee) external { requestFee = fee; }
    function requestRandomness(uint32 gasLimit) external payable returns (uint256 id) {
        require(msg.value == requestFee && gasLimit == 150_000);
        id = nextId++; consumers[id] = msg.sender;
    }
    function deliver(uint256 id, uint256 word) external { PlatformRandomNftFactory(payable(consumers[id])).rawFulfillRandomness(id, word); }
}
contract NftClaimReceiver is IERC721Receiver {
    bool public rejects = true;
    bool public reentryBlocked;
    PlatformRandomNftFactory public factory;
    constructor(PlatformRandomNftFactory factory_) { factory = factory_; }
    function request(bytes32 nonce) external payable returns (uint256) { return factory.requestClaim{value: msg.value}(nonce, msg.value); }
    function accept() external { rejects = false; }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        require(!rejects);
        try factory.completeClaim(1) {} catch { reentryBlocked = true; }
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract PlatformRandomNftTest is Test {
    address constant OWNER = address(0x1000);
    address constant ALICE = address(0x2000);
    address constant BOB = address(0x3000);
    MockOpenVrf router;
    PlatformRandomNftFactory factory;
    PlatformRandomNft nft;
    PlatformRandomNftRevenueVault vault;

    function _odds() internal pure returns (uint16[8] memory) { return [uint16(4000), 2500, 1500, 1000, 600, 300, 99, 1]; }
    function _weights() internal pure returns (uint16[8] memory) { return [uint16(100), 200, 300, 400, 500, 600, 700, 800]; }
    function _artwork() internal pure returns (string[8] memory artwork) {
        for (uint256 i; i < 8; ++i) artwork[i] = "ipfs://test-only-artwork";
    }
    function setUp() public {
        vm.chainId(46630); vm.warp(1_800_000_000); vm.deal(ALICE, 1 ether); vm.deal(BOB, 1 ether);
        router = new MockOpenVrf();
        factory = new PlatformRandomNftFactory(OWNER, router, _odds(), _weights(), _artwork());
        nft = factory.nft(); vault = factory.vault();
        vm.prank(OWNER); factory.scheduleResume();
        vm.warp(block.timestamp + 48 hours); vm.prank(OWNER); factory.resume();
        vm.prank(OWNER); factory.scheduleClaim(ALICE, bytes32(uint256(1)));
    }
    function _request(address account, bytes32 nonce) internal returns (uint256 id) {
        vm.prank(account); id = factory.requestClaim{value: 7}(nonce, 7);
    }
    function _schedule(address account, bytes32 nonce) internal {
        vm.prank(OWNER); factory.scheduleClaim(account, nonce);
    }
    function _ids(uint256 id) internal pure returns (uint256[] memory ids) { ids = new uint256[](1); ids[0] = id; }
    function testSeparateBindingsAndMainnetRejected() public {
        assertEq(nft.issuer(), address(factory)); assertEq(address(vault.nft()), address(nft));
        assertEq(address(vault.controller()), address(factory)); assertEq(vault.owner(), OWNER);
        assertEq(address(factory.randomnessRouter()), address(router)); assertEq(factory.DELAY(), 48 hours);
        vm.chainId(4663); vm.expectRevert(); new PlatformRandomNftFactory(OWNER, router, _odds(), _weights(), _artwork());
    }
    function testRejectsMissingInvalidOddsWeightsRouterAndArtwork() public {
        uint16[8] memory odds = _odds(); odds[7] = 49;
        vm.expectRevert(); new PlatformRandomNftFactory(OWNER, router, odds, _weights(), _artwork());
        odds = _odds(); odds[0] = 0;
        vm.expectRevert(); new PlatformRandomNftFactory(OWNER, router, odds, _weights(), _artwork());
        uint16[8] memory weights = _weights(); weights[7] = 0;
        vm.expectRevert(); new PlatformRandomNftFactory(OWNER, router, _odds(), weights, _artwork());
        vm.expectRevert(); new PlatformRandomNftFactory(OWNER, IOpenVrf(BOB), _odds(), _weights(), _artwork());
        string[8] memory artwork = _artwork(); artwork[7] = "";
        vm.expectRevert(); new PlatformRandomNftFactory(OWNER, router, _odds(), _weights(), artwork);
    }
    function testAllTenThousandSlotsExactlyMatchDeclaredOdds() public view {
        uint256[8] memory counts;
        for (uint256 slot; slot < 10_000; ++slot) ++counts[factory.gradeForWord(slot) - 1];
        uint16[8] memory odds = _odds();
        for (uint256 i; i < 8; ++i) assertEq(counts[i], odds[i]);
        assertEq(factory.gradeForWord(9999), 8); assertEq(factory.gradeForWord(10_000), 1);
    }
    function testFuzzMappingUsesCumulativeIntervals(uint256 word) public view {
        uint8 grade = factory.gradeForWord(word); assertGe(grade, 1); assertLe(grade, 8);
        uint16[8] memory odds = _odds(); uint256 lower;
        for (uint256 i; i < grade - 1; ++i) lower += odds[i];
        assertGe(word % 10_000, lower); assertLt(word % 10_000, lower + odds[grade - 1]);
    }
    function testImmediateEligibilityCannotBeStolenOrReplayed() public {
        vm.prank(BOB); vm.expectRevert(); factory.requestClaim{value: 7}(bytes32(uint256(1)), 7);
        bytes32 nonce = bytes32(uint256(2));
        vm.prank(BOB); vm.expectRevert(); factory.scheduleClaim(BOB, nonce);
        vm.prank(OWNER); factory.scheduleClaim(ALICE, nonce);
        (, uint256 readyAt,,) = factory.claims(factory.claimOperation(ALICE, nonce));
        assertEq(readyAt, block.timestamp); assertEq(factory.CLAIM_DELAY(), 0);
        vm.prank(BOB); vm.expectRevert(); factory.requestClaim{value: 7}(nonce, 7);
        uint256 id = _request(ALICE, nonce); assertEq(id, 1); assertEq(factory.reservedSupply(), 1);
        assertEq(block.timestamp, readyAt);
        vm.prank(ALICE); vm.expectRevert(); factory.requestClaim{value: 7}(nonce, 7);
        bytes32 operation = factory.claimOperation(ALICE, nonce);
        vm.prank(OWNER); vm.expectRevert(); factory.cancelClaim(operation);
        vm.prank(OWNER); vm.expectRevert(); factory.scheduleClaim(ALICE, nonce);
    }
    function testAdministrativeResumeStillRequiresFull48Hours() public {
        vm.startPrank(OWNER); factory.pause(); factory.scheduleResume(); vm.stopPrank();
        uint256 readyAt = factory.resumeAfter(); assertEq(readyAt, block.timestamp + 48 hours);
        vm.warp(readyAt - 1); vm.prank(OWNER); vm.expectRevert(); factory.resume();
        vm.warp(readyAt); vm.prank(OWNER); factory.resume();
        _schedule(BOB, bytes32(uint256(2))); _request(BOB, bytes32(uint256(2)));
        assertEq(block.timestamp, readyAt);
    }
    function testCancelledEligibilityCannotBeRescheduledOrRequested() public {
        bytes32 operation = factory.claimOperation(ALICE, bytes32(uint256(1)));
        vm.prank(OWNER); factory.cancelClaim(operation);
        vm.prank(ALICE); vm.expectRevert(); factory.requestClaim{value: 7}(bytes32(uint256(1)), 7);
        vm.prank(OWNER); vm.expectRevert(); factory.scheduleClaim(ALICE, bytes32(uint256(1)));
    }
    function testExactFeeAndUserCapProtectAgainstFeeChange() public {
        router.setFee(8);
        vm.prank(ALICE); vm.expectRevert(); factory.requestClaim{value: 8}(bytes32(uint256(1)), 7);
        vm.prank(ALICE); vm.expectRevert(); factory.requestClaim{value: 9}(bytes32(uint256(1)), 9);
        assertEq(factory.reservedSupply(), 0);
        vm.prank(ALICE); factory.requestClaim{value: 8}(bytes32(uint256(1)), 8);
        assertEq(address(router).balance, 8); assertEq(address(vault).balance, 0); assertEq(address(factory).balance, 0);
    }
    function testOnlyBoundRouterCanDeliverKnownRequestExactlyOnce() public {
        uint256 id = _request(ALICE, bytes32(uint256(1)));
        vm.expectRevert(); factory.rawFulfillRandomness(id, 9999);
        vm.prank(address(router)); vm.expectRevert(); factory.rawFulfillRandomness(99, 9999);
        router.deliver(id, 9999);
        vm.expectRevert(); router.deliver(id, 0);
        (, uint256 word, bool received, bool minted) = factory.results(id);
        assertEq(word, 9999); assertTrue(received); assertFalse(minted);
    }
    function testZeroIsAValidResultAndAnyoneCanCompleteOnlyToLockedRecipient() public {
        uint256 id = _request(ALICE, bytes32(uint256(1)));
        vm.expectRevert(); factory.completeClaim(id);
        router.deliver(id, 0);
        vm.prank(BOB); uint256 tokenId = factory.completeClaim(id);
        assertEq(nft.ownerOf(tokenId), ALICE); assertEq(nft.qualityOf(tokenId), 1); assertEq(factory.reservedSupply(), 0);
        vm.expectRevert(); factory.completeClaim(id);
        vm.expectRevert(); nft.mint(BOB, 8);
    }
    function testOutOfOrderCallbacksKeepEachRecipientsGradeAndMetadata() public {
        uint256 aliceId = _request(ALICE, bytes32(uint256(1)));
        _schedule(BOB, bytes32(uint256(2))); uint256 bobId = _request(BOB, bytes32(uint256(2)));
        router.deliver(bobId, 9999); router.deliver(aliceId, 4000);
        uint256 bobToken = factory.completeClaim(bobId); uint256 aliceToken = factory.completeClaim(aliceId);
        assertEq(nft.ownerOf(bobToken), BOB); assertEq(nft.qualityOf(bobToken), 8);
        assertEq(nft.ownerOf(aliceToken), ALICE); assertEq(nft.qualityOf(aliceToken), 2);
        assertTrue(bytes(nft.tokenURI(bobToken)).length > 0);
    }
    function testRejectingSafeMintKeepsOriginalResultAndReservationThenCanRetry() public {
        NftClaimReceiver receiver = new NftClaimReceiver(factory); bytes32 nonce = bytes32(uint256(3)); _schedule(address(receiver), nonce);
        vm.deal(address(this), 7); uint256 id = receiver.request{value: 7}(nonce); router.deliver(id, 9999);
        vm.expectRevert(); factory.completeClaim(id);
        (, uint256 word, bool received, bool minted) = factory.results(id);
        assertEq(word, 9999); assertTrue(received); assertFalse(minted); assertEq(factory.reservedSupply(), 1); assertEq(nft.mintedSupply(), 0);
        receiver.accept(); uint256 tokenId = factory.completeClaim(id);
        assertEq(nft.ownerOf(tokenId), address(receiver)); assertEq(nft.qualityOf(tokenId), 8); assertTrue(receiver.reentryBlocked());
    }
    function testPauseRetainsCallbacksAndResultsButBlocksNewRequestsAndMinting() public {
        uint256 id = _request(ALICE, bytes32(uint256(1)));
        vm.prank(OWNER); factory.pause(); router.deliver(id, 9999);
        vm.expectRevert(); factory.completeClaim(id);
        _schedule(BOB, bytes32(uint256(2)));
        vm.prank(BOB); vm.expectRevert(); factory.requestClaim{value: 7}(bytes32(uint256(2)), 7);
        vm.prank(OWNER); factory.scheduleResume(); vm.prank(OWNER); vm.expectRevert(); factory.resume();
        vm.warp(factory.resumeAfter()); vm.prank(OWNER); factory.resume();
        uint256 tokenId = factory.completeClaim(id); assertEq(nft.qualityOf(tokenId), 8);
    }
    function testSupplyCapIncludesPendingReservations() public {
        uint256 cap = nft.MAX_SUPPLY(); assertEq(cap, 100_000);
        vm.store(address(nft), bytes32(uint256(10)), bytes32(cap - 1));
        uint256 id = _request(ALICE, bytes32(uint256(1)));
        _schedule(BOB, bytes32(uint256(2)));
        vm.prank(BOB); vm.expectRevert(); factory.requestClaim{value: 7}(bytes32(uint256(2)), 7);
        router.deliver(id, 9999); factory.completeClaim(id); assertEq(nft.mintedSupply(), cap);
        vm.prank(address(factory)); vm.expectRevert(); nft.mint(ALICE, 1);
    }
    function testAllEightGradesStakeWithTheirOwnWeightsAndConserveRevenue() public {
        uint16[8] memory odds = _odds(); uint16[8] memory weights = _weights(); uint256 slot; uint256 totalWeight;
        for (uint256 i; i < 8; ++i) {
            bytes32 nonce = bytes32(i + 100); _schedule(ALICE, nonce); uint256 request = _request(ALICE, nonce);
            router.deliver(request, slot); uint256 id = factory.completeClaim(request); slot += odds[i];
            vm.startPrank(ALICE); nft.approve(address(vault), id); vault.stake(_ids(id)); vm.stopPrank();
            (, uint16 storedWeight) = vault.stakeOf(id); assertEq(storedWeight, weights[i]); totalWeight += weights[i];
        }
        assertEq(vault.currentWeight(ALICE), totalWeight);
        vm.deal(address(this), 10 ether); (bool ok,) = address(factory).call{value: 10 ether}(""); assertTrue(ok);
        uint256 epoch = vault.currentEpoch(); vm.warp(vault.epochStart(epoch + 1));
        vm.prank(ALICE); vault.claimRewards(_ids(epoch), payable(ALICE));
        assertEq(vault.totalNftClaimed(), 5 ether); assertEq(vault.ownerCredit(), 5 ether); assertEq(address(vault).balance, 5 ether);
        vm.prank(OWNER); vault.claimOwner(); assertEq(address(vault).balance, 0);
        assertEq(vault.totalReceived(), vault.totalNftClaimed() + vault.totalOwnerClaimed());
    }
}
