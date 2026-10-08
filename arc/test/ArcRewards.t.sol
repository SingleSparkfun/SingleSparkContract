// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ArcToken} from "../src/ArcLaunch.sol";
import {ArcRewards} from "../src/ArcRewards.sol";

// Test-only reference for the cost of plain ERC-20 transfers.
contract RewardBatchBenchmark {
    function transferBatch(ArcToken token, address[] calldata recipients) external {
        for (uint256 i; i < recipients.length; i++) {
            token.transfer(recipients[i], 10e18);
        }
    }
}

contract ArcRewardsTest is Test {
    ArcToken token;
    ArcRewards rewards;

    function setUp() public {
        token = new ArcToken("Test", "TEST", address(this), "");
        rewards = new ArcRewards(token, address(this), address(this));
    }

    function fund(uint256 amount) private {
        token.transfer(address(rewards), amount);
        rewards.credit(amount);
    }

    function recipients(uint256 start, uint256 count) private pure returns (address[] memory list) {
        list = new address[](count);
        for (uint256 i; i < count; i++) {
            list[i] = address(uint160(start + i));
        }
    }

    function testMinimumFundingAndAuthorization() public {
        address[] memory list = recipients(100, 100);
        fund(1000e18 - 1);
        vm.expectRevert(ArcRewards.Invalid.selector);
        rewards.distribute(0, list);
        fund(1);
        vm.prank(address(0x777));
        vm.expectRevert(ArcRewards.Invalid.selector);
        rewards.distribute(0, list);
        address[] memory shortList = recipients(100, 99);
        vm.expectRevert(ArcRewards.Invalid.selector);
        rewards.distribute(0, shortList);
        uint256 supply = token.totalSupply();
        rewards.distribute(0, list);
        assertEq(rewards.available(), 0);
        assertEq(rewards.totalPaid(), 100);
        assertEq(token.totalSupply(), supply);
        for (uint256 i; i < list.length; i++) {
            assertEq(token.balanceOf(list[i]), 10e18);
        }
        token.transfer(address(rewards), 10e18);
        assertEq(rewards.available(), 0); // Uncredited donations are not a budget.
    }

    function testInvalidRecipientRollsBackWholeBatch() public {
        fund(1000e18);
        address[] memory list = recipients(100, 100);
        list[80] = list[79];
        vm.expectRevert(ArcRewards.Invalid.selector);
        rewards.distribute(0, list);
        assertEq(rewards.totalPaid(), 0);
        assertEq(rewards.available(), 1000e18);
        assertEq(token.balanceOf(list[0]), 0);
        list[80] = address(180);
        list[99] = address(rewards);
        vm.expectRevert(ArcRewards.Invalid.selector);
        rewards.distribute(0, list);
        assertEq(rewards.roundId(), 0);
    }

    function testNoHundredCapProgressReplayAndFailedGas() public {
        fund(5000e18);
        address[] memory first = recipients(100, 200);
        (bool ok,) = address(rewards).call{gas: 100_000}(abi.encodeCall(rewards.distribute, (0, first)));
        assertFalse(ok);
        assertEq(rewards.totalPaid(), 0);
        assertEq(rewards.available(), 5000e18);
        rewards.distribute(0, first);
        assertEq(rewards.totalPaid(), 200);
        assertEq(rewards.available(), 3000e18);
        vm.expectRevert(ArcRewards.Invalid.selector);
        rewards.distribute(0, first);
        rewards.distribute(200, recipients(300, 300));
        assertEq(rewards.totalPaid(), 500);
        assertEq(rewards.available(), 0);
        assertEq(rewards.roundId(), 2);
        assertEq(rewards.payoutCount(), 300);
        for (uint256 i = 100; i < 600; i++) {
            assertEq(token.balanceOf(address(uint160(i))), 10e18);
        }
    }

    function testDirectDistributionGas() public {
        fund(3000e18);
        address[] memory first = recipients(100, 100);
        uint256 beforeGas = gasleft();
        rewards.distribute(0, first);
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("100 direct recipients execution gas", used);
        assertLt(used, 4_000_000);
        address[] memory second = recipients(200, 200);
        beforeGas = gasleft();
        rewards.distribute(100, second);
        used = beforeGas - gasleft();
        emit log_named_uint("200 direct recipients execution gas", used);
        assertLt(used, 8_000_000);
    }
}
