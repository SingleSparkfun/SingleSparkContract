// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {PlatformNftSalesVault} from "../PlatformNftSalesVault.sol";

contract PlatformNftSalesVaultTest is Test {
    PlatformNftSalesVault vault;
    address constant OWNER = address(0x1000);
    address constant RECIPIENT = address(0x2000);
    function setUp() public {
        vm.chainId(46630); vm.warp(1_800_000_000);
        vault = new PlatformNftSalesVault(OWNER); vm.deal(address(this), 2 ether);
        (bool ok,) = address(vault).call{value: 2 ether}(""); assertTrue(ok);
    }
    function testOnlyReviewedOwnerCanQueueAndAnyoneExecutesExactPaymentAfter48Hours() public {
        vm.expectRevert(); vault.schedulePayout(RECIPIENT, 1 ether);
        vm.prank(OWNER); vault.schedulePayout(RECIPIENT, 1 ether);
        vm.warp(vault.payoutAfter()-1); vm.expectRevert(); vault.executePayout();
        vm.warp(vault.payoutAfter()); vault.executePayout();
        assertEq(RECIPIENT.balance, 1 ether); assertEq(address(vault).balance, 1 ether);
        assertEq(vault.totalReceived(), 2 ether); vm.expectRevert(); vault.executePayout();
    }
    function testReplacementRestartsDelayAndCancellationStopsPayment() public {
        vm.prank(OWNER); vault.schedulePayout(RECIPIENT, 1 ether);
        uint256 first = vault.payoutAfter(); vm.warp(first-1);
        vm.prank(OWNER); vault.schedulePayout(RECIPIENT, 2 ether);
        assertEq(vault.payoutAfter(), block.timestamp+48 hours);
        vm.warp(first); vm.expectRevert(); vault.executePayout();
        vm.prank(OWNER); vault.cancelPayout(); vm.warp(block.timestamp+48 hours);
        vm.expectRevert(); vault.executePayout(); assertEq(address(vault).balance, 2 ether);
    }
}
