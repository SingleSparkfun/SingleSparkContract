// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ArgusRevenueVaultTest} from "./ArgusRevenueVault.t.sol";
import {ArgusRevenueVault} from "../ArgusRevenueVault.sol";
import {ArgusVaultFactory} from "../ArgusVaultFactory.sol";
import {ArgusCustodyRouter} from "../ArgusCustodyRouter.sol";

contract AuditWeightedRoundingTest is ArgusRevenueVaultTest {
    function testSplitIncomeSkewsEqualPluginWeights() public {
        factory = new ArgusVaultFactory(ArgusCustodyRouter(address(router)), ADMIN, EXECUTOR, address(new ArgusRevenueVault()));
        (ArgusRevenueVault whole,) = launch(OWNER, bytes32(uint256(601)), 7);
        (ArgusRevenueVault split,) = launch(OWNER, bytes32(uint256(602)), 7);

        quote.mint(address(whole), 200);
        whole.sync();
        for (uint256 i; i < 200; ++i) {
            quote.mint(address(split), 1);
            vm.prank(address(0xbad));
            split.sync();
        }

        assertEq(whole.received(), split.received());
        assertEq(whole.budgets(4), split.budgets(4));
        assertEq(whole.claimBudget(), split.claimBudget());
        assertEq(whole.budgets(0), 59);
        assertEq(whole.budgets(1), 59);
        assertEq(whole.budgets(2), 61);
        assertEq(split.budgets(0), 0);
        assertEq(split.budgets(1), 0);
        assertEq(split.budgets(2), 179);
        assertEq(whole.roundingReserve(), 0);
        assertEq(split.roundingReserve(), 0);
    }
}
