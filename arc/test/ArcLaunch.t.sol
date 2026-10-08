// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArcLaunch, ArcToken} from "../src/ArcLaunch.sol";
import {ArcRewards} from "../src/ArcRewards.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {FeeSplitter} from "launcher/src/periphery/FeeSplitter.sol";
import {FeeSplit} from "launcher/src/interfaces/IFeeSplitter.sol";
import {IBeneficiaryVault} from "launcher/src/interfaces/IBeneficiaryVault.sol";
import {InstantLaunchStrategy} from "launcher/src/strategies/InstantLaunchStrategy.sol";

contract ArcLaunchTest is Test {
    ArcLaunch launch;
    PositionManager pm;
    FeeSplitter splitter;
    V4Quoter quoter;
    address token;
    address platform;
    address keeper = address(0x1234);
    address ops = address(0x5678);
    uint256 positionId;

    function setUp() public {
        vm.chainId(5042002);
        vm.warp(1000);
        vm.deal(address(this), 100_000e18);
        address deployedPositionManager = vm.envOr("ARC_TEST_POSITION_MANAGER", address(0));
        IPoolManager pool;
        if (deployedPositionManager == address(0)) {
            pool = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
            // Local fixtures pre-fund PositionManager; Permit2, NFT metadata and WETH are unused.
            pm = PositionManager(
                payable(deployCode(
                        "PositionManager.sol:PositionManager",
                        abi.encode(pool, address(0), 100_000, address(0), address(0))
                    ))
            );
        } else {
            pm = PositionManager(payable(deployedPositionManager));
            pool = pm.poolManager();
        }
        quoter = V4Quoter(deployCode("V4Quoter.sol:V4Quoter", abi.encode(pool)));
        launch = new ArcLaunch(pm, keeper, ops, 5e18);
        FeeSplit[] memory splits = new FeeSplit[](1);
        splits[0] = FeeSplit(address(launch), 10_000, 10_000, true);
        splitter = FeeSplitter(payable(deployCode("FeeSplitter.sol:FeeSplitter", abi.encode(pm, splits))));
        InstantLaunchStrategy strategy = InstantLaunchStrategy(
            payable(deployCode(
                    "InstantLaunchStrategy.sol:InstantLaunchStrategy",
                    abi.encode(address(launch), pm, pool, splitter, address(0), launch.INITIAL_TICK())
                ))
        );
        launch.configure(strategy);
        platform = launch.launch("Jet", "JET", "");
        launch.setPlatformToken(platform);
        token = launch.launch("Project", "TEST", "ipfs://example");
        (positionId,,,,,,) = launch.tokens(token);
    }

    function _quote(uint256 id, uint256 amount) private returns (uint256) {
        (IV4Quoter.QuoteExactSingleParams memory params) = _params(id, amount);
        (uint256 out,) = quoter.quoteExactInputSingle(params);
        return out;
    }

    function _params(uint256 id, uint256 amount) private view returns (IV4Quoter.QuoteExactSingleParams memory params) {
        (params.poolKey,) = pm.getPoolAndPositionInfo(id);
        params.zeroForOne = true;
        params.exactAmount = uint128(amount);
        params.hookData = "";
    }

    function testLaunchNeedsNoUsdcPrincipalAndLocksSingleSidedLiquidity() public {
        address creator = address(0x7777);
        uint256 nativeBefore = address(launch.poolManager()).balance;
        uint256 nextId = pm.nextTokenId();
        // Gas is paid by the transaction sender; the launch call itself requires no USDC principal.
        vm.deal(creator, 0);
        vm.prank(creator);
        address created = launch.launch("Single Sided", "SIDE", "");
        (uint256 id, uint256 pending, uint256 feeTokens,,,, uint256 cycles) = launch.tokens(created);
        assertEq(id, nextId);
        assertEq(pm.nextTokenId(), nextId + 1);
        assertEq(pm.ownerOf(id), address(splitter));
        assertEq(address(launch.poolManager()).balance, nativeBefore);
        assertEq(creator.balance, 0);
        assertEq(ArcToken(created).balanceOf(creator), 0);
        assertApproxEqAbs(ArcToken(created).balanceOf(address(launch.poolManager())), launch.SUPPLY(), 1e12);
        assertEq(pending, 0);
        assertEq(feeTokens, 0);
        assertEq(cycles, 0);
    }

    function testRealV4LaunchTradeCollectBurnAndIsolation() public {
        assertEq(pm.ownerOf(positionId), address(splitter));
        assertEq(ArcToken(token).totalSupply(), 1_000_000_000e18);
        assertEq(ArcToken(token).balanceOf(address(this)), 0);
        // A prior ERC20 sync in a composed transaction must not break native settlement.
        launch.poolManager().sync(Currency.wrap(token));
        uint256 purchased = launch.trade{value: 4000e18}(token, true, 4000e18, 1, block.timestamp + 120);
        assertGt(purchased, 0);
        ArcToken(token).approve(address(launch), purchased / 2);
        launch.trade(token, false, purchased / 2, 1, block.timestamp + 120);
        uint256[] memory ids = new uint256[](1);
        ids[0] = positionId;
        splitter.collectFees(ids);
        (, uint256 pending, uint256 feeTokens,,,,) = launch.tokens(token);
        (, uint256 platformPending,,,,,) = launch.tokens(platform);
        assertGt(pending, 5e18);
        assertGt(feeTokens, 0);
        assertGt(platformPending, 0);
        assertEq(address(launch).balance, pending + platformPending + launch.operationsCredit());
        uint256 supplyBefore = ArcToken(token).totalSupply();
        uint256 minOut = _quote(positionId, pending) * 95 / 100;
        vm.prank(keeper);
        launch.executeBurn(token, pending, minOut, block.timestamp + 120);
        (, uint256 remaining, uint256 remainingFees,, uint256 spent, uint256 burned, uint256 cycles) =
            launch.tokens(token);
        assertEq(remaining, 0);
        assertEq(remainingFees, 0);
        assertEq(spent, pending);
        assertEq(supplyBefore - ArcToken(token).totalSupply(), burned);
        assertGt(burned, feeTokens);
        assertEq(cycles, 1);
        assertEq(ArcToken(token).balanceOf(address(launch)), 0);
        (, uint256 untouched,,,,,) = launch.tokens(platform);
        assertEq(untouched, platformPending);
        launch.claimOperations();
        assertGt(ops.balance, 0);
        assertEq(address(launch).balance, launch.nativeAccounted());
        assertEq(pm.ownerOf(positionId), address(splitter));
    }

    function testTenThousandGrossBuysAboutHalfAndTradingContinues() public {
        uint256 nextId = pm.nextTokenId();
        uint256 input = 10_000e18;
        uint256 expected = 499_749_186_846_049_936_823_431_170;
        uint256 quote = _quote(positionId, input);
        // Check against the calibrated numerical result, not a duplicate implementation of V4 maths.
        assertApproxEqAbs(quote, expected, 1e12);
        uint256 bought = launch.trade{value: input}(token, true, input, quote, block.timestamp + 120);
        assertEq(bought, quote);
        assertApproxEqRel(bought, launch.SUPPLY() / 2, 0.00051e18);
        assertEq(ArcToken(token).balanceOf(address(this)), bought);
        assertEq(pm.ownerOf(positionId), address(splitter));
        // 50% is a pricing calibration point, not a sell-out threshold or migration trigger.
        uint256 more = launch.trade{value: 100e18}(token, true, 100e18, 1, block.timestamp + 120);
        assertGt(bought + more, launch.SUPPLY() / 2);
        assertEq(pm.ownerOf(positionId), address(splitter));
        // Passing 50% must also leave fee collection and buyback/burn enabled on the same position.
        launch.collectFees(token);
        (, uint256 pending,,,,,) = launch.tokens(token);
        uint256 supplyBefore = ArcToken(token).totalSupply();
        uint256 minOut = _quote(positionId, pending) * 95 / 100;
        vm.prank(keeper);
        launch.executeBurn(token, pending, minOut, block.timestamp + 120);
        (,,,, uint256 spent, uint256 burned, uint256 cycles) = launch.tokens(token);
        assertEq(spent, pending);
        assertGt(burned, 0);
        assertEq(supplyBefore - ArcToken(token).totalSupply(), burned);
        assertEq(cycles, 1);
        assertEq(pm.nextTokenId(), nextId);
        assertEq(pm.ownerOf(positionId), address(splitter));
        ArcToken(token).approve(address(launch), bought + more);
        uint256 returned = launch.trade(token, false, bought + more, 1, block.timestamp + 120);
        assertGt(returned, 10_000e18);
        assertLt(returned, 10_100e18);
    }

    function testSplitBuysFollowTheSameCalibratedCurve() public {
        uint256 quote = _quote(positionId, 10_000e18);
        uint256 bought;
        for (uint256 i; i < 10; i++) {
            bought += launch.trade{value: 1000e18}(token, true, 1000e18, 1, block.timestamp + 120);
        }
        assertApproxEqAbs(bought, quote, 1e12);
        assertEq(pm.ownerOf(positionId), address(splitter));
    }

    function testBoundariesAndRetryPreserveFunds() public {
        vm.expectRevert(ArcLaunch.Unauthorized.selector);
        launch.unlockCallback("");
        vm.expectRevert(ArcLaunch.Unauthorized.selector);
        launch.onAmountsReceived(positionId, 100e18, 0);
        vm.expectRevert(ArcLaunch.UnknownToken.selector);
        launch.fundFees{value: 10e18}(address(0x9999));
        (bool rawTransfer,) = address(launch).call{value: 1e18}("");
        assertFalse(rawTransfer);
        launch.fundFees{value: 100e18}(token);
        (, uint256 pending,,,,,) = launch.tokens(token);
        assertEq(pending, 90e18);
        (, uint256 platformPending,,,,,) = launch.tokens(platform);
        assertEq(platformPending, 7e18);
        assertEq(launch.operationsCredit(), 3e18);
        vm.expectRevert(ArcLaunch.Unauthorized.selector);
        launch.executeBurn(token, pending, 1, block.timestamp + 120);
        vm.prank(keeper);
        vm.expectRevert(ArcLaunch.InvalidAmount.selector);
        launch.executeBurn(token, pending - 1, 1, block.timestamp + 120);
        vm.prank(keeper);
        vm.expectRevert();
        launch.executeBurn(token, pending, type(uint256).max, block.timestamp + 120);
        (, uint256 stillPending,,,,,) = launch.tokens(token);
        assertEq(stillPending, pending);
        assertEq(address(launch).balance, 100e18);
        vm.prank(keeper);
        launch.executeBurn(token, pending, 1, block.timestamp + 120);
        launch.fundFees{value: 10e18}(token);
        vm.prank(keeper);
        vm.expectRevert(ArcLaunch.NotDue.selector);
        launch.executeBurn(token, 9e18, 1, block.timestamp + 120);
        vm.warp(block.timestamp + 180);
        vm.prank(keeper);
        launch.executeBurn(token, 9e18, 1, vm.getBlockTimestamp() + 120);
        (,,,,,, uint256 cycles) = launch.tokens(token);
        assertEq(cycles, 2);
    }

    function testTokenFeesBurnBelowNativeThresholdAndNoManualEnrollment() public {
        uint256 purchased = launch.trade{value: 10e18}(token, true, 10e18, 1, block.timestamp + 120);
        ArcToken(token).approve(address(launch), purchased);
        launch.trade(token, false, purchased, 1, block.timestamp + 120);
        uint256[] memory ids = new uint256[](1);
        ids[0] = positionId;
        splitter.collectFees(ids);
        (, uint256 pending, uint256 feeTokens,,,,) = launch.tokens(token);
        assertLt(pending, launch.minBuyback());
        assertGt(feeTokens, 0);
        uint256 supply = ArcToken(token).totalSupply();
        vm.prank(keeper);
        launch.executeBurn(token, 0, 0, block.timestamp + 120);
        assertEq(supply - ArcToken(token).totalSupply(), feeTokens);
        (, uint256 remaining,,,,,) = launch.tokens(token);
        assertEq(remaining, pending);
        InstantLaunchStrategy configured = launch.strategy();
        vm.expectRevert(ArcLaunch.Unauthorized.selector);
        launch.configure(configured);
        vm.expectRevert(ArcLaunch.Unauthorized.selector);
        launch.setPlatformToken(token);
    }

    function testPlatformBuybackSplitsAndDirectBatchPaysExactlyOnce() public {
        ArcRewards rewards = new ArcRewards(ArcToken(platform), address(launch), keeper);
        launch.setRewards(rewards);
        // Real pool trading fees, no fundFees/donations. Other project tests retain full burns.
        launch.trade{value: 4000e18}(platform, true, 4000e18, 1, block.timestamp + 120);
        launch.collectFees(platform);
        (, uint256 pending,,,,,) = launch.tokens(platform);
        uint256 supplyBefore = ArcToken(platform).totalSupply();
        uint256 walletBefore = ArcToken(platform).balanceOf(address(this));
        vm.prank(keeper);
        launch.executeBurn(platform, pending, 1, block.timestamp + 120);
        uint256 reward = rewards.available();
        (,,,,, uint256 burned,) = launch.tokens(platform);
        assertGt(reward, 1000e18);
        assertApproxEqAbs(burned, reward * 9, 9);
        assertEq(supplyBefore - ArcToken(platform).totalSupply(), burned);
        assertEq(ArcToken(platform).balanceOf(address(this)), walletBefore);
        assertEq(ArcToken(platform).balanceOf(address(rewards)), reward);

        address[] memory recipients = new address[](100);
        for (uint256 i; i < recipients.length; i++) {
            recipients[i] = address(uint160(100 + i));
        }
        vm.prank(keeper);
        rewards.distribute(0, recipients);
        assertEq(rewards.totalPaid(), 100);
        assertEq(rewards.available(), reward - 1000e18);
        for (uint256 i; i < recipients.length; i++) {
            assertEq(ArcToken(platform).balanceOf(recipients[i]), 10e18);
        }
        vm.prank(keeper);
        vm.expectRevert(ArcRewards.Invalid.selector);
        rewards.distribute(0, recipients);
        vm.expectRevert(ArcLaunch.InvalidConfiguration.selector);
        launch.setRewards(rewards);
    }

    receive() external payable {}
}
