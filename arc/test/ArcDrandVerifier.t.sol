// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArcDrandVerifier} from "../src/ArcDrandVerifier.sol";

contract ArcDrandVerifierTest is Test {
    ArcDrandVerifier verifier = new ArcDrandVerifier();
    // Public evmnet fixture fetched from the official drand API, not a locally signed mock.
    // https://api.drand.sh/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3/public/20672105
    uint64 constant ROUND = 20_672_105;
    bytes constant SIGNATURE =
        hex"206a992570d27766a64c2f3d43819bb9fd8d08538be8c2824c8aa6982500c1eb167fed3afc1a80a56598b688905d910794a1ec6cf192d7f36c82809da589fa08";
    bytes32 constant RANDOMNESS = 0x8d080a855ef17ec84c53722095f460231e43e64ad3fff6b63b346e4dba30672a;

    function testPublicBeaconProofAndTampering() public {
        uint256 publishedAt = verifier.GENESIS() + (ROUND - 1) * verifier.PERIOD();
        vm.warp(publishedAt - 1);
        vm.expectRevert(ArcDrandVerifier.InvalidProof.selector);
        verifier.verify(ROUND, SIGNATURE);
        vm.warp(publishedAt + 3);
        assertEq(verifier.verify(ROUND, SIGNATURE), RANDOMNESS);

        vm.expectRevert(ArcDrandVerifier.InvalidProof.selector);
        verifier.verify(ROUND + 1, SIGNATURE);
        vm.expectRevert(ArcDrandVerifier.InvalidProof.selector);
        verifier.verify(0, SIGNATURE);
        vm.expectRevert(ArcDrandVerifier.InvalidProof.selector);
        verifier.verify(ROUND, abi.encodePacked(SIGNATURE, bytes1(0)));
        vm.expectRevert(ArcDrandVerifier.InvalidProof.selector);
        verifier.verify(ROUND, new bytes(64));
        bytes memory corrupted = SIGNATURE;
        corrupted[10] = corrupted[10] ^ bytes1(uint8(1));
        vm.expectRevert(ArcDrandVerifier.InvalidProof.selector);
        verifier.verify(ROUND, corrupted);
    }

    function testFutureRoundBoundariesAndOverflow() public {
        uint256 genesis = verifier.GENESIS();
        assertEq(verifier.roundAtOrAfter(0), 1);
        assertEq(verifier.roundAtOrAfter(genesis), 1);
        assertEq(verifier.roundAtOrAfter(genesis + 1), 2);
        assertEq(verifier.roundAtOrAfter(genesis + 3), 2);
        assertEq(verifier.roundAtOrAfter(genesis + 4), 3);
        assertEq(verifier.roundAtOrAfter(genesis + (ROUND - 1) * 3), ROUND);
        vm.expectRevert(ArcDrandVerifier.InvalidProof.selector);
        verifier.roundAtOrAfter(type(uint256).max);
    }
}
