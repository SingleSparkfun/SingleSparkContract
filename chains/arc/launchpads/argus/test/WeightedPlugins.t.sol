// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ArgusClaimTest} from "./ArgusClaim.t.sol";
import {ArgusRevenueVault} from "../ArgusRevenueVault.sol";
import {ArgusVaultFactory} from "../ArgusVaultFactory.sol";
import {ArgusCustodyRouter} from "../ArgusCustodyRouter.sol";
import {IRevenuePlugin, IRevenuePluginVault, BuybackBurnPlugin} from "../RevenuePlugins.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract WrongCompletionPlugin is IRevenuePlugin {
    function kind() external pure returns (uint8) { return 0; }
    function execute(bool, address[] calldata) external { IRevenuePluginVault(msg.sender).pluginSwap(); }
}

contract WeightedPluginsTest is ArgusClaimTest {
    function weighted(uint8 selected) internal {
        factory = new ArgusVaultFactory(ArgusCustodyRouter(address(router)), ADMIN, EXECUTOR, address(new ArgusRevenueVault()));
        (vault, token) = launch(OWNER, bytes32(uint256(501)), selected);
    }
    function setWeights(uint8 selected, uint16[3] memory relative) internal {
        vm.prank(ADMIN); factory.schedulePluginWeights(address(vault), selected, relative);
        vm.warp(factory.readyAt()); factory.executePluginWeights(address(vault), selected, relative);
    }
    function testWeightedEqualIncomeSeparatesFeesAndUsesPluginContracts() public {
        weighted(7); fund(100e6);
        assertEq(vault.budgets(4), 10e6); assertEq(vault.claimBudget(), 500000);
        assertEq(vault.budgets(0), 29833333); assertEq(vault.budgets(1), 29833333); assertEq(vault.budgets(2), 29833334);
        assertEq(vault.budgets(3), 0);
        assertGt(factory.revenuePlugin(0).code.length, 0);
        assertTrue(factory.revenuePlugin(0) != factory.revenuePlugin(1));
        address[] memory empty = new address[](0);
        ArgusRevenueVault.Claim memory c = request(0, 10e6, empty); bytes memory sig = signature(c);
        vm.prank(CALLER); vault.claim(c, empty, sig);
        assertEq(IERC20(token).balanceOf(address(0xdead)), 100e18);
        assertEq(quote.balanceOf(CALLER), c.reward);
        assertEq(vault.budgets(1), 29833333); assertEq(vault.budgets(2), 29833334);
        assertEq(vault.accounted(), quote.balanceOf(address(vault)));
    }
    function testWeightedDisabledPluginsRedistributeOnlyNewIncomeAndPauseDoesNot() public {
        weighted(7); fund(100e6);
        uint256 oldDistribution = vault.budgets(2);
        setWeights(5, [uint16(1),1,1]);
        fund(100e6);
        assertEq(vault.budgets(0), 29833333 + 44750000);
        assertEq(vault.budgets(1), 29833333 + 44750000);
        assertEq(vault.budgets(2), oldDistribution);
        vm.prank(EXECUTOR); factory.pause(address(vault), 1);
        fund(100e6);
        assertEq(vault.budgets(0), 29833333 + 89500000);
        uint256 nextNonce = vault.nonce();
        vm.prank(EXECUTOR); vm.expectRevert(); vault.buy(0, 1e6, 1, block.timestamp + 30, nextNonce);
    }
    function testWeightedAllOffCollectsAndSettlesThenAllocatesOnlyWaitingFunds() public {
        weighted(0);
        quote.mint(address(vault), 100e6); vm.prank(CALLER); vault.collect();
        assertEq(vault.unallocatedPluginBudget(), 89500000);
        vm.prank(CALLER); vault.settle(true, 10e6);
        assertEq(vault.claimBudget(), 500000);
        setWeights(3, [uint16(3),1,1]);
        assertEq(vault.unallocatedPluginBudget(), 0);
        assertEq(vault.budgets(0), 67125000); assertEq(vault.budgets(1), 0); assertEq(vault.budgets(2), 22375000);
        assertEq(quote.balanceOf(CALLER), 0);
    }
    function testWeightedChangesWaitAndAccountUnsyncedIncomeBeforeNewWeights() public {
        weighted(7); quote.mint(address(vault), 100e6);
        uint16[3] memory relative = [uint16(8),1,1];
        vm.prank(ADMIN); factory.schedulePluginWeights(address(vault), 7, relative);
        vm.expectRevert(); factory.executePluginWeights(address(vault), 7, relative);
        vm.warp(factory.readyAt()); factory.executePluginWeights(address(vault), 7, relative);
        assertEq(vault.budgets(0), 29833333);
        fund(100e6); assertEq(vault.budgets(0), 29833333 + 71600000);
        assertEq(vault.budgets(1), 29833333 + 8950000);
        vm.prank(ADMIN); vm.expectRevert(); factory.schedulePluginWeights(address(vault), 7, [uint16(0),1,1]);
    }
    function testWeightedCallbacksAndIncompletePluginCannotTakeFunds() public {
        weighted(7); fund(100e6);
        vm.expectRevert(); vault.pluginSwap();
        vm.expectRevert(); vault.pluginBurn(1);
        vm.prank(factory.revenuePlugin(0)); vm.expectRevert(); vault.pluginSwap();
        address broken = address(new WrongCompletionPlugin());
        vm.prank(ADMIN); factory.schedulePlugin(0, broken);
        vm.expectRevert(); factory.executePlugin(0, broken);
        vm.warp(factory.readyAt()); factory.executePlugin(0, broken);
        uint256 balance = vault.budgets(0);
        vm.prank(EXECUTOR); vm.expectRevert(); vault.buy(0, 1e6, 1, block.timestamp + 30, 0);
        assertEq(vault.budgets(0), balance); assertEq(vault.nonce(), 0);
        assertEq(vault.accounted(), 100e6); assertEq(quote.allowance(address(vault),address(router)), 0);
    }
    function testWeightedPluginReplacementInvalidatesOldClaimAndBindsCode() public {
        weighted(7); fund(100e6);
        address[] memory empty = new address[](0);
        ArgusRevenueVault.Claim memory c = request(0, 1e6, empty);
        address next = address(new BuybackBurnPlugin());
        vm.prank(ADMIN); factory.schedulePlugin(0, next);
        vm.warp(factory.readyAt()); c.deadline = block.timestamp + 30; bytes memory sig = signature(c);
        factory.executePlugin(0, next);
        vm.prank(CALLER); vm.expectRevert(); vault.claim(c, empty, sig);
        vm.etch(next, hex"60006000fd");
        vm.prank(EXECUTOR); vm.expectRevert(); vault.buy(0, 1e6, 1, block.timestamp + 30, 0);
    }
    function testWeightedDistributionPaysOnlyAfterInventoryReachesRecipients() public {
        weighted(2); fund(100e6);
        address[] memory empty = new address[](0);
        ArgusRevenueVault.Claim memory c = request(2, 89e6, empty); bytes memory sig = signature(c);
        vm.prank(CALLER); vault.claim(c, empty, sig);
        assertEq(quote.balanceOf(CALLER), 0);
        // Mock router issues ten tokens per USDC; fund enough for the existing 100-recipient batch.
        fund(20e6); c = request(2, 11e6, empty); sig = signature(c);
        vm.prank(CALLER); vault.claim(c, empty, sig);
        address[] memory recipients = new address[](100);
        for (uint256 i; i < 100; ++i) recipients[i] = address(uint160(0x9000 + i));
        c = request(5, 0, recipients); c.reward = vault.distributionClaimReward(); sig = signature(c);
        vm.prank(CALLER); vault.claim(c, recipients, sig);
        assertEq(quote.balanceOf(CALLER), c.reward); assertEq(vault.totalPaid(), 100);
        vm.prank(CALLER); vm.expectRevert(); vault.claim(c, recipients, sig);
    }
    function testFuzzWeightedAccountingConservesEveryUnit(uint96 amount, uint8 mask) public {
        weighted(mask % 8); fund(amount);
        uint256 sum = vault.claimBudget() + vault.unallocatedPluginBudget() + vault.roundingReserve();
        for (uint256 i; i < 5; ++i) sum += vault.budgets(i);
        assertEq(sum, amount);
    }
    function testPermissionlessSettlementCannotInvalidateOrReplayAClaim() public {
        weighted(7); fund(100e6);
        address[] memory empty = new address[](0);
        ArgusRevenueVault.Claim memory c = request(0, 1e6, empty); bytes memory sig = signature(c);
        vm.startPrank(address(0xbad));
        vault.settle(true, 1); vault.settle(true, 1);
        vm.stopPrank();
        assertEq(vault.nonce(), c.nonce);
        vm.prank(CALLER); vault.claim(c, empty, sig);
        assertEq(vault.nonce(), c.nonce + 1);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, empty, sig);
        assertEq(quote.balanceOf(router.operations()), 2);
        assertEq(vault.accounted(), quote.balanceOf(address(vault)));
    }
    function testOneUnitIncomeCannotAvoidFeesOrSpendRoundingBacking() public {
        weighted(1);
        for (uint256 i; i < 199; ++i) fund(1);
        assertEq(vault.budgets(4), 19); assertEq(vault.claimBudget(), 0);
        assertEq(vault.budgets(0), 178); assertEq(vault.roundingReserve(), 2);
        vault.settle(true, 19); buy(0, 178);
        assertEq(quote.balanceOf(address(vault)), 2);
        fund(1);
        assertEq(vault.budgets(4), 1); assertEq(vault.claimBudget(), 1);
        assertEq(vault.budgets(0), 1); assertEq(vault.roundingReserve(), 0);
        assertEq(vault.accounted(), 3);
    }
    function testFullWidthIncomeDoesNotOverflowWeightedAllocation() public {
        weighted(7); fund(type(uint256).max);
        assertEq(vault.budgets(4), type(uint256).max / 10);
        assertEq(vault.claimBudget(), type(uint256).max / 200);
        uint256 sum = vault.claimBudget() + vault.roundingReserve();
        for (uint256 i; i < 5; ++i) sum += vault.budgets(i);
        assertEq(sum, type(uint256).max);
        vault.sync(); assertEq(vault.received(), type(uint256).max);
    }
    function testFuzzSplitIncomePreservesFeesAndAllBuckets(uint96 first, uint96 second, uint8 mask) public {
        weighted(mask % 8); fund(first);
        uint256 settled = vault.budgets(4);
        if (settled != 0) vault.settle(true, settled);
        fund(second);
        uint256 total = uint256(first) + second;
        assertEq(vault.budgets(4) + settled, total * 1000 / 10000);
        assertEq(vault.claimBudget(), total * 50 / 10000);
        uint256 sum = settled + vault.claimBudget() + vault.unallocatedPluginBudget() + vault.roundingReserve();
        for (uint256 i; i < 5; ++i) sum += vault.budgets(i);
        assertEq(sum, total); assertEq(vault.accounted(), quote.balanceOf(address(vault)));
    }
}
