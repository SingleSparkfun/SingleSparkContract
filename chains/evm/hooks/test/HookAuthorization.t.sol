// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HookFixture} from "./HookFixture.sol";
import {HookVault} from "../HookVault.sol";
import {BuybackHook} from "../RevenueHooks.sol";
import {HookClaim, HookPolicy, IHookPlugin, IHookVault} from "../IHookProtocol.sol";

contract HookIncompletePlugin is IHookPlugin {
    function validate(address, address, HookPolicy calldata) external pure {}
    function execute(bytes calldata) external { IHookVault(msg.sender).pluginAcquire(); }
}

contract HookCrossVaultPlugin is IHookPlugin {
    IHookVault private immutable other;
    constructor(IHookVault other_) { other = other_; }
    function validate(address, address, HookPolicy calldata) external pure {}
    function execute(bytes calldata) external { other.pluginAcquire(); }
}

contract HookAuthorizationTest is HookFixture {
    function testClaimBindsCallerVaultChainAmountsDataAndNonce() public {
        vm.chainId(1);
        HookVault vault = create(address(quote), policies(address(quote))); fund(vault, 100e6);
        HookClaim memory c = request(vault, BURN, 1000, "");
        bytes memory sig = sign(vault, c);
        vm.expectRevert(); vault.claim(c, "", sig);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, hex"01", sig);
        c.amount = 1001;
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        c.amount = 1000;
        vm.chainId(2);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        vm.chainId(1);
        vm.prank(CALLER);
        HookVault other = HookVault(payable(factory.createVault(address(project), address(quote), policies(address(quote)))));
        fund(other, 100e6);
        vm.expectRevert(); vm.prank(CALLER); other.claim(c, "", sig);
        vm.prank(CALLER); vault.claim(c, "", sig);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
    }
    function testExpiredClaimsAndExcessRewardsRevertWithoutSpending() public {
        HookVault vault = create(address(quote), policies(address(quote))); fund(vault, 100e6);
        HookClaim memory c = request(vault, BURN, 8950, ""); c.reward = 51;
        bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        assertEq(vault.nonce(), 0); assertEq(vault.accounted(), 100e6);
        c.reward = 50; sig = sign(vault, c);
        vm.warp(c.deadline + 1);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
    }
    function testOnlineAuthorizerCannotWithdrawUpgradeOrSpendAnotherBudget() public {
        HookPolicy[] memory p = policies(address(quote)); p[0].maxSpend = 100;
        HookVault vault = create(address(quote), p); fund(vault, 100e6);
        vm.startPrank(vm.addr(SIGNER_KEY));
        vm.expectRevert(); factory.schedulePolicy(address(vault), p);
        vm.expectRevert(); factory.schedulePlugin(BURN, address(distributionPlugin));
        vm.expectRevert(); vault.pluginAcquire();
        vm.expectRevert(); vault.pluginBurn();
        vm.expectRevert(); vault.pluginDistribute(recipients(), 100);
        vm.stopPrank();
        HookClaim memory c = request(vault, BURN, 101, ""); bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        c = request(vault, BURN, 100, ""); execute(vault, c, "");
        assertEq(vault.budget(PLATFORM), 29833333);
        assertEq(vault.budget(DISTRIBUTE), 29833334);
        c = request(vault, PLATFORM, vault.budget(PLATFORM) + 1, ""); sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
    }
    function testPolicyWaitsFull48HoursAndPreservesExistingBudgets() public {
        HookPolicy[] memory p = policies(address(quote));
        HookVault vault = create(address(quote), p); fund(vault, 100e6);
        quote.mint(address(vault), 100e6);
        p[0].weight = 3; p[1].weight = 1; p[2].weight = 0;
        vm.prank(OWNER); bytes32 operation = factory.schedulePolicy(address(vault), p);
        uint256 when = factory.readyAt(operation);
        vm.warp(when - 1); vm.expectRevert(); factory.executePolicy(address(vault), p);
        vm.warp(when); factory.executePolicy(address(vault), p);
        assertEq(vault.budget(DISTRIBUTE), 2 * 29833334);
        fund(vault, 100e6);
        assertEq(vault.budget(DISTRIBUTE), 2 * 29833334);
        assertEq(vault.budget(BURN), 2 * 29833333 + 67125000);
        assertEq(vault.budget(PLATFORM), 2 * 29833333 + 22375000);
    }
    function testPauseDoesNotAlterAllocationAndResumeMustBeDelayed() public {
        HookPolicy[] memory p = policies(address(quote));
        HookVault vault = create(address(quote), p); fund(vault, 100e6);
        HookClaim memory c = request(vault, BURN, 100, ""); bytes memory sig = sign(vault, c);
        vm.prank(vm.addr(SIGNER_KEY)); factory.pauseVault(address(vault), BURN);
        fund(vault, 100e6); assertEq(vault.budget(BURN), 2 * 29833333);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        bytes32 operation = factory.scheduleResume(address(vault), BURN);
        vm.expectRevert(); factory.executeResume(address(vault), BURN);
        vm.warp(factory.readyAt(operation)); factory.executeResume(address(vault), BURN);
        execute(vault, request(vault, BURN, 100, ""), "");
    }
    function testFreshPauseInvalidatesPendingPolicyAndResume() public {
        HookPolicy[] memory p = policies(address(quote));
        HookVault vault = create(address(quote), p);
        bytes32 operation = factory.schedulePolicy(address(vault), p);
        factory.scheduleResume(address(vault), bytes32(0));
        factory.pauseVault(address(vault), bytes32(0));
        vm.warp(factory.readyAt(operation));
        vm.expectRevert(); factory.executePolicy(address(vault), p);
        vm.expectRevert(); factory.executeResume(address(vault), bytes32(0));
    }
    function testGlobalPauseKeepsDepositsAndFeeSettlementAvailable() public {
        HookVault vault = create(address(quote), policies(address(quote)));
        factory.pause(); fund(vault, 100e6); vault.settlePlatform();
        assertEq(quote.balanceOf(TREASURY), 10e6);
        HookClaim memory c = request(vault, BURN, 100, ""); bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        vm.expectRevert(); vm.prank(CALLER); factory.createVault(address(project), address(quote), policies(address(quote)));
        bytes32 operation = factory.scheduleGlobalResume();
        vm.expectRevert(); factory.executeGlobalResume();
        vm.warp(factory.readyAt(operation)); factory.executeGlobalResume();
        execute(vault, request(vault, BURN, 100, ""), "");
    }
    function testAllDisabledKeepsFundsUnallocatedUntilPolicyActivation() public {
        HookPolicy[] memory p = policies(address(quote));
        for (uint256 i; i < p.length; ++i) p[i].weight = 0;
        HookVault vault = create(address(quote), p); fund(vault, 100e6);
        assertEq(vault.unallocated(), 89500000); assertEq(vault.budget(BURN), 0);
        p[0].weight = 1; changePolicy(vault, p);
        assertEq(vault.unallocated(), 0); assertEq(vault.budget(BURN), 89500000);
        assertEq(vault.platformBudget(), 10e6); assertEq(vault.claimBudget(), 500000);
    }
    function testRegistrationCodePinsAndIncompleteExecution() public {
        HookVault vault = create(address(quote), policies(address(quote))); fund(vault, 100e6);
        HookIncompletePlugin next = new HookIncompletePlugin();
        bytes32 operation = factory.schedulePlugin(BURN, address(next));
        vm.expectRevert(); factory.executePlugin(BURN, address(next));
        vm.warp(factory.readyAt(operation)); factory.executePlugin(BURN, address(next));
        HookClaim memory c = request(vault, BURN, 100, ""); bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        assertEq(vault.accounted(), 100e6); assertEq(vault.nonce(), 0);
        vm.etch(address(next), hex"00");
        vm.expectRevert(); factory.plugin(BURN);
    }
    function testRegisteredPluginCannotConsumeAnotherProjectsAllowance() public {
        HookVault vault = create(address(quote), policies(address(quote))); fund(vault, 100e6);
        vm.prank(CALLER);
        HookVault other = HookVault(payable(factory.createVault(address(project), address(quote), policies(address(quote)))));
        fund(other, 100e6);
        HookCrossVaultPlugin next = new HookCrossVaultPlugin(IHookVault(address(other)));
        bytes32 operation = factory.schedulePlugin(BURN, address(next));
        vm.warp(factory.readyAt(operation)); factory.executePlugin(BURN, address(next));
        HookClaim memory c = request(vault, BURN, 100, ""); bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        assertEq(other.accounted(), 100e6); assertEq(vault.accounted(), 100e6);
    }
    function testPluginReplacementInvalidatesOldClaimsAndKeepsLedger() public {
        HookVault vault = create(address(quote), policies(address(quote))); fund(vault, 100e6);
        BuybackHook next = new BuybackHook();
        bytes32 operation = factory.schedulePlugin(BURN, address(next));
        vm.warp(factory.readyAt(operation));
        HookClaim memory c = request(vault, BURN, 100, ""); bytes memory sig = sign(vault, c);
        factory.executePlugin(BURN, address(next));
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        assertEq(vault.budget(BURN), 29833333);
        execute(vault, request(vault, BURN, 100, ""), "");
    }
    function testPayoutDeduplicationSurvivesPolicyDisableAndReenable() public {
        HookPolicy[] memory p = policies(address(quote));
        HookVault vault = create(address(quote), p); fund(vault, 100e6);
        execute(vault, request(vault, DISTRIBUTE, 1000, ""), "");
        bytes memory data = abi.encode(recipients());
        execute(vault, request(vault, DISTRIBUTE, 0, data), data);
        p[2].weight = 0; changePolicy(vault, p);
        p[2].weight = 1; changePolicy(vault, p);
        HookClaim memory c = request(vault, DISTRIBUTE, 0, data); bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, data, sig);
        assertTrue(vault.paid(address(0x4000)));
    }
    function testAnotherDistributionPluginCannotPayTheSameRecipientAgain() public {
        bytes32 anotherId = keccak256("another-distribution");
        bytes32 operation = factory.schedulePlugin(anotherId, address(distributionPlugin));
        vm.warp(factory.readyAt(operation)); factory.executePlugin(anotherId, address(distributionPlugin));
        HookPolicy[] memory p = policies(address(quote));
        p[0] = HookPolicy(anotherId, 1, address(quote), address(0), type(uint128).max,
            "", abi.encode(uint256(10), uint256(2)));
        HookVault vault = create(address(quote), p); fund(vault, 100e6);
        execute(vault, request(vault, DISTRIBUTE, 1000, ""), "");
        execute(vault, request(vault, anotherId, 1000, ""), "");
        bytes memory data = abi.encode(recipients());
        execute(vault, request(vault, DISTRIBUTE, 0, data), data);
        HookClaim memory c = request(vault, anotherId, 0, data); bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, data, sig);
        assertEq(vault.inventory(anotherId), 1000);
    }
}
