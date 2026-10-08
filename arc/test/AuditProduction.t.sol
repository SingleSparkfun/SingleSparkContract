// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ArcLaunchV2Test} from "./ArcLaunchV2.t.sol";
import {ArcLaunchV2} from "../src/ArcLaunchV2.sol";
import {ArcToken} from "../src/ArcLaunch.sol";
import {ArcRewards} from "../src/ArcRewards.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {ArcLaunchStrategy} from "../src/ArcLaunchStrategy.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

/// @notice Regression checks for repaired fee/keeper issues; other audit reproductions remain explicitly named.
contract AuditProductionTest is ArcLaunchV2Test {
    function testExternalLiquidityRejectedThroughCustomRouterAndPositionManager() public {
        uint256 bought = launch.trade{value: 5000e18}(jet, true, 5000e18, 1, block.timestamp + 120);
        launch.collectFees(jet);
        (uint256 id,,,,,,) = launch.tokens(jet);
        (PoolKey memory key,) = launch.positionManager().getPoolAndPositionInfo(id);
        (, int24 tick,,) = StateLibrary.getSlot0(launch.poolManager(), key.toId());
        uint128 originalLiquidity = StateLibrary.getLiquidity(launch.poolManager(), key.toId());
        PoolModifyLiquidityTest externalLP = new PoolModifyLiquidityTest(launch.poolManager());
        ArcToken(jet).approve(address(externalLP), bought);
        ModifyLiquidityParams memory params = ModifyLiquidityParams({
            tickLower: tick / 25 * 25 - 25,
            tickUpper: tick / 25 * 25 + 50,
            liquidityDelta: int256(uint256(originalLiquidity)) * 10,
            salt: bytes32(0)
        });
        bytes memory rejection = abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(strategy),
            IHooks.beforeAddLiquidity.selector,
            abi.encodeWithSelector(ArcLaunchStrategy.Invalid.selector),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
        vm.expectRevert(rejection);
        externalLP.modifyLiquidity{value: 1000e18}(key, params, "");
        // A public PositionManager must not be an allowlist bypass.
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            key,
            params.tickLower,
            params.tickUpper,
            uint256(originalLiquidity),
            type(uint128).max,
            type(uint128).max,
            address(this),
            bytes("")
        );
        IPositionManager positionManager = launch.positionManager();
        vm.expectRevert(rejection);
        positionManager.modifyLiquidities(
            abi.encode(abi.encodePacked(uint8(Actions.MINT_POSITION)), inputs), block.timestamp
        );
        assertEq(StateLibrary.getLiquidity(launch.poolManager(), key.toId()), originalLiquidity);
        launch.trade{value: 10e18}(jet, true, 10e18, 1, block.timestamp + 120);
        (uint256 factoryFees,) = launch.collectFees(jet);
        assertApproxEqAbs(factoryFees, 0.3e18, 2);
    }

    function testKeeperCapRejectsOriginalSandwichBudget() public {
        // The test funds the historical budget; the attacker's capital is independently 5,000 USDC.
        launch.fundFees{value: 2000e18}(jet);
        (, uint256 budget,,,,,) = launch.tokens(jet);
        assertEq(budget, 1880e18);
        (uint256 id,,,,,,) = launch.tokens(jet);
        (PoolKey memory key,) = launch.positionManager().getPoolAndPositionInfo(id);
        IV4Quoter quoter = IV4Quoter(deployCode("V4Quoter.sol:V4Quoter", abi.encode(launch.poolManager())));
        address attacker = address(0xa771);
        vm.deal(attacker, 5000e18);
        vm.prank(attacker);
        uint256 bought = launch.trade{value: 5000e18}(jet, true, 5000e18, 1, block.timestamp + 120);
        (uint256 manipulatedQuote,) =
            quoter.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, true, uint128(budget), ""));
        vm.prank(keeper);
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.executeBurn(jet, budget, manipulatedQuote * 9700 / 10000, block.timestamp + 120);
        (, uint256 remaining,,,,,) = launch.tokens(jet);
        assertEq(remaining, budget);
        // Even if a keeper bypasses the off-chain historical guard, the on-chain size limit still applies.
        (, uint256 limit) = strategy.keeperSwapState(jet, true);
        assertLt(limit, 100e18);
        vm.prank(keeper);
        launch.executeBurn(jet, limit, 1, block.timestamp + 120);
        vm.startPrank(attacker);
        ArcToken(jet).approve(address(launch), bought);
        launch.trade(jet, false, bought, 1, block.timestamp + 120);
        vm.stopPrank();
        assertLt(attacker.balance, 5000e18);
        emit log_named_uint("Capped buyback (native USDC wei)", limit);
        emit log_named_uint("Attacker loss before gas (native USDC wei)", 5000e18 - attacker.balance);
    }

    function testDustDonationDoesNotInvalidateBoundedBurn() public {
        launch.fundFees{value: 100e18}(jet);
        (, uint256 beforeBudget,,,,,) = launch.tokens(jet);
        launch.fundFees{value: 100}(jet);
        vm.prank(keeper);
        launch.executeBurn(jet, 10e18, 1, block.timestamp + 120);
        (, uint256 remaining,,,,,) = launch.tokens(jet);
        assertEq(remaining, beforeBudget + 94 - 10e18);
    }

    function testRewardsAndBuybackShareCapsAndKeepPartialBalances() public {
        launch.fundFees{value: 2000e18}(jet);
        (,, ArcRewards reward) = launch.terms(jet);
        vm.prank(keeper);
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        reward.buyOwnToken(100e18, 1, block.timestamp + 30);
        vm.prank(keeper);
        reward.buyOwnToken(10e18, 1, block.timestamp + 30);
        assertEq(reward.pendingNative(), 90e18);
        vm.prank(keeper);
        vm.expectRevert(ArcRewards.Invalid.selector);
        reward.buyOwnToken(1e18, 1, block.timestamp + 30);

        address highFee = _launchProject("Conversion", "CNV", "", 0, 100_000);
        vm.warp(block.timestamp + 3);
        uint256 bought = launch.trade{value: 50000e18}(highFee, true, 50000e18, 1, block.timestamp + 30);
        ArcToken(highFee).approve(address(launch), bought);
        launch.trade(highFee, false, bought, 1, block.timestamp + 30);
        launch.collectFees(highFee);
        (, uint256 beforeNative, uint256 pendingTokens,,,,) = launch.tokens(highFee);
        assertEq(pendingTokens, 0);
        (, uint256 limit) = strategy.keeperSwapState(highFee, true);
        assertGt(beforeNative, limit);
        vm.prank(keeper);
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.executeBurn(highFee, beforeNative, 1, block.timestamp + 30);
        vm.prank(keeper);
        launch.executeBurn(highFee, limit, 1, block.timestamp + 30);
        (, uint256 remainder,,,,,) = launch.tokens(highFee);
        assertEq(remainder, beforeNative - limit);
        vm.prank(keeper);
        vm.expectRevert(ArcLaunchV2.NotDue.selector);
        launch.executeBurn(highFee, 5e18, 1, block.timestamp + 30);
    }

    function testDuplicateRecipientsCannotConsumeFunds() public {
        (,, ArcRewards reward) = launch.terms(jet);
        launch.fundFees{value: 100e18}(jet);
        vm.prank(keeper);
        reward.buyOwnToken(5e18, 1, block.timestamp + 120);
        uint256 available = reward.available();
        address[] memory candidates = new address[](128);
        for (uint256 i; i < 128; i++) {
            candidates[i] = address(uint160(100 + i));
        }
        for (uint256 i; i < 128; i++) {
            candidates[i] = address(0xa773);
        }
        vm.prank(keeper);
        vm.expectRevert(ArcRewards.Invalid.selector);
        reward.distribute(0, candidates);
        assertEq(reward.reserved(), 0);
        assertEq(reward.available(), available);
        assertEq(reward.roundId(), 0);
    }

    function testLowFeeCapRejectsPreviouslyProfitableSandwich() public {
        address token = _launchProject("Low Fee", "LOW", "", 100, 100);
        vm.warp(block.timestamp + 3);
        launch.trade{value: 1000e18}(token, true, 1000e18, 1, vm.getBlockTimestamp() + 30);
        launch.fundFees{value: 1000e18}(token);
        vm.warp(block.timestamp + 1000);
        address attacker = address(0xa775);
        vm.deal(attacker, 50e18);
        vm.prank(attacker);
        uint256 bought = launch.trade{value: 50e18}(token, true, 50e18, 1, vm.getBlockTimestamp() + 30);
        (, uint256 cap) = strategy.keeperSwapState(token, true);
        assertLt(cap, 1e18);
        vm.prank(keeper);
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.executeBurn(token, 55299605518150968058, 1, vm.getBlockTimestamp() + 30);
        // This shallow pool waits: its fee-scaled safe size is below the 5 USDC minimum.
        vm.prank(keeper);
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.executeBurn(token, cap, 1, vm.getBlockTimestamp() + 30);
        vm.startPrank(attacker);
        ArcToken(token).approve(address(launch), bought);
        launch.trade(token, false, bought, 1, vm.getBlockTimestamp() + 30);
        vm.stopPrank();
        assertLt(attacker.balance, 50e18);
        launch.collectFees(token);
        (, uint256 nativeBefore, uint256 feeTokens,,,,) = launch.tokens(token);
        assertEq(feeTokens, 0);
        vm.prank(keeper);
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.executeBurn(token, 0, 0, vm.getBlockTimestamp() + 30);
        (, uint256 nativeAfter, uint256 remainingTokens,,,,) = launch.tokens(token);
        assertEq(nativeAfter, nativeBefore);
        assertEq(remainingTokens, 0);
    }

    function testFeeScaledCapsAcrossBothDirections() public {
        uint24[5] memory rates = [uint24(0), 1, 100, 1000, 30_000];
        for (uint256 i; i < rates.length; i++) {
            address token = _launchProject("Cap", "CAP", "", rates[i], rates[i]);
            vm.warp(vm.getBlockTimestamp() + 3);
            launch.trade{value: 1000e18}(token, true, 1000e18, 1, block.timestamp + 30);
            (uint256 id,,,,,,) = launch.tokens(token);
            (PoolKey memory key,) = launch.positionManager().getPoolAndPositionInfo(id);
            uint128 liquidity = StateLibrary.getLiquidity(launch.poolManager(), key.toId());
            (uint160 sqrt, uint256 buyCap) = strategy.keeperSwapState(token, true);
            (, uint256 sellCap) = strategy.keeperSwapState(token, false);
            uint256 fraction = uint256(rates[i]) * 2 / 8;
            if (fraction > 5000) fraction = 5000;
            assertEq(buyCap, uint256(liquidity) * (1 << 96) / sqrt * fraction / 1_000_000);
            assertEq(sellCap, uint256(liquidity) * sqrt / (1 << 96) * fraction / 1_000_000);
        }
    }

    function testLowFeeSandwichLosesAcrossBothAutomaticBuys() public {
        vm.deal(address(this), 300_000e18);
        address token = _launchProject("Deeper Pool", "DEEP", "", 100, 100);
        vm.warp(block.timestamp + 3);
        launch.trade{value: 250_000e18}(token, true, 250_000e18, 1, block.timestamp + 30);
        launch.fundFees{value: 1000e18}(token);
        address attacker = address(0xa776);
        vm.deal(attacker, 1000e18);
        vm.prank(attacker);
        uint256 bought = launch.trade{value: 1000e18}(token, true, 1000e18, 1, block.timestamp + 30);
        (, uint256 cap) = strategy.keeperSwapState(token, true);
        assertGt(cap, 5e18);
        vm.prank(keeper);
        launch.executeBurn(token, cap, 1, block.timestamp + 30);
        (,, ArcRewards reward) = launch.terms(token);
        (, cap) = strategy.keeperSwapState(token, true);
        vm.prank(keeper);
        reward.buyOwnToken(cap, 1, block.timestamp + 30);
        vm.startPrank(attacker);
        ArcToken(token).approve(address(launch), bought);
        launch.trade(token, false, bought, 1, block.timestamp + 30);
        vm.stopPrank();
        assertLt(attacker.balance, 1000e18);
        emit log_named_uint("Low-fee attacker loss across burn and rewards buys", 1000e18 - attacker.balance);
    }
}
