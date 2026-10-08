// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {NativeRevenueDistributor} from "../src/NativeRevenueDistributor.sol";

contract RevenueTestToken is ERC20 {
    constructor() ERC20("Test", "TEST") { _mint(msg.sender, 3000 ether); }
}
contract NativeRevenueDistributorTest is Test {
    function testExactBatchAndCallerIsolation() public {
        NativeRevenueDistributor distributor = new NativeRevenueDistributor();
        RevenueTestToken token = new RevenueTestToken();
        address[] memory recipients = new address[](100);
        for (uint256 i; i < 100; ++i) recipients[i] = address(uint160(i + 100));
        token.approve(address(distributor), 1000 ether);
        vm.prank(address(999));
        vm.expectRevert();
        distributor.distribute(address(token), 0, recipients);
        distributor.distribute(address(token), 0, recipients);
        assertEq(token.balanceOf(address(this)), 2000 ether);
        assertEq(token.allowance(address(this), address(distributor)), 0);
        assertEq(distributor.totalPaid(address(this), address(token)), 100);
        for (uint256 i; i < 100; ++i) assertEq(token.balanceOf(recipients[i]), 10 ether);
        token.approve(address(distributor), 1000 ether);
        vm.expectRevert();
        distributor.distribute(address(token), 0, recipients);
        recipients[99] = recipients[98];
        vm.expectRevert();
        distributor.distribute(address(token), 100, recipients);
        assertEq(distributor.totalPaid(address(this), address(token)), 100);
        assertEq(token.balanceOf(address(this)), 2000 ether);
    }
}
