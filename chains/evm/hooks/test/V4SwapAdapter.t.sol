// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HookFixture, HookTestToken} from "./HookFixture.sol";
import {HookVault} from "../HookVault.sol";
import {V4SwapAdapter} from "../adapters/V4SwapAdapter.sol";
import {HookClaim, HookPolicy, IHookFactory} from "../IHookProtocol.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

contract V4SwapAdapterTest is HookFixture {
    IPoolManager private manager;
    PoolModifyLiquidityTest private liquidity;
    V4SwapAdapter private adapter;
    PoolKey private nativePool;
    function setUp() public override {
        super.setUp();
        manager = IPoolManager(address(new PoolManager(address(this))));
        liquidity = new PoolModifyLiquidityTest(manager);
        adapter = new V4SwapAdapter(IHookFactory(address(factory)), manager);
        bytes32 operation = factory.scheduleAdapter(address(adapter));
        vm.warp(factory.readyAt(operation)); factory.executeAdapter(address(adapter));
        nativePool = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(project)), 3000, 60, IHooks(address(0)));
        manager.initialize(nativePool, uint160(1 << 96));
        project.mint(address(this), 1_000_000 ether);
        project.approve(address(liquidity), type(uint256).max);
        vm.deal(address(this), 1000 ether);
        liquidity.modifyLiquidity{value: 100 ether}(nativePool, ModifyLiquidityParams(-600, 600, 1000 ether, bytes32(0)), "");
    }
    function swapPolicy(address target, PoolKey memory key) private view returns (HookPolicy[] memory p) {
        p = new HookPolicy[](1);
        p[0] = HookPolicy(BURN, 1, target, address(adapter), 10 ether, abi.encode(key, uint160(0)), "");
    }
    function testRealNativeV4SwapAndBurnWithoutAnyWethContract() public {
        HookVault vault = create(address(0), swapPolicy(address(project), nativePool));
        fund(vault, 2 ether);
        HookClaim memory c = request(vault, BURN, 1 ether, ""); c.minimumOutput = 0.9 ether;
        execute(vault, c, "");
        assertGt(project.balanceOf(address(0xdead)), 0.9 ether);
        assertEq(address(vault).balance, 1 ether);
        assertEq(vault.accounted(), 1 ether);
        assertEq(address(adapter).balance, 0);
        assertEq(project.balanceOf(address(adapter)), 0);
    }
    function testRealErc20ToNativeSwapReceivesAndBurnsNativeOutput() public {
        HookVault vault = create(address(project), swapPolicy(address(0), nativePool));
        fund(vault, 2 ether);
        uint256 burned = address(0xdead).balance;
        HookClaim memory c = request(vault, BURN, 1 ether, ""); c.minimumOutput = 0.9 ether;
        execute(vault, c, "");
        assertGt(address(0xdead).balance - burned, 0.9 ether);
        assertEq(address(vault).balance, 0);
        assertEq(vault.accounted(), project.balanceOf(address(vault)));
        assertEq(project.allowance(address(vault), address(adapter)), 0);
    }
    function testRealSixDecimalErc20PoolUsesRawAmounts() public {
        bool quote0 = address(quote) < address(project);
        PoolKey memory key = PoolKey(Currency.wrap(quote0 ? address(quote) : address(project)),
            Currency.wrap(quote0 ? address(project) : address(quote)), 3000, 60, IHooks(address(0)));
        manager.initialize(key, uint160(1 << 96));
        quote.mint(address(this), 1_000_000e6); quote.approve(address(liquidity), type(uint256).max);
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(-600, 600, 1_000_000e6, bytes32(0)), "");
        HookVault vault = create(address(quote), swapPolicy(address(project), key)); fund(vault, 100e6);
        HookClaim memory c = request(vault, BURN, 10e6, ""); c.minimumOutput = 9e6;
        execute(vault, c, "");
        assertGt(project.balanceOf(address(0xdead)), 9e6);
        assertEq(quote.balanceOf(address(vault)), 90e6);
        assertEq(quote.allowance(address(vault), address(adapter)), 0);
    }
    function testRouteMismatchAndUnregisteredAdapterAreRejected() public {
        HookPolicy[] memory p = swapPolicy(address(quote), nativePool);
        vm.expectRevert(); create(address(0), p);
        p = swapPolicy(address(project), nativePool);
        p[0].adapter = address(new V4SwapAdapter(IHookFactory(address(factory)), manager));
        vm.expectRevert(); create(address(0), p);
    }
    function testSlippageRevertsAllBudgetAndTokenChanges() public {
        HookVault vault = create(address(0), swapPolicy(address(project), nativePool)); fund(vault, 2 ether);
        HookClaim memory c = request(vault, BURN, 1 ether, ""); c.minimumOutput = 2 ether;
        bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
        assertEq(address(vault).balance, 2 ether); assertEq(vault.accounted(), 2 ether);
        assertEq(vault.nonce(), 0); assertEq(project.balanceOf(address(0xdead)), 0);
    }
    function testAdapterRejectsOutsidersForgedCallbacksAndChangedCode() public {
        bytes memory route = abi.encode(nativePool, uint160(0));
        vm.expectRevert(); adapter.swap(address(0), address(project), 1, 1, block.timestamp + 1, route);
        vm.expectRevert(); adapter.unlockCallback("");
        vm.expectRevert(); vm.prank(address(manager)); adapter.unlockCallback("");
        HookVault vault = create(address(0), swapPolicy(address(project), nativePool)); fund(vault, 2 ether);
        vm.etch(address(adapter), hex"00");
        HookClaim memory c = request(vault, BURN, 1 ether, ""); bytes memory sig = sign(vault, c);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(c, "", sig);
    }
}
