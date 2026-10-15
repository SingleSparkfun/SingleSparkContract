// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HookFixture} from "./HookFixture.sol";
import {HookVault} from "../HookVault.sol";

/// Audit reproduction: equal plugin weights do not imply equal cumulative allocation.
contract HookAllocationAuditTest is HookFixture {
    function testAuditSplitIncomeChangesPluginAllocationDespiteEqualWeights() public {
        HookVault split = create(address(quote), policies(address(quote)));
        vm.prank(CALLER);
        HookVault bulk = HookVault(payable(factory.createVault(
            address(project), address(quote), policies(address(quote)))));

        for (uint256 i; i < 200; ++i) fund(split, 1);
        fund(bulk, 200);

        assertEq(split.received(), bulk.received());
        assertEq(split.platformBudget(), bulk.platformBudget());
        assertEq(split.claimBudget(), bulk.claimBudget());
        assertEq(split.budget(BURN), 0);
        assertEq(split.budget(PLATFORM), 0);
        assertEq(split.budget(DISTRIBUTE), 179);
        assertEq(bulk.budget(BURN), 59);
        assertEq(bulk.budget(PLATFORM), 59);
        assertEq(bulk.budget(DISTRIBUTE), 61);
        assertEq(quote.balanceOf(address(split)), quote.balanceOf(address(bulk)));
    }
}
