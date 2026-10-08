// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ArcLaunchV2} from "../src/ArcLaunchV2.sol";
import {ArcToken} from "../src/ArcLaunch.sol";
import {ArcLaunchStrategy} from "../src/ArcLaunchStrategy.sol";
import {ArcRewards} from "../src/ArcRewards.sol";
import {ArcOpeningProbe} from "./ArcOpeningProbe.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {FeeSplitter} from "launcher/src/periphery/FeeSplitter.sol";
import {FeeSplit} from "launcher/src/interfaces/IFeeSplitter.sol";
import {ArcLaunchV2Fixture} from "./ArcLaunchV2Fixture.sol";

contract ArcLaunchV2Test is ArcLaunchV2Fixture {
    function setUp() public {
        _deploy(treasury);
    }

    function testPlatformIsBoundAtLaunchAndHasNoProjectTreasury() public {
        assertEq(launch.platformToken(), jet);
        (, address platformCommunity,) = launch.terms(jet);
        assertEq(platformCommunity, address(0));
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        launch.launch("No treasury", "NONE", "", 0, 0, address(0));
        launch.fundFees{value: 100e18}(jet);
        (, uint256 budget,,,,,) = launch.tokens(jet);
        assertEq(budget, 94e18);
        assertEq(launch.communityCredit(jet), 0);
        launch.fundFees{value: 99}(jet);
        (, budget,,,,,) = launch.tokens(jet);
        assertEq(budget, 94e18 + 82 + 6 + 3); // each original share floors separately
        assertEq(launch.communityCredit(jet), 0);
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.claimCommunity(jet);
    }

    function testFundPlatformBuybackCreditsOnlyPlatformBudget() public {
        (, uint256 budgetBefore,,,,,) = launch.tokens(jet);
        uint256 accounted = launch.nativeAccounted();
        uint256 credit = launch.operationsCredit();
        (,, ArcRewards jetReward) = launch.terms(jet);

        vm.expectEmit(true, true, false, true);
        emit ArcLaunchV2.PlatformBuybackFunded(address(this), 100e18);
        launch.fundPlatformBuyback{value: 100e18}();

        (, uint256 budgetAfter,,,,,) = launch.tokens(jet);
        assertEq(budgetAfter - budgetBefore, 100e18); // no 90/5/4/1 re-split
        assertEq(launch.nativeAccounted() - accounted, 100e18);
        assertEq(launch.operationsCredit(), credit);
        assertEq(launch.communityCredit(jet), 0);
        assertEq(jetReward.pendingNative(), 0);
        assertEq(address(launch).balance, launch.nativeAccounted());

        // The budget is spendable only through the existing guarded keeper burn.
        uint256 supply = ArcToken(jet).totalSupply();
        (, uint256 amount) = strategy.keeperSwapState(jet, true);
        assertGt(amount, 0);
        vm.prank(keeper);
        launch.executeBurn(jet, amount, 1, block.timestamp + 120);
        assertLt(ArcToken(jet).totalSupply(), supply);

        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.fundPlatformBuyback{value: 0}();
    }

    /// Without a platform token the donation has no burn budget to land in, so it must not be accepted.
    function testFundPlatformBuybackRejectsAnUnsetPlatformToken() public {
        ArcLaunchV2 bare = _newFactory(positionManager, keeper, treasury);
        assertEq(bare.platformToken(), address(0));
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        bare.fundPlatformBuyback{value: 1e18}();
        assertEq(bare.nativeAccounted(), 0);
        assertEq(address(bare).balance, 0);
    }

    function testFiveWayFundsOwnTokenOnlyAndTreasuriesAreIsolated() public {
        (,, ArcRewards reward) = launch.terms(project);
        (,, ArcRewards jetReward) = launch.terms(jet);
        launch.fundFees{value: 100e18}(project);
        (, uint256 own,,,,,) = launch.tokens(project);
        (, uint256 platform,,,,,) = launch.tokens(jet);
        assertEq(own, 83e18);
        assertEq(platform, 7e18);
        assertEq(reward.pendingNative(), 5e18);
        assertEq(address(reward).balance, 5e18);
        assertEq(launch.communityCredit(project), 4e18);
        assertEq(launch.operationsCredit(), 1e18);
        assertEq(launch.nativeAccounted(), 95e18);
        assertEq(address(launch).balance, 95e18);
        vm.prank(keeper);
        vm.expectRevert();
        reward.buyOwnToken(5e18, type(uint256).max, block.timestamp + 120);
        assertEq(reward.pendingNative(), 5e18);
        vm.expectRevert(ArcRewards.Invalid.selector);
        reward.buyOwnToken(5e18, 1, block.timestamp + 120);
        vm.prank(keeper);
        reward.buyOwnToken(5e18, 1, block.timestamp + 120);
        assertGt(reward.available(), 1000e18);
        assertEq(ArcToken(project).balanceOf(address(reward)), reward.available());
        assertEq(ArcToken(jet).balanceOf(address(reward)), 0);
        assertEq(jetReward.available(), 0);
        assertEq(reward.pendingNative(), 0);
        assertEq(address(reward).balance, 0);
        uint256 supply = ArcToken(project).totalSupply();
        (, uint256 firstBurn) = strategy.keeperSwapState(project, true);
        assertLt(firstBurn, 83e18);
        vm.prank(keeper);
        launch.executeBurn(project, firstBurn, 1, block.timestamp + 120);
        (, uint256 remainder,,,,,) = launch.tokens(project);
        assertEq(remainder, 83e18 - firstBurn);
        vm.warp(block.timestamp + 180);
        vm.prank(keeper);
        launch.executeBurn(project, remainder, 1, vm.getBlockTimestamp() + 120);
        (,,,,, uint256 burned,) = launch.tokens(project);
        assertEq(supply - ArcToken(project).totalSupply(), burned);
        assertEq(ArcToken(project).balanceOf(address(reward)), reward.available());
        launch.claimCommunity(project);
        // Platform revenue retains a gas buffer; an explicit reserve lets the excess be claimed.
        assertEq(launch.operationsClaimable(), 0);
        launch.fundKeeperGas{value: 1e18}();
        launch.claimOperations();
        assertEq(community.balance, 4e18);
        assertEq(treasury.balance, 1e18);
        assertEq(launch.operationsCredit(), 1e18);
        assertEq(launch.nativeAccounted(), 8e18);
        assertEq(address(launch).balance, 8e18);
        // JET's 83% and 7% merge once; its separate 5% reward budget is not taken from burn proceeds.
        launch.fundFees{value: 100e18}(jet);
        (, platform,,,,,) = launch.tokens(jet);
        assertEq(platform, 101e18);
        assertEq(jetReward.pendingNative(), 5e18);
        assertEq(launch.communityCredit(jet), 0);
    }

    function testBuyAndSellTaxIsOnlyUsdcAndWaitsForBuyback() public {
        uint256 supply = ArcToken(project).totalSupply();
        uint256 bought = launch.trade{value: 1000e18}(project, true, 1000e18, 1, block.timestamp + 120);
        (uint256 buyTax, uint256 tokenTax) = launch.collectFees(project);
        assertEq(buyTax, 10e18);
        assertEq(tokenTax, 0);
        ArcToken(project).approve(address(launch), bought / 2);
        uint256 beforeBalance = address(this).balance;
        uint256 received = launch.trade(project, false, bought / 2, 1, block.timestamp + 120);
        assertEq(address(this).balance - beforeBalance, received);
        (uint256 sellTax,) = launch.collectFees(project);
        assertApproxEqAbs(sellTax, (received + sellTax) * 5 / 100, 1);
        assertEq(ArcToken(project).totalSupply(), supply);
        (,, ArcRewards reward) = launch.terms(project);
        (, uint256 pending, uint256 burnTokens,,,,) = launch.tokens(project);
        assertEq(burnTokens, 0);
        assertEq(reward.available(), 0);
        assertEq(pending, buyTax * 83 / 100 + sellTax * 83 / 100);
        assertEq(reward.pendingNative(), buyTax * 5 / 100 + sellTax * 5 / 100);
        assertEq(launch.communityCredit(project), buyTax * 4 / 100 + sellTax * 4 / 100);
        assertEq(ArcToken(project).balanceOf(address(launch)), 0);
        assertEq(address(launch).balance, launch.nativeAccounted());
        vm.prank(keeper);
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.executeBurn(project, 0, 0, block.timestamp + 120);
        vm.prank(keeper);
        launch.executeBurn(project, 5e18, 1, block.timestamp + 120);
        assertLt(ArcToken(project).totalSupply(), supply);
        vm.prank(keeper);
        vm.expectRevert(ArcLaunchV2.NotDue.selector);
        launch.executeBurn(project, 5e18, 1, block.timestamp + 120);
    }

    function testOpeningProtectionClockFloorAndZeroFeeException() public {
        address token = _launchProject("Opening", "OPEN", "", 30_000, 30_000);
        uint256 start = vm.getBlockTimestamp();
        uint24[4] memory expected = [uint24(990_000), 247_500, 61_875, 30_000];
        assertEq(strategy.launchProtectionVersion(), 2);
        for (uint256 i; i < expected.length; i++) {
            vm.warp(start + i);
            (uint64 starts, uint64 ends, uint24 fee) = strategy.launchProtection(token);
            assertEq(starts, start);
            assertEq(ends, start + 3);
            assertEq(fee, expected[i]);
            launch.trade{value: 100e18}(token, true, 100e18, 1, block.timestamp + 120);
            assertEq(strategy.accruedOpeningNative(token), uint256(100e18) * (expected[i] - 30_000) / 1_000_000);
            (uint256 tax,) = launch.collectFees(token);
            assertEq(tax, uint256(100e18) * expected[i] / 1_000_000);
            assertEq(strategy.accruedOpeningNative(token), 0);
        }
        address high = _launchProject("High", "HIGH", "", 100_000, 0);
        address free = _launchProject("Free", "FREE", "", 0, 0);
        (, uint64 endFree, uint24 freeFee) = strategy.launchProtection(free);
        assertEq(endFree, vm.getBlockTimestamp());
        assertEq(freeFee, 0);
        launch.trade{value: 100e18}(free, true, 100e18, 1, block.timestamp + 120);
        assertEq(strategy.accruedNative(free), 0);
        vm.warp(vm.getBlockTimestamp() + 2);
        (,, uint24 highFee) = strategy.launchProtection(high);
        (,, uint24 oldFee) = strategy.launchProtection(token);
        assertEq(highFee, 100_000);
        assertEq(oldFee, 30_000); // Another launch cannot restart the clock.
        vm.prank(address(launch));
        vm.expectRevert(ArcLaunchStrategy.Invalid.selector);
        strategy.initializeDistribution(token, 0, 0);
    }

    function testOpeningTaxAllRoutesAndUsdcAllocation() public {
        address token = _launchProject("Opening", "OPEN", "", 30_000, 30_000);
        (uint256 id,,,,,,) = launch.tokens(token);
        (PoolKey memory key,) = launch.positionManager().getPoolAndPositionInfo(id);
        IV4Quoter quoter = IV4Quoter(deployCode("V4Quoter.sol:V4Quoter", abi.encode(launch.poolManager())));
        PoolSwapTest router = new PoolSwapTest(launch.poolManager());
        (uint256 quoted,) = quoter.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, true, 100e18, ""));
        vm.expectRevert();
        launch.trade{value: 100e18}(token, true, 100e18, quoted + 1, block.timestamp + 120);
        assertEq(strategy.accruedNative(token), 0);
        assertEq(strategy.accruedOpeningNative(token), 0);
        // The creator is taxed too, even when calling the factory directly.
        assertEq(launch.trade{value: 100e18}(token, true, 100e18, quoted, block.timestamp + 120), quoted);
        assertEq(strategy.accruedOpeningNative(token), 96e18);
        (uint256 tax,) = launch.collectFees(token);
        assertEq(tax, 99e18);
        (, uint256 own,,,,,) = launch.tokens(token);
        (, uint256 platform,,,,,) = launch.tokens(jet);
        (,, ArcRewards reward) = launch.terms(token);
        assertEq(own, 2.49e18);
        assertEq(platform, 96.21e18);
        assertEq(reward.pendingNative(), 0.15e18);
        assertEq(launch.communityCredit(token), 0.12e18);
        assertEq(launch.operationsCredit(), 0.03e18);
        assertEq(ArcToken(token).totalSupply(), launch.SUPPLY());
        address buyer = address(0xbeef);
        vm.deal(buyer, 200e18);
        vm.prank(buyer);
        router.swap{value: 100e18}(key, SwapParams(true, -int256(100e18), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false), "");
        assertEq(strategy.accruedOpeningNative(token), 96e18);
        (tax,) = launch.collectFees(token);
        assertEq(tax, 99e18);
        // Exact-output buys cannot bypass protection through another router.
        BalanceDelta delta = router.swap{value: 100e18}(key, SwapParams(true, int256(100e18), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false), "");
        uint256 gross = uint256(-int256(delta.amount0()));
        assertEq(strategy.accruedOpeningNative(token), strategy.accruedNative(token) - (gross * 30_000 + 999_999) / 1_000_000);
        (tax,) = launch.collectFees(token);
        assertEq(uint256(uint128(delta.amount1())), 100e18);
        assertApproxEqAbs(tax, uint256(-int256(delta.amount0())) * 99 / 100, 1);
        // Selling during protection still uses the project's normal sell fee.
        ArcToken(token).approve(address(launch), quoted);
        uint256 net = launch.trade(token, false, quoted, 1, block.timestamp + 120);
        assertEq(strategy.accruedOpeningNative(token), 0);
        (tax,) = launch.collectFees(token);
        assertApproxEqAbs(tax, (net + tax) * 3 / 100, 1);
        assertEq(address(launch).balance, launch.nativeAccounted());
    }

    function testPlatformOpeningTaxBuysBackOnceAndLaterTradesUseBaseTax() public {
        vm.warp(strategy.launchedAt(jet));
        launch.trade{value: 100e18}(jet, true, 100e18, 1, vm.getBlockTimestamp() + 120);
        assertEq(strategy.accruedOpeningNative(jet), 96e18);
        launch.collectFees(jet);
        (, uint256 pending,,,,,) = launch.tokens(jet);
        assertEq(pending, 98.82e18); // 96 opening + 94% of 3 base; no extra split of the 96.
        (,, ArcRewards reward) = launch.terms(jet);
        assertEq(reward.pendingNative(), 0.15e18);
        assertEq(launch.communityCredit(jet), 0);
        assertEq(launch.operationsCredit(), 0.03e18);
        vm.warp(vm.getBlockTimestamp() + 3);
        vm.prank(keeper);
        launch.executeBurn(jet, 5e18, 1, vm.getBlockTimestamp() + 120);
        assertEq(strategy.accruedNative(jet), 0.15e18);
        assertEq(strategy.accruedOpeningNative(jet), 0);
        launch.collectFees(jet);
        (, pending,,,,,) = launch.tokens(jet);
        assertEq(pending, 93.961e18);
        assertLt(ArcToken(jet).totalSupply(), launch.SUPPLY());
        assertEq(address(launch).balance, launch.nativeAccounted());
    }

    function testAtomicTestnetProbeReturnsTokensAndPreservesTaxAccounting() public {
        ArcOpeningProbe probe = new ArcOpeningProbe(launch);
        address token = probe.launchAndBuy{value: 8e18}("");
        assertGt(ArcToken(token).balanceOf(address(this)), 0);
        assertEq(ArcToken(token).balanceOf(address(probe)), 0);
        assertEq(address(probe).balance, 0);
        assertEq(strategy.accruedNative(token), 7.92e18);
        assertEq(strategy.accruedOpeningNative(token), 7.68e18);
        launch.collectFees(token);
        (, uint256 platform,,,,,) = launch.tokens(jet);
        assertEq(platform, 7.6968e18);
        assertEq(strategy.accruedOpeningNative(token), 0);
        assertEq(address(launch).balance, launch.nativeAccounted());
    }

    function testThreePercentSellUsesGrossUsdcAndNetMinimum() public {
        uint256 bought = launch.trade{value: 1000e18}(jet, true, 1000e18, 1, block.timestamp + 30);
        (uint256 buyTax,) = launch.collectFees(jet);
        assertEq(buyTax, 30e18);
        ArcToken(jet).approve(address(launch), bought);
        (uint256 id,,,,,,) = launch.tokens(jet);
        (PoolKey memory key,) = launch.positionManager().getPoolAndPositionInfo(id);
        IV4Quoter quoter = IV4Quoter(deployCode("V4Quoter.sol:V4Quoter", abi.encode(launch.poolManager())));
        (uint256 net,) = quoter.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, false, uint128(bought), ""));
        vm.expectRevert();
        launch.trade(jet, false, bought, net + 1, block.timestamp + 30);
        assertEq(strategy.accruedNative(jet), 0);
        assertEq(ArcToken(jet).balanceOf(address(this)), bought);
        assertEq(launch.trade(jet, false, bought, net, block.timestamp + 30), net);
        (uint256 sellTax, uint256 tokenTax) = launch.collectFees(jet);
        assertApproxEqAbs(sellTax, (net + sellTax) * 3 / 100, 1);
        assertEq(tokenTax, 0);
        (, uint256 budget, uint256 pendingTokens,,,,) = launch.tokens(jet);
        assertEq(budget, buyTax * 83 / 100 + buyTax * 7 / 100 + buyTax * 4 / 100
            + sellTax * 83 / 100 + sellTax * 7 / 100 + sellTax * 4 / 100);
        assertEq(pendingTokens, 0);
        assertEq(ArcToken(jet).totalSupply(), launch.SUPPLY());
    }

    function testPartialSpecifiedFillAndUnauthorizedCollectionRevert() public {
        (uint256 id,,,,,,) = launch.tokens(project);
        (PoolKey memory key,) = launch.positionManager().getPoolAndPositionInfo(id);
        PoolSwapTest router = new PoolSwapTest(launch.poolManager());
        (uint160 price,) = strategy.keeperSwapState(project, true);
        vm.expectRevert();
        router.swap{value: 1000e18}(key, SwapParams(true, -int256(1000e18), price - 1),
            PoolSwapTest.TestSettings(false, false), "");
        assertEq(strategy.accruedNative(project), 0);
        assertEq(launch.poolManager().balanceOf(address(strategy), 0), 0);
        vm.expectRevert(ArcLaunchStrategy.Invalid.selector);
        strategy.collectFees(project);
        vm.expectRevert(ArcLaunchStrategy.Invalid.selector);
        strategy.unlockCallback(abi.encode(1e18));
    }

    function testCollectionFundsGasOnlyFromPlatformCreditAndReportsGrossFees() public {
        launch.fundKeeperGas{value: 1e18}();
        vm.deal(keeper, 0);
        launch.trade{value: 1000e18}(project, true, 1000e18, 1, block.timestamp + 120);
        (uint256 nativeFee,) = launch.collectFees(project);
        assertApproxEqAbs(nativeFee, 10e18, 10);
        assertEq(keeper.balance, 0.25e18);
        assertEq(launch.totalKeeperGasPaid(), 0.25e18);
        (, uint256 own,,,,,) = launch.tokens(project);
        (, uint256 platform,,,,,) = launch.tokens(jet);
        (,, ArcRewards reward) = launch.terms(project);
        assertEq(own, nativeFee * 83 / 100);
        assertEq(platform, nativeFee * 7 / 100);
        assertEq(reward.pendingNative(), nativeFee * 5 / 100);
        assertEq(launch.communityCredit(project), nativeFee * 4 / 100);
        assertEq(
            launch.operationsCredit(),
            1e18 + nativeFee - own - platform - reward.pendingNative() - launch.communityCredit(project) - 0.25e18
        );
        assertEq(address(launch).balance, launch.nativeAccounted());
        // No new fees: refunding the keeper from existing credit must not underflow the fee delta.
        (nativeFee,) = launch.collectFees(project);
        assertEq(nativeFee, 0);
        assertEq(keeper.balance, 0.5e18);
    }

    function testGasFundingLimitsAndPermissionlessRecovery() public {
        launch.fundKeeperGas{value: 10e18}();
        assertEq(launch.topUpKeeper(), 0); // Adequate balance: no extra payment.
        vm.deal(keeper, 0);
        for (uint256 i; i < 8; i++) {
            vm.prank(address(0x1234)); // A sponsor can recover an empty execution wallet.
            assertEq(launch.topUpKeeper(), 0.25e18);
        }
        assertEq(keeper.balance, 2e18);
        vm.deal(keeper, 0);
        assertEq(launch.topUpKeeper(), 0); // Daily limit remains after the keeper spends funds.
        assertEq(launch.keeperGasPaidToday(), 2e18);
        vm.warp(block.timestamp + 1 days);
        assertEq(launch.topUpKeeper(), 0.25e18);
        assertEq(launch.keeperGasPaidToday(), 0.25e18);
        assertEq(launch.totalKeeperGasPaid(), 2.25e18);
        assertEq(launch.operationsCredit(), 7.75e18);
        assertEq(address(launch).balance, launch.nativeAccounted());
    }

    function testRejectedGasPaymentPreservesAccountingAndCannotBlockCollection() public {
        vm.deal(keeper, 0);
        vm.etch(keeper, hex"60006000fd");
        launch.fundKeeperGas{value: 1e18}();
        assertEq(launch.totalKeeperGasPaid(), 0);
        assertEq(launch.operationsCredit(), 1e18);
        launch.trade{value: 1000e18}(project, true, 1000e18, 1, block.timestamp + 120);
        (uint256 fee,) = launch.collectFees(project);
        assertGt(fee, 0);
        assertEq(launch.totalKeeperGasPaid(), 0);
        assertEq(launch.keeperGasPaidToday(), 0);
        assertEq(address(launch).balance, launch.nativeAccounted());
        assertEq(keeper.balance, 0);
    }

    function testCustomFeesCalibrateHalfSupplyAndCannotBeChanged() public {
        for (uint24 fee; fee <= 100_000; fee += 25_000) {
            address token = _launchProject("Curve", "CRV", "", fee, 100_000 - fee);
            vm.warp(vm.getBlockTimestamp() + 3);
            (uint256 id,,,,,,) = launch.tokens(token);
            (uint24 savedFee, uint24 sellFee) = launch.tradeFees(token);
            assertEq(sellFee, 100_000 - fee);
            assertEq(savedFee, fee);
            uint256 received = launch.trade{value: 10_000e18}(token, true, 10_000e18, 1, block.timestamp + 120);
            assertApproxEqRel(received, launch.SUPPLY() / 2, 0.0007e18);
            assertEq(IERC721(address(launch.positionManager())).ownerOf(id), address(launch.feeSplitter()));
            (uint256 nativeFee,) = launch.collectFees(token);
            assertApproxEqAbs(nativeFee, 10_000e18 * uint256(fee) / 1_000_000, 10);
            ArcToken(token).approve(address(launch), received / 2);
            uint256 net = launch.trade(token, false, received / 2, 1, block.timestamp + 120);
            (uint256 sellTax, uint256 tokenFee) = launch.collectFees(token);
            assertEq(tokenFee, 0);
            assertApproxEqAbs(sellTax, (net + sellTax) * sellFee / 1_000_000, 1);
        }
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        launch.launch("Bad", "BAD", "", 100_001, 0, community);
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        launch.launch("Bad", "BAD", "", 30_000, 30_000, treasury);
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        launch.launch("Bad", "BAD", "", 0, 100_001, community);
        IPositionManager pm = launch.positionManager();
        vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
        _newFactory(pm, keeper, keeper);
    }

    function testIndependentFeesApplyToOtherRoutersAndMatchQuotes() public {
        (uint256 id,,,,,,) = launch.tokens(project);
        (PoolKey memory key,) = launch.positionManager().getPoolAndPositionInfo(id);
        IV4Quoter quoter = IV4Quoter(deployCode("V4Quoter.sol:V4Quoter", abi.encode(launch.poolManager())));
        PoolSwapTest router = new PoolSwapTest(launch.poolManager());
        (uint256 quoted,) = quoter.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, true, 1000e18, ""));
        BalanceDelta delta = router.swap{value: 1000e18}(
            key,
            SwapParams(true, -int256(1000e18), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        uint256 bought = uint256(uint128(delta.amount1()));
        assertEq(bought, quoted);
        (uint256 nativeFee,) = launch.collectFees(project);
        assertApproxEqAbs(nativeFee, 10e18, 10);
        ArcToken(project).approve(address(router), bought);
        (quoted,) = quoter.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, false, uint128(bought / 2), ""));
        delta = router.swap(
            key,
            SwapParams(false, -int256(bought / 2), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertEq(uint256(uint128(delta.amount0())), quoted);
        (uint256 sellTax, uint256 tokenFee) = launch.collectFees(project);
        assertEq(tokenFee, 0);
        assertApproxEqAbs(sellTax, (quoted + sellTax) * 5 / 100, 1);
        // Exact output also selects by direction, not the sign of amountSpecified.
        delta = router.swap{value: 10e18}(
            key,
            SwapParams(true, int256(100e18), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        (nativeFee,) = launch.collectFees(project);
        assertApproxEqAbs(nativeFee, uint256(-int256(delta.amount0())) / 100, 10);
        assertEq(uint256(uint128(delta.amount1())), 100e18);
        delta = router.swap(key, SwapParams(false, int256(97e18), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false), "");
        (nativeFee, tokenFee) = launch.collectFees(project);
        assertEq(uint256(uint128(delta.amount0())), 97e18);
        assertEq(tokenFee, 0);
        assertApproxEqAbs(nativeFee, (97e18 + nativeFee) * 5 / 100, 1);
        assertEq(strategy.accruedNative(project), 0);
        assertEq(launch.poolManager().balanceOf(address(strategy), 0), 0);
        vm.prank(address(launch));
        vm.expectRevert(ArcLaunchStrategy.Invalid.selector);
        strategy.initializeDistribution(project, 0, 0); // Registered fees cannot be changed.
    }

    /// A wallet has to be able to sign a deadline that survives a congested mempool. The 100-wallet
    /// run on 2026-09-20 measured quote-to-block times of p95 181.7 s and max 192.7 s — all past the
    /// old 120 s ceiling — and 119 of 240 buys reverted on it having nothing else they could sign.
    function testTradeTakesADeadlineUpToTheWindowAndRefusesOneBeyondIt() public {
        uint256 window = launch.TRADE_DEADLINE_WINDOW();
        assertEq(window, 900);

        assertGt(launch.trade{value: 100e18}(jet, true, 100e18, 1, block.timestamp + window), 0);

        // The ceiling still exists: a signed trade may not sit around as a free option forever.
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.trade{value: 100e18}(jet, true, 100e18, 1, block.timestamp + window + 1);

        // And a deadline that has already passed is refused exactly as before.
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.trade{value: 100e18}(jet, true, 100e18, 1, block.timestamp - 1);
    }

    /// The trade the congestion used to kill: signed with room to spare, mined 193 seconds later.
    function testATradeSignedWithRoomSurvivesTheWorstDelayMeasured() public {
        uint256 deadline = block.timestamp + 600; // what the frontend signs once it reads the window
        vm.warp(block.timestamp + 193); // the worst quote-to-block time seen on 2026-09-20
        assertGt(launch.trade{value: 100e18}(jet, true, 100e18, 1, deadline), 0);
    }

    /// The keeper's own burn keeps the tighter window; it signs 30 s deadlines and a short ceiling
    /// is what keeps a stale keeper transaction from executing later against a moved price.
    function testKeeperBurnKeepsTheTighterDeadline() public {
        launch.fundPlatformBuyback{value: 100e18}();
        (, uint256 amount) = strategy.keeperSwapState(jet, true);
        assertGt(amount, 0);

        vm.prank(keeper);
        vm.expectRevert(ArcLaunchV2.InvalidAmount.selector);
        launch.executeBurn(jet, amount, 1, block.timestamp + 121);

        vm.prank(keeper);
        launch.executeBurn(jet, amount, 1, block.timestamp + 120);
    }

    // The opening-tick solvability test and the exact-output underflow fuzz run once per chain profile in
    // ArcLaunchV2Profiles.t.sol (Arc and a synthetic ETH-like profile).

    /// The launch metadata has only ever existed in the `Launched` event, which means anyone who
    /// wants a token's image or socials has to know this factory and decode its own event. ERC-7572
    /// puts the same URI behind a standard getter on the token itself, so an integrator needs one
    /// call and no knowledge of us. Pons, for comparison, keeps its socials in transaction calldata.
    function testTokenExposesItsLaunchMetadataUnderTheStandardGetter() public {
        string memory uri = "https://media.example/api/arc/media/0123456789abcdef.json";
        address token = _launchProject("Meta", "META", uri, 10_000, 10_000);
        assertEq(ArcToken(token).contractURI(), uri);

        // It is whatever the launch said, verbatim, and it is fixed for good.
        address blank = _launchProject("Blank", "BLNK", "", 0, 0);
        assertEq(ArcToken(blank).contractURI(), "");
    }

    /// The event stays the source the indexer already uses; the getter must agree with it exactly,
    /// or the two would tell an integrator different stories about the same token.
    function testTheGetterAndTheLaunchedEventCarryTheSameUri() public {
        string memory uri = "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
        vm.recordLogs();
        address token = _launchProject("Same", "SAME", uri, 30_000, 30_000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        string memory fromEvent;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != ArcLaunchV2.Launched.selector) continue;
            (,, fromEvent) = abi.decode(logs[i].data, (string, string, string));
        }
        assertEq(fromEvent, uri);
        assertEq(ArcToken(token).contractURI(), fromEvent);
    }
}
