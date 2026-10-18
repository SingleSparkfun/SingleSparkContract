// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestPonsLaunch} from "./PonsVaultFactory.t.sol";
import {PonsDelayedVaultFactory} from "../PonsDelayedVaultFactory.sol";
import {PonsDelayedVault} from "../PonsDelayedVault.sol";
import {IPonsLaunch} from "../IPonsLaunch.sol";
import {DistributionHook} from "../../../../evm/hooks/RevenueHooks.sol";
import {HookClaim, HookPolicy} from "../../../../evm/hooks/IHookProtocol.sol";

contract PonsDelayedActivationTest is Test {
    uint256 constant KEY = 0x123456;
    address constant DEV = address(0x1234);
    address constant CALLER = address(0x5678);
    bytes32 constant FIRST = keccak256("distribution@1");
    bytes32 constant SECOND = keccak256("distribution-fixture@1");
    PonsDelayedVaultFactory factory;
    PonsDelayedVault vault;

    function setUp() public {
        vm.chainId(46630);
        TestPonsLaunch source = new TestPonsLaunch();
        factory = new PonsDelayedVaultFactory(address(this), vm.addr(KEY), address(0x9999), IPonsLaunch(address(source)));
        DistributionHook plugin = new DistributionHook();
        factory.schedulePlugin(FIRST, address(plugin)); factory.schedulePlugin(SECOND, address(plugin));
        vm.warp(block.timestamp + factory.DELAY());
        factory.executePlugin(FIRST, address(plugin)); factory.executePlugin(SECOND, address(plugin));
        IPonsLaunch.TokenParams memory draft;
        draft.name = "Delayed plugins"; draft.symbol = "DELAY"; draft.expectedEconomics = source.ECONOMICS();
        vm.prank(DEV); (,,address deployed) = factory.launch(draft);
        vault = PonsDelayedVault(payable(deployed));
        vm.deal(address(this), 1 ether);
    }
    function selection(uint32 first, uint32 second) internal pure returns (HookPolicy[] memory selected) {
        selected = new HookPolicy[](2);
        selected[0] = HookPolicy(FIRST, first, address(0), address(0), 100000, "", abi.encode(uint256(10), uint256(2)));
        selected[1] = HookPolicy(SECOND, second, address(0), address(0), 100000, "", abi.encode(uint256(10), uint256(2)));
    }
    function activate(uint32 first, uint32 second) internal returns (bytes32 operation, uint256 when) {
        vm.prank(DEV); operation = factory.activatePlugins(address(vault), selection(first, second));
        when = factory.readyAt(operation);
    }
    function request(uint256 amount) internal view returns (HookClaim memory) {
        return HookClaim(CALLER, FIRST, amount, 1, 0, block.timestamp + 120, vault.nonce(), vault.revision(), factory.revision(), keccak256(""));
    }
    function signature(HookClaim memory claim) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, vault.claimDigest(claim));
        return abi.encodePacked(r, s, v);
    }
    function testDevActivatesOnceAndTimeMakesPoliciesBudgetsAndRevisionEffectiveWithoutExecutionTransaction() public {
        vault.deposit{value:100000}(100000);
        uint256 initial = vault.revision();
        (bytes32 operation,uint256 when) = activate(1,2);
        assertTrue(factory.automaticPolicyActivation()); assertEq(factory.DELAY(), 48 hours);
        assertEq(when, block.timestamp + factory.DELAY()); assertEq(vault.revision(), initial + 1);
        vm.warp(when - 1);
        assertEq(vault.policy(FIRST).weight, 0); assertEq(vault.budget(FIRST), 0); assertEq(vault.unallocated(), 89500);
        vm.warp(when);
        assertEq(vault.policy(FIRST).weight, 1); assertEq(vault.policy(SECOND).weight, 2);
        assertEq(vault.revision(), initial + 2); assertEq(vault.budget(FIRST), 29833); assertEq(vault.budget(SECOND), 59667);
        assertEq(vault.unallocated(), 0); assertEq(vault.pluginIds().length, 2);
        assertEq(factory.readyAt(operation), when); assertEq(vault.nonce(), 0);
        HookClaim memory claim = request(1000); bytes memory sig = signature(claim);
        vm.prank(CALLER); vault.claim(claim, "", sig);
        assertEq(vault.revision(), initial + 2); assertEq(factory.readyAt(operation), 0);
        assertEq(vault.budget(FIRST), 28833); assertEq(vault.budget(SECOND), 59667); assertEq(vault.inventory(FIRST), 1000);
        assertEq(vault.nonce(), 1); assertEq(DEV.balance, 0); assertEq(CALLER.balance, 0);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(claim, "", sig);
    }
    function testOnlyDevCanQueueAndNoOldExecutionEntryCanBypassTheDeadline() public {
        HookPolicy[] memory selected = selection(1,2);
        address token = vault.projectToken();
        vm.expectRevert(); vm.prank(CALLER); factory.createVault(token, address(0), selected);
        vm.expectRevert(); factory.activatePlugins(address(vault), selected);
        vm.expectRevert(); vm.prank(CALLER); factory.activatePlugins(address(vault), selected);
        vm.expectRevert(); vm.prank(DEV); vault.queueActivation(bytes32(uint256(1)), block.timestamp + 1, selected);
        vm.expectRevert(); factory.completeActivation(bytes32(uint256(1)));
        (bytes32 operation,uint256 when) = activate(1,2);
        vm.expectRevert(); vm.prank(DEV); factory.activatePlugins(address(vault), selected);
        vm.expectRevert(); vm.prank(DEV); factory.schedulePolicy(address(vault), selected);
        vm.expectRevert(); factory.executePolicy(address(vault), selected);
        assertEq(factory.readyAt(operation), when); assertEq(vault.policy(FIRST).weight, 0);
    }
    function testAdminCancellationBeforeDeadlineCannotCancelAlreadyEffectivePolicies() public {
        (bytes32 operation,uint256 when) = activate(1,2);
        vm.expectRevert(); vm.prank(DEV); factory.cancel(operation);
        factory.cancel(operation); assertEq(factory.readyAt(operation), 0);
        vm.warp(when); assertEq(vault.policy(FIRST).weight, 0);
        (operation,when) = activate(1,2); vm.warp(when);
        vm.expectRevert(); factory.cancel(operation);
        assertEq(vault.policy(FIRST).weight, 1);
    }
    function testSignedClaimsFromBeforeTheDeadlineCannotCrossTheEffectiveRevision() public {
        vault.deposit{value:100000}(100000);
        (,uint256 when) = activate(1,2); vm.warp(when - 1);
        HookClaim memory old = request(1000); bytes memory sig = signature(old);
        vm.warp(when); vm.expectRevert(); vm.prank(CALLER); vault.claim(old, "", sig);
        assertEq(vault.nonce(), 0); assertEq(vault.budget(FIRST), 29833);
    }
    function testWeightChangesPreserveExistingBudgetsAndPluginPauseWhileOnlyNewIncomeUsesNewWeights() public {
        vault.deposit{value:100000}(100000);
        (,uint256 when) = activate(1,2); vm.warp(when); vault.sync();
        vm.prank(DEV); factory.pauseVault(address(vault), FIRST);
        (,when) = activate(0,1); vm.warp(when);
        assertEq(vault.policy(FIRST).weight, 0); assertEq(vault.budget(FIRST), 29833); assertEq(vault.budget(SECOND), 59667);
        vault.deposit{value:100000}(100000);
        assertTrue(vault.pluginPaused(FIRST)); assertEq(vault.budget(FIRST), 29833); assertEq(vault.budget(SECOND), 149167);
        assertEq(vault.platformBudget(), 20000); assertEq(vault.claimBudget(), 1000);
        (,when) = activate(0,0); vm.warp(when); vault.deposit{value:100000}(100000);
        assertEq(vault.unallocated(), 89500); assertEq(vault.budget(FIRST), 29833); assertEq(vault.budget(SECOND), 149167);
    }
    function testRegistryCodeChangeCannotBlockActivationOrEmergencyPause() public {
        vault.deposit{value:100000}(100000);
        (,uint256 when) = activate(1,2);
        (address plugin,) = factory.plugins(FIRST);
        vm.etch(plugin, hex"00");
        vm.warp(when);
        vm.prank(DEV); factory.pauseVault(address(vault), bytes32(0));
        assertTrue(vault.paused()); assertEq(vault.policy(FIRST).weight, 1);
        assertEq(vault.budget(FIRST), 29833); assertEq(vault.unallocated(), 0);
    }
    function testEmergencyPauseNeverResumesAtActivationAndKnownSpendingPoliciesCannotBeReplaced() public {
        vault.deposit{value:100000}(100000);
        (,uint256 when) = activate(1,2);
        vm.prank(DEV); factory.pauseVault(address(vault), bytes32(0));
        vm.warp(when); vault.sync(); assertTrue(vault.paused()); assertEq(vault.policy(FIRST).weight, 1);
        HookClaim memory claim = request(1000); bytes memory sig = signature(claim);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(claim, "", sig);
        HookPolicy[] memory changed = selection(2,1); ++changed[0].maxSpend;
        vm.expectRevert(); vm.prank(DEV); factory.activatePlugins(address(vault), changed);
        (,uint256 at,) = vault.pendingActivation(); assertEq(at, 0); assertEq(vault.budget(FIRST), 29833);
    }
}
