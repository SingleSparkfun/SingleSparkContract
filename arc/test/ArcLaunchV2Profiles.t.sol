// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IFeeSplitter} from "launcher/src/interfaces/IFeeSplitter.sol";
import {ArcLaunchV2} from "../src/ArcLaunchV2.sol";
import {ArcToken} from "../src/ArcLaunch.sol";
import {ArcLaunchStrategy} from "../src/ArcLaunchStrategy.sol";
import {ArcLaunchV2Fixture} from "./ArcLaunchV2Fixture.sol";
import {ChainProfiles} from "./ChainProfiles.sol";

/// @notice Everything that depends on a chain profile's numbers, run once per profile.
abstract contract ArcLaunchV2ProfileSuite is ArcLaunchV2Fixture {
    function _profile() internal pure virtual returns (ChainProfiles.Profile memory);
    function _chainId() internal pure virtual returns (uint256);

    function setUp() public {
        vm.chainId(_chainId()); // no chain allowlist in the factory any more
        _deployWith(treasury, _profile());
    }

    function testDeployedParametersAreTheProfile() public view {
        ChainProfiles.Profile memory p = _profile();
        assertEq(strategy.HALF_SUPPLY_COST(), p.halfSupplyCost);
        assertEq(strategy.MIN_LAUNCH_TICK(), p.minLaunchTick);
        assertEq(launch.minBuyback(), p.minBuyback);
        assertEq(launch.KEEPER_GAS_TRIGGER(), p.gas.trigger);
        assertEq(launch.KEEPER_GAS_BUFFER(), p.gas.buffer);
        assertEq(launch.KEEPER_GAS_MAX_TOPUP(), p.gas.maxTopup);
        assertEq(launch.KEEPER_GAS_MIN_TOPUP(), p.gas.minTopup);
        assertEq(launch.KEEPER_GAS_DAILY_LIMIT(), p.gas.dailyLimit);
    }

    /// `initialTick` binary-searches from one spacing above MIN_LAUNCH_TICK, and `liquidityAt`
    /// divides by `sqrtPrice(tick) - sqrtPrice(MIN_LAUNCH_TICK)` — zero at the floor itself. The
    /// solver also evaluates `tick - TICK_SPACING` on its way out. Prove no fee the factory accepts
    /// can walk either of those onto the floor, so no launch can revert inside the solver.
    function testOpeningTickIsSolvableAcrossEveryAcceptedFee() public view {
        int24 spacing = strategy.TICK_SPACING();
        int24 floorTick = strategy.MIN_LAUNCH_TICK();
        uint256 target = strategy.HALF_SUPPLY_COST();
        for (uint24 fee = 0; fee <= strategy.MAX_FEE(); fee += 500) {
            int24 tick = strategy.initialTick(fee);
            assertGt(tick, floorTick); // never the tick whose liquidity divides by zero
            assertGt(tick - spacing, floorTick); // nor the one the solver reads on its way out
            assertEq(tick % spacing, 0);
            assertGt(strategy.liquidityAt(tick), 0);
            // And the curve still means what the docs say: the profile's cost buys about half the supply.
            assertApproxEqRel(strategy.costOfHalf(tick, fee), target, 0.01e18);
        }
    }

    /// The opening tax is accounted as `tax - baseTax`, and an exact-output buy derives its gross
    /// input from the tax it just computed. Both sides round up with different denominators, so the
    /// subtraction is where an underflow would hide — and an underflow here would revert the swap
    /// rather than mis-account it. Fuzz the amount and the second of the opening ladder.
    function testFuzzExactOutputBuysNeverUnderflowTheOpeningSplit(uint96 outputSeed, uint8 secondSeed) public {
        address token = _launchProject("Fuzz", "FUZZ", "", 30_000, 30_000);
        (uint256 id,,,,,,) = launch.tokens(token);
        (PoolKey memory key,) = launch.positionManager().getPoolAndPositionInfo(id);
        PoolSwapTest router = new PoolSwapTest(launch.poolManager());
        vm.warp(block.timestamp + bound(secondSeed, 0, 4)); // inside the 3 s ladder and just past it

        uint256 output = bound(outputSeed, 1, 1_000_000e18);
        address buyer = address(0xbee2);
        vm.deal(buyer, 1_000_000e18);
        vm.prank(buyer);
        // Either it goes through or it is refused deliberately; an arithmetic panic is neither.
        try router.swap{value: 1_000_000e18}(key, SwapParams(true, int256(output), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false), "") returns (BalanceDelta delta) {
            uint256 gross = uint256(-int256(delta.amount0()));
            uint256 base = (gross * 30_000 + 999_999) / 1_000_000;
            assertGe(strategy.accruedNative(token), base); // the split never owes more than it took
            assertEq(strategy.accruedOpeningNative(token), strategy.accruedNative(token) - base);
        } catch (bytes memory reason) {
            // Panic(0x11) is the arithmetic overflow/underflow selector; a revert() is fine, a panic is not.
            assertTrue(reason.length < 4 || bytes4(reason) != bytes4(0x4e487b71)
                || uint256(bytes32(_body(reason))) != 0x11);
        }
    }

    function _body(bytes memory reason) private pure returns (bytes memory out) {
        out = new bytes(32);
        for (uint256 i; i < 32; i++) out[i] = reason[i + 4];
    }

    /// A zero-fee token: spending exactly HALF_SUPPLY_COST buys about half the supply, in the chain's currency.
    function testHalfSupplyCostBuysHalfTheSupply() public {
        address token = _launchProject("Half", "HALF", "", 0, 0);
        uint256 cost = strategy.HALF_SUPPLY_COST();
        uint256 bought = launch.trade{value: cost}(token, true, cost, 1, block.timestamp + 60);
        assertApproxEqRel(bought, ArcToken(token).totalSupply() / 2, 0.01e18);
    }

    /// Deploy (setUp), launch, trade both ways, collect and split fees, keeper gas top-up, execute a burn,
    /// and the daily gas ceiling — all in the profile's own currency units.
    function testEndToEndFlowInTheProfileCurrency() public {
        ChainProfiles.Profile memory p = _profile();
        uint256 unit = p.halfSupplyCost / 10_000; // what 1 USDC is worth in this currency
        address trader = address(0x7ade);
        vm.deal(trader, 10_000 * unit);
        vm.deal(keeper, 0); // an empty keeper wallet, so collection has to pay it

        address token = _launchProject("Flow", "FLOW", "", 10_000, 50_000);
        vm.warp(block.timestamp + 3); // past the opening ladder
        vm.startPrank(trader);
        uint256 bought = launch.trade{value: 1_000 * unit}(token, true, 1_000 * unit, 1, block.timestamp + 60);
        assertGt(bought, 0);
        ArcToken(token).approve(address(launch), bought / 2);
        uint256 proceeds = launch.trade(token, false, bought / 2, 1, block.timestamp + 60);
        assertGt(proceeds, 0);
        vm.stopPrank();

        uint256 accrued = strategy.accruedNative(token);
        assertApproxEqRel(accrued, 10 * unit + (proceeds * 50_000) / 950_000, 0.001e18);
        (, uint256 pendingBefore,,,,,) = launch.tokens(token);
        uint256 creditBefore = launch.operationsCredit();
        vm.expectEmit(true, false, false, false);
        emit ArcLaunchV2.KeeperGasPaid(keeper, 0);
        (uint256 collected,) = launch.collectFees(token);
        assertEq(collected, accrued);
        (, uint256 pendingAfter,,,,,) = launch.tokens(token);
        assertEq(pendingAfter - pendingBefore, collected * 83 / 100);
        assertEq(launch.communityCredit(token), collected * 4 / 100);

        // The keeper was topped up from the platform share, bounded by the profile's per-payment ceiling.
        uint256 platformShare = collected - collected * 83 / 100 - collected * 7 / 100 - collected * 5 / 100
            - collected * 4 / 100;
        uint256 paid = keeper.balance;
        assertGe(paid, p.gas.minTopup);
        assertLe(paid, p.gas.maxTopup);
        assertEq(paid, _min(p.gas.maxTopup, creditBefore + platformShare));
        assertEq(launch.operationsCredit(), creditBefore + platformShare - paid);
        assertEq(address(launch).balance, launch.nativeAccounted());

        // A keeper burn of the collected budget, within the guarded per-call ceiling.
        (, uint256 limit) = strategy.keeperSwapState(token, true);
        uint256 amount = _min(pendingAfter, limit);
        assertGe(amount, p.minBuyback);
        uint256 supply = ArcToken(token).totalSupply();
        vm.prank(keeper);
        launch.executeBurn(token, amount, 1, block.timestamp + 120);
        assertLt(ArcToken(token).totalSupply(), supply);
        (,,,, uint256 totalBuyback, uint256 totalBurned,) = launch.tokens(token);
        assertEq(totalBuyback, amount);
        assertEq(supply - ArcToken(token).totalSupply(), totalBurned);

        // Gas top-ups stop exactly at the profile's daily limit: keeperGasPaidToday never exceeds it.
        for (uint256 i; i < 40; i++) {
            vm.deal(keeper, 0);
            launch.fundKeeperGas{value: p.gas.maxTopup}();
            assertLe(launch.keeperGasPaidToday(), p.gas.dailyLimit);
        }
        assertEq(launch.keeperGasPaidToday(), p.gas.dailyLimit);
        assertEq(launch.keeperGasAvailable(), 0);
        vm.warp(block.timestamp + 1 days);
        assertGt(launch.keeperGasAvailable(), 0); // a new day, a new allowance
        assertEq(address(launch).balance, launch.nativeAccounted());
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}

contract ArcProfileTest is ArcLaunchV2ProfileSuite {
    function _profile() internal pure override returns (ChainProfiles.Profile memory) {
        return ChainProfiles.arc();
    }

    function _chainId() internal pure override returns (uint256) {
        return 5042002;
    }

    /// The constructors refuse numbers that would break an invariant the factory and hook rely on.
    function testConstructorsRefuseInvalidProfiles() public {
        ArcLaunchV2.KeeperGas memory good = ChainProfiles.arc().gas;
        ArcLaunchV2.KeeperGas[6] memory bad;
        for (uint256 i; i < bad.length; i++) bad[i] = good;
        bad[0].minTopup = 0; // a zero payment
        bad[1].minTopup = good.maxTopup + 1; // the floor above the ceiling: never pays
        bad[2].maxTopup = good.trigger + 1; // one payment overshoots the target
        bad[2].buffer = bad[2].maxTopup;
        bad[3].dailyLimit = good.maxTopup - 1; // one payment overshoots the day
        bad[4].buffer = good.maxTopup - 1; // the reserve cannot cover one payment
        bad[5].trigger = 0; // with a non-zero ceiling above it
        for (uint256 i; i < bad.length; i++) {
            vm.expectRevert(ArcLaunchV2.InvalidConfiguration.selector);
            new ArcLaunchV2(positionManager, keeper, treasury, 5e18, bad[i]);
        }

        IFeeSplitter splitter = strategy.feeSplitter();
        // Not on the 25-tick grid.
        vm.expectRevert();
        _newStrategy(address(launch), positionManager, splitter, 10_000e18, -160_110);
        // Zero cost.
        vm.expectRevert();
        _newStrategy(address(launch), positionManager, splitter, 0, -160_100);
        // So expensive that even one spacing above the floor is cheaper: the solver would reach the floor.
        vm.expectRevert();
        _newStrategy(address(launch), positionManager, splitter, 1e36, -160_100);
        // So cheap that no tick in the search range is at or under it, even at the maximum fee.
        vm.expectRevert();
        _newStrategy(address(launch), positionManager, splitter, 1, -160_100);
        // The Arc numbers themselves are accepted.
        _newStrategy(address(launch), positionManager, splitter, 10_000e18, -160_100);
    }
}

contract EthLikeProfileTest is ArcLaunchV2ProfileSuite {
    function _profile() internal pure override returns (ChainProfiles.Profile memory) {
        return ChainProfiles.ethLike();
    }

    function _chainId() internal pure override returns (uint256) {
        return 31337;
    }

    /// The same curve in dollars: the ETH-like floor and opening tick are the Arc ones moved up by the same
    /// ~ln(k)/ln(1.0001) ticks. Measured: Arc opens at 115,125 (fee 0) and 116,200 (10%); ETH-like at 194,150
    /// and 195,225, i.e. exactly the 79,025-tick shift of the floor.
    function testOpeningTickShiftsWithTheCurrencyValue() public view {
        int24 shift = strategy.MIN_LAUNCH_TICK() - ChainProfiles.arc().minLaunchTick;
        assertEq(shift, 79_025);
        assertApproxEqAbs(int256(strategy.initialTick(0)) - shift, 115_125, 25);
        assertApproxEqAbs(int256(strategy.initialTick(strategy.MAX_FEE())) - shift, 116_200, 25);
    }
}
