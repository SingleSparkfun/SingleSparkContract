// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ArgusRevenueVaultTest} from "./ArgusRevenueVault.t.sol";
import {ArgusRevenueVault} from "../ArgusRevenueVault.sol";

contract ArgusClaimTest is ArgusRevenueVaultTest {
    address constant CALLER = address(0xc001);
    function testDigestMatchesBackendAndWalletEip712Vector() public {
        vm.chainId(5042002);
        vm.etch(address(0x1009), address(vault).code);
        ArgusRevenueVault.Claim memory c = ArgusRevenueVault.Claim(address(1),5,address(2),0,0,1000,7,3,address(3),9,keccak256(""));
        assertEq(ArgusRevenueVault(payable(address(0x1009))).claimDigest(c), 0xacf43ec01366e98811f266fbf8e892f4b335665de05e0c3707e24897f71a3fea);
    }
    function request(uint8 bucket, uint256 amount, address[] memory recipients) internal view returns (ArgusRevenueVault.Claim memory c) {
        c = ArgusRevenueVault.Claim(CALLER, bucket, bucket == 1 ? platform : token, amount,
            bucket == 5 ? 0 : 1, block.timestamp + 30, vault.nonce(), factory.revision(), factory.implementation(),
            bucket == 2 || bucket == 5 ? 0 : vault.claimRewardLimit(amount), keccak256(abi.encode(recipients)));
    }
    function signature(ArgusRevenueVault.Claim memory c) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EXECUTOR_KEY, vault.claimDigest(c));
        return abi.encodePacked(r, s, v);
    }
    function testClaimPaysOnlySuccessfulCallerFromSeparateBudget() public {
        fund(100e6);
        address[] memory empty = new address[](0);
        ArgusRevenueVault.Claim memory c = request(0, 80e6, empty);
        bytes memory sig = signature(c);
        vm.prank(CALLER); vault.claim(c, empty, sig);
        assertEq(quote.balanceOf(CALLER), c.reward);
        assertEq(vault.totalClaimPaid(), c.reward);
        assertEq(vault.claimBudget(), 500000 - c.reward);
        assertEq(vault.budgets(4), 10e6);
        assertEq(vault.accounted(), quote.balanceOf(address(vault)));
        vm.prank(CALLER); vm.expectRevert(); vault.claim(c, empty, sig);
    }
    function testDisabledAndPausedPluginsStillCollectAndSettleWithoutPayingBounty() public {
        for (uint8 selected; selected <= 7; selected += 7) {
            (ArgusRevenueVault v,) = launch(OWNER, bytes32(uint256(300 + selected)), selected);
            vm.prank(EXECUTOR); factory.pause(address(v), 7);
            quote.mint(address(v), 100e6);
            vm.prank(CALLER); v.collect();
            assertEq(v.received(), 100e6);
            vm.prank(CALLER); v.settle(true, 10e6);
            assertEq(v.budgets(4), 0);
            assertEq(v.budgets(0), 80e6);
            assertEq(v.budgets(1), 4e6);
            assertEq(v.budgets(2), 2e6);
            assertEq(v.budgets(3), 3500000);
            assertEq(v.claimBudget(), 500000);
            assertEq(v.totalClaimPaid(), 0);
            assertEq(v.accounted(), quote.balanceOf(address(v)));
        }
        assertEq(quote.balanceOf(router.operations()), 20e6);
        assertEq(quote.balanceOf(CALLER), 0);
    }
    function testClaimRejectsWrongCallerChainVaultAndTampering() public {
        fund(100e6);
        address[] memory empty = new address[](0);
        ArgusRevenueVault.Claim memory c = request(0, 1e6, empty);
        bytes memory sig = signature(c);
        vm.expectRevert(); vault.claim(c, empty, sig);
        vm.chainId(5042002); vm.prank(CALLER); vm.expectRevert(); vault.claim(c, empty, sig);
        vm.chainId(5042);
        (ArgusRevenueVault other,) = launch(OWNER, bytes32(uint256(88)), 7);
        quote.mint(address(other), 100e6); other.sync();
        vm.prank(CALLER); vm.expectRevert(); other.claim(c, empty, sig);
        c.amount++;
        vm.prank(CALLER); vm.expectRevert(); vault.claim(c, empty, sig);
        assertEq(vault.nonce(), 0); assertEq(vault.claimBudget(), 500000);
    }
    function testClaimFailureAndExcessRewardRollBackAllBalances() public {
        fund(100e6);
        address[] memory empty = new address[](0);
        ArgusRevenueVault.Claim memory c = request(0, 1e6, empty);
        c.reward++;
        bytes memory sig = signature(c);
        vm.prank(CALLER); vm.expectRevert(); vault.claim(c, empty, sig);
        c.reward = 0; c.minimum = type(uint256).max; sig = signature(c);
        vm.prank(CALLER); vm.expectRevert(); vault.claim(c, empty, sig);
        assertEq(vault.budgets(0), 80e6); assertEq(vault.claimBudget(), 500000);
        assertEq(vault.nonce(), 0); assertEq(quote.balanceOf(CALLER), 0);
    }
    function testClaimExpiryAndEmergencyPauseInvalidateAuthorization() public {
        fund(100e6);
        address[] memory empty = new address[](0);
        ArgusRevenueVault.Claim memory c = request(0, 1e6, empty);
        bytes memory sig = signature(c);
        vm.warp(block.timestamp + 31);
        vm.prank(CALLER); vm.expectRevert(); vault.claim(c, empty, sig);
        c = request(0, 1e6, empty); sig = signature(c);
        vm.prank(EXECUTOR); factory.pause(address(vault), 4);
        vm.prank(CALLER); vm.expectRevert(); vault.claim(c, empty, sig);
    }
    function testInventoryRewardOnlyPaysAfterDistributionAndCannotReplay() public {
        fund(5000e6);
        address[] memory empty = new address[](0);
        ArgusRevenueVault.Claim memory c = request(2, 100e6, empty);
        bytes memory sig = signature(c);
        vm.prank(CALLER); vault.claim(c, empty, sig);
        assertEq(quote.balanceOf(CALLER), 0);
        uint256 earned = vault.distributionClaimReward();
        assertGt(earned, 0);
        address[] memory recipients = new address[](100);
        for (uint256 i; i < 100; ++i) recipients[i] = address(uint160(0x9000 + i));
        c = request(5, 0, recipients); c.reward = earned; sig = signature(c);
        recipients[99] = address(0x9999);
        vm.prank(CALLER); vm.expectRevert(); vault.claim(c, recipients, sig);
        recipients[99] = address(0x9000 + 99);
        vm.prank(CALLER); vault.claim(c, recipients, sig);
        assertEq(quote.balanceOf(CALLER), earned); assertEq(vault.distributionClaimReward(), 0);
        assertEq(vault.totalPaid(), 100);
        vm.prank(CALLER); vm.expectRevert(); vault.claim(c, recipients, sig);
    }
    function testSixWayPolicyWaitsAndPreservesPriorIncome() public {
        quote.mint(address(vault), 100e6);
        uint16[6] memory next = [uint16(7900), 400, 200, 350, 1100, 50];
        vm.prank(ADMIN); factory.scheduleRevenuePolicy(address(vault), 7, next);
        vm.expectRevert(); factory.executeRevenuePolicy(address(vault), 7, next);
        vm.warp(factory.readyAt()); factory.executeRevenuePolicy(address(vault), 7, next);
        assertEq(vault.budgets(0), 80e6); assertEq(vault.budgets(4), 10e6);
        fund(100e6);
        assertEq(vault.budgets(0), 159e6); assertEq(vault.budgets(4), 21e6);
        assertEq(vault.claimBudget(), 1e6);
        assertEq(factory.DELAY(), 48 hours);
    }
    function testPendingUpgradeMetadataClearsOnCancellationAndExecution() public {
        address next = address(new ArgusRevenueVault());
        vm.prank(ADMIN); factory.scheduleUpgrade(next);
        (bytes32 op,uint8 kind,address target,bytes32 code,uint256 ready) = factory.pendingOperation();
        assertEq(op, factory.pending()); assertEq(kind, 2); assertEq(target, next);
        assertEq(code, next.codehash); assertEq(ready, block.timestamp + 48 hours);
        vm.prank(ADMIN); factory.cancel();
        assertEq(factory.pendingTarget(), address(0));
        vm.prank(ADMIN); factory.scheduleUpgrade(next);
        vm.warp(factory.readyAt()); factory.executeUpgrade(next);
        assertEq(factory.pendingCodeHash(), bytes32(0));
    }
}
